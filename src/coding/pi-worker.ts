import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { z } from "zod";
import {
  CodingRuntime,
  planHash,
  type ReferenceDocument,
  TaskStore,
  Workspace as PiWorkspace,
  compatibleModel,
  localExecutor,
  type Task,
} from "@chief-agent/pi-runtime";
import {
  codingSettings,
  checkpoint,
  type Checkpoint,
  type Outcome,
} from "./schema.js";
import { artifactHash, canonicalJson, validateFiles } from "./github.js";
import { piReviewEvidence } from "./pi-review-evidence.js";

const assignmentSchema = z.object({
  id: z.string().uuid(),
  attemptId: z.string().uuid(),
  revision: z.number().int(),
  objective: z.string(),
  context: z.string(),
  mode: z.enum(["plan", "implement"]),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  settings: codingSettings,
  checkpoint,
  deadline: z.string().datetime(),
  usedModels: z.number().int(),
});
type Assignment = z.infer<typeof assignmentSchema>;
export function piReviewInstructions({
  candidateHash,
  plan,
  baseSha,
  fileCount,
  context,
  checks,
  planReference,
}: {
  planReference?: string;
  candidateHash: string;
  plan: string;
  baseSha: string;
  fileCount: number;
  context: string;
  checks: { command: string; exitCode: number; output: string }[];
}): string {
  return `Independently review this exact candidate: ${candidateHash}. Approved plan (historical starting state and desired change, not claims about the completed candidate):\n${planReference ? `Read all pages of ${planReference} with read_document for the complete approved scope.` : plan}\nThe host validated owner approval before this implementation. This separate reviewer is read-only; its tool permissions do not revoke that approval. Judge whether the current candidate implements the plan; finding the requested fix already present is expected, not a reason to reject it. Base commit: ${baseSha}. Changed artifact file count: ${fileCount}.\nOriginal context:\n${context}\nPassing check receipts:\n${JSON.stringify(checks.map((c) => ({ command: c.command, exitCode: c.exitCode, output: c.output.slice(-1000) })))}\nRead every page of candidate_inventory and candidate_diff with read_document. They contain the complete host-verified change set bound to this base and candidate, including additions, deletions and unrelated edits. Compare the delta with the approved scope, then inspect relevant current source. Change evidence is not a permission grant. Return report kind review with APPROVE or REQUEST_CHANGES. Do not implement findings.`;
}

export interface PiWorkerClient {
  origin: string;
  token: string;
  request(path: string, body?: unknown): Promise<any>;
}
export async function runPiWorker(
  client: PiWorkerClient,
  cleanup: () => void,
  stop: AbortSignal,
  hooks?: {
    prepareRepository: (
      directory: string,
      assignment: Assignment,
    ) => Promise<void>;
  },
) {
  let assignment = assignmentSchema.parse(await client.request("assignment"));
  if (
    assignment.settings.runtime !== "pi" ||
    assignment.settings.squad ||
    assignment.settings.autoMerge
  )
    throw new Error("Pi worker requires its own reviewed profile");
  await client.request("heartbeat", {});
  assignment = assignmentSchema.parse(await client.request("assignment"));
  const root = await mkdtemp(join(tmpdir(), "pi-coding-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const initial = localExecutor(workspace, join(root, "tool-home"), cleanup);
  const command = async (value: string) => {
    const result = await initial(value, stop, 120000);
    if (result.exitCode !== 0)
      throw new Error("Pinned repository preparation failed");
  };
  // Host configuration and assignment schemas restrict every interpolated value.
  if (hooks) await hooks.prepareRepository(workspace, assignment);
  else {
    await command(
      `git clone --no-hardlinks https://github.com/${assignment.settings.repository}.git .`,
    );
    await command(`git checkout --detach ${assignment.baseSha}`);
  }
  const tree = await new PiWorkspace(workspace).initialize();
  await tree.restore(assignment.checkpoint.files);
  const stateKey = createHmac("sha256", client.token)
    .update(`local:${assignment.id}:${assignment.attemptId}`)
    .digest("hex");
  const store = new TaskStore(join(root, "state"), stateKey);
  const allocationMs = Math.max(
    1,
    Date.parse(assignment.deadline) - Date.now(),
  );
  let runtime: CodingRuntime | undefined;
  const deadline = setTimeout(
    () => {
      void runtime?.cancel(currentTask);
    },
    Math.max(1, Date.parse(assignment.deadline) - Date.now()),
  );
  deadline.unref();
  let currentTask = "";
  const abort = () => {
    if (currentTask) void runtime?.cancel(currentTask);
  };
  stop.addEventListener("abort", abort, { once: true });
  const heartbeat = setInterval(() => {
    void client.request("heartbeat", {}).catch(abort);
  }, 20000);
  heartbeat.unref();
  let saved = assignment.checkpoint;
  const uploaded = new Map<string, number>();
  const scopeFor = (intent: string, hash = "") =>
    createHash("sha256")
      .update(
        canonicalJson({
          objective: assignment.objective,
          context: assignment.context,
          plan: intent === "plan" ? "" : assignment.checkpoint.plan,
          base: assignment.baseSha,
          intent,
          hash,
        }),
      )
      .digest("hex");
  async function restoreSession(task: Task, scope: string) {
    const entries: unknown[] = [];
    for (let offset = 0; ;) {
      const page = await client.request(
        `pi-session?scope=${scope}&offset=${offset}`,
      );
      entries.push(...page.entries);
      if (page.next === null) break;
      offset = page.next;
    }
    uploaded.set(scope, entries.length);
    if (entries.length) {
      const dir = join(
        store.path(task.id),
        `sessions-${task.revision}-${task.intent}`,
      );
      await mkdir(dir, { recursive: true, mode: 0o700 });
      task.sessionFile = join(dir, "restored.jsonl");
      await writeFile(
        task.sessionFile,
        entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
        { mode: 0o600 },
      );
      await store.save(task);
    }
  }
  async function uploadSession(task: Task, scope: string) {
    const dir = join(
      store.path(task.id),
      `sessions-${task.revision}-${task.intent}`,
    );
    if (!task.sessionFile) return;
    if (!task.sessionFile.startsWith(dir + "/"))
      throw new Error("Active session is outside task storage");
    const entries = (await readFile(task.sessionFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    for (
      let index = uploaded.get(scope) ?? 0;
      index < entries.length;
      index++
    ) {
      await client.request("pi-session", {
        scope,
        after: index,
        entries: [entries[index]],
      });
      uploaded.set(scope, index + 1);
    }
  }
  async function saveReview(
    task: Task,
    scope: string,
    identity: string,
    candidate: NonNullable<
      NonNullable<Checkpoint["piState"]>["reviewCandidate"]
    >,
    round: number,
  ) {
    await uploadSession(task, scope);
    const next: Checkpoint = {
      ...saved,
      piState: {
        ...saved.piState,
        version: 1,
        toolsUsed: task.used.tools,
        phase: "review",
        sessionScope: scope,
        scopeIdentity: identity,
        reviewCandidate: candidate,
        reviewRound: round,
        reportDocument: task.report ?? saved.piState?.reportDocument,
        reportFailure: task.reportFailure,
        rejectedCandidate:
          task.report?.kind === "review"
            ? task.report.verdict === "REQUEST_CHANGES"
              ? candidate.hash
              : undefined
            : saved.piState?.rejectedCandidate,
        findings:
          task.report?.kind === "review" &&
          task.report.verdict === "REQUEST_CHANGES"
            ? task.report.detail
            : saved.piState?.findings,
      },
    };
    await client.request("checkpoint", next);
    saved = next;
  }
  async function saveBuild(task: Task, working: string, scope: string) {
    await uploadSession(task, scope);
    const snap = await new PiWorkspace(working)
      .initialize()
      .then((w) => w.snapshot(initial, stop));
    const next: Checkpoint = {
      plan:
        assignment.mode === "implement"
          ? assignment.checkpoint.plan
          : (task.plan?.text ?? saved.plan),
      patch: snap.patch,
      files: snap.files,
      summary: task.summary,
      piState: {
        version: 1,
        toolsUsed: task.used.tools,
        phase: task.intent === "build" ? "build" : "plan",
        sessionScope: scope,
        scopeIdentity: scopeFor(task.intent === "build" ? "build" : "plan"),
        findings: task.intent === "plan" ? undefined : saved.piState?.findings,
        reviewRound:
          task.intent === "plan" ? undefined : saved.piState?.reviewRound,
        rejectedCandidate:
          task.intent === "plan" ? undefined : saved.piState?.rejectedCandidate,
        reportDocument:
          task.report ??
          (task.intent === "plan" ? undefined : saved.piState?.reportDocument),
        reportFailure: task.reportFailure,
      },
    };
    validateFiles(next.files);
    await client.request("checkpoint", next);
    saved = next;
  }
  function makeRuntime(
    role: "coder" | "reviewer",
    scope: string,
    working = workspace,
    reviewing = false,
    reviewCandidate?: NonNullable<Checkpoint["piState"]>["reviewCandidate"],
    reviewIdentity = "",
    reviewRound = 0,
  ) {
    const config = assignment.settings;
    return new CodingRuntime({
      store,
      model: compatibleModel({
        provider: "openrouter",
        model:
          role === "reviewer"
            ? config.reviewerModel
            : assignment.mode === "plan"
              ? (config.leaderModel ?? config.model)
              : config.model,
        baseUrl: `${workerOrigin}/coding/worker/${assignment.id}/pi/${role}/v1`,
        apiKey: workerToken,
        // Pi supplies the selected model's capacity. The request byte envelope
        // below is a separate transport bound, not an artificial model window.
        maxTokens: config.maxOutputTokens ?? 8000,
        reasoning: config.effort,
        requestIdField: "runtime_call_id",
        requestPurposeField: "runtime_purpose",
        maxRequestBytes: 179000,
      }),
      executor: (task) =>
        localExecutor(task.workspace, join(root, "tool-home"), cleanup),
      onEvent: async (task, event) => {
        if (event.type !== "tool")
          await client.request("progress", {
            key: `pi:${task.id}:${event.sequence}`,
            stage: reviewing
              ? "reviewing"
              : task.intent === "build"
                ? "implementing"
                : "planning",
            summary:
              event.type === "state"
                ? `Pi ${task.intent}: ${event.text}`
                : `Pi check: ${event.text}`,
          });
      },
      onCheckpoint: async (task) => {
        if (reviewing) {
          await saveReview(
            task,
            scope,
            reviewIdentity,
            reviewCandidate!,
            reviewRound,
          );
        } else {
          await saveBuild(task, working, scope);
        }
      },
    });
  }
  // Credentials are injected into the client boundary, never task/session records.
  const workerOrigin = (client as { origin?: string }).origin;
  const workerToken = (client as { token?: string }).token;
  if (!workerOrigin || !workerToken)
    throw new Error("Pi native provider capability missing");
  try {
    const retainedReview = assignment.checkpoint.piState?.reportDocument;
    const repairRecovery =
      assignment.mode === "implement" &&
      assignment.checkpoint.piState?.phase === "review" &&
      retainedReview?.kind === "review" &&
      retainedReview.verdict === "REQUEST_CHANGES";
    const reviewRecovery =
      assignment.mode === "implement" &&
      assignment.checkpoint.piState?.phase === "review" &&
      !repairRecovery;
    const retainedCandidate = assignment.checkpoint.piState?.reviewCandidate;
    if (
      (reviewRecovery || repairRecovery) &&
      (!retainedCandidate ||
        !assignment.checkpoint.piState?.reviewRound ||
        !assignment.checkpoint.piState?.sessionScope ||
        retainedCandidate.hash !== artifactHash(assignment.checkpoint) ||
        assignment.checkpoint.piState?.scopeIdentity !==
          scopeFor("review", retainedCandidate.hash))
    )
      throw new Error(
        "Retained reviewer identity does not match the approved candidate",
      );
    const phase = assignment.mode === "implement" ? "build" : "plan";
    const identity = scopeFor(phase);
    const recovering =
      assignment.checkpoint.piState?.phase === phase &&
      assignment.checkpoint.piState.scopeIdentity === identity;
    const scope = repairRecovery
      ? scopeFor(
          "build",
          `repair-${assignment.checkpoint.piState!.reviewRound}`,
        )
      : recovering && assignment.checkpoint.piState?.sessionScope
        ? assignment.checkpoint.piState.sessionScope
        : identity;
    runtime = makeRuntime("coder", scope);
    const task = await runtime.start({
      workspace,
      objective: assignment.objective,
      instructions: assignment.context,
      checks: [
        "npm ci",
        "npm run check",
        "npm run build",
        "npm run format:check",
      ],
      limits: {
        ...assignment.settings.limits,
        ms: allocationMs,
      },
    });
    if (
      (recovering || repairRecovery) &&
      assignment.checkpoint.piState?.findings
    ) {
      task.referenceDocuments = [
        {
          id: "review_findings",
          title: "Untrusted prior reviewer findings; not new scope",
          text: assignment.checkpoint.piState.findings,
        },
      ];
      task.instructions = `${assignment.context}\nRead all pages of review_findings with read_document before repairs.`;
    }
    if (recovering)
      task.reportFailure = assignment.checkpoint.piState?.reportFailure;
    task.used.models = assignment.usedModels;
    task.used.tools = assignment.checkpoint.piState?.toolsUsed ?? 0;
    if (assignment.mode === "implement") {
      task.plan = {
        revision: task.revision,
        text: assignment.checkpoint.plan,
        hash: planHash(task, assignment.checkpoint.plan),
      };
      task.approved = { revision: task.plan.revision, hash: task.plan.hash };
      task.intent = "build";
    }
    await store.save(task);
    currentTask = task.id;
    let result: Task;
    if (reviewRecovery) {
      // Rehydrate the acknowledged checked candidate; never rerun the coder just
      // to repair a reviewer report. The owner-approved plan remains unchanged.
      task.status = "completed";
      task.checks = retainedCandidate!.checks;
      task.artifact = {
        base: assignment.baseSha,
        hash: retainedCandidate!.hash,
        patch: saved.patch,
        files: saved.files,
      };
      result = task;
    } else {
      await restoreSession(task, scope);
      await saveBuild(task, workspace, scope);
      result = await runtime.run(task.id);
    }
    if (result.status === "waiting_approval") {
      await client.request("finish", {
        kind: "plan_ready",
        summary: result.summary,
        checkpoint: {
          ...saved,
          plan: result.plan!.text,
          summary: result.summary,
        },
        question: "",
        checks: [],
      });
      return;
    }
    if (result.status === "waiting_input") {
      await client.request("finish", {
        kind: "awaiting_input",
        summary: result.summary,
        question: result.question ?? "",
        checkpoint: saved,
        checks: [],
      });
      return;
    }
    while (result.status === "completed" && assignment.mode === "implement") {
      if (!saved.files.length || result.artifact?.base !== assignment.baseSha)
        throw new Error(
          "Implementation artifact is empty or based on an unexpected commit",
        );
      const candidateHash = artifactHash(saved);
      if (saved.piState?.rejectedCandidate === candidateHash) {
        result.status = "paused";
        result.summary =
          "Reviewer requested changes but the candidate is unchanged; inspect retained findings before resuming.";
        break;
      }
      const reviewIdentity = scopeFor("review", candidateHash);
      const restoreReview =
        saved.piState?.phase === "review" &&
        saved.piState.scopeIdentity === reviewIdentity;
      const round = restoreReview
        ? saved.piState!.reviewRound!
        : (saved.piState?.reviewRound ?? 0) + 1;
      const reviewRoot = join(root, `review-${candidateHash}-${round}`);
      await mkdir(reviewRoot);
      const reviewExec = localExecutor(
        reviewRoot,
        join(root, "tool-home"),
        cleanup,
      );
      if (hooks) await hooks.prepareRepository(reviewRoot, assignment);
      else {
        for (const value of [
          `git clone --no-hardlinks https://github.com/${assignment.settings.repository}.git .`,
          `git checkout --detach ${assignment.baseSha}`,
        ]) {
          if ((await reviewExec(value, stop, 120000)).exitCode !== 0)
            throw new Error("Review checkout preparation failed");
        }
      }
      const reviewTree = await new PiWorkspace(reviewRoot).initialize();
      await reviewTree.restore(saved.files);
      const changeEvidence = await piReviewEvidence(
        reviewTree,
        reviewExec,
        saved,
        assignment.baseSha,
        stop,
      );
      const reviewScope = restoreReview
        ? saved.piState!.sessionScope!
        : scopeFor("review-session", `${candidateHash}:${round}`);
      const checkedCandidate = {
        hash: candidateHash,
        checks: result.checks.map((c) => {
          if (c.exitCode !== 0)
            throw new Error("Review requires passing checks");
          return { ...c, exitCode: c.exitCode as 0 };
        }),
      };
      runtime = makeRuntime(
        "reviewer",
        reviewScope,
        reviewRoot,
        true,
        checkedCandidate,
        reviewIdentity,
        round,
      );
      const planReference = assignment.checkpoint.plan.length > 6000;
      const references: ReferenceDocument[] = [
        ...changeEvidence,
        ...(planReference
          ? [
              {
                id: "approved_plan",
                title:
                  "Complete approved plan (historical starting state and desired change)",
                text: assignment.checkpoint.plan,
              },
            ]
          : []),
      ];
      const review = await runtime.start({
        workspace: reviewRoot,
        objective: assignment.objective,
        instructions: piReviewInstructions({
          candidateHash,
          plan: assignment.checkpoint.plan,
          baseSha: assignment.baseSha,
          fileCount: saved.files.length,
          context: assignment.context,
          checks: result.checks,
          planReference: planReference ? "approved_plan" : undefined,
        }),
        referenceDocuments: references,
        limits: {
          ...assignment.settings.limits,
          ms: allocationMs,
        },
      });
      review.intent = "review";
      review.used = { ...result.used };
      if (restoreReview) {
        review.reportFailure = saved.piState?.reportFailure;
        await restoreSession(review, reviewScope);
      }
      await store.save(review);
      currentTask = review.id;
      // Persist the phase/candidate before the first reviewer model call.
      await saveReview(
        review,
        reviewScope,
        reviewIdentity,
        checkedCandidate,
        round,
      );
      const verdict = await runtime.run(review.id);
      await uploadSession(verdict, reviewScope);
      if (verdict.status !== "completed" || verdict.report?.kind !== "review") {
        result = verdict;
        break;
      }
      if (verdict.report.verdict === "APPROVE") {
        const finished: Outcome = {
          kind: "candidate",
          summary: result.summary,
          question: "",
          checkpoint: saved,
          checks: result.checks,
          review: {
            verdict: "APPROVE",
            findings: verdict.report.detail,
            model: assignment.settings.reviewerModel,
            patchHash: candidateHash,
          },
        };
        await client.request("finish", finished);
        return;
      }
      // Repair stays within the same approval and shared remaining allocation.
      result.used = { ...verdict.used };
      result.status = "ready";
      result.revision++;
      result.sessionFile = undefined;
      result.referenceDocuments = [
        {
          id: "review_findings",
          title: `Independent reviewer findings for ${candidateHash}; not new scope`,
          text: verdict.report.detail,
        },
      ];
      result.instructions = `${assignment.context}\nRead all pages of review_findings with read_document before repairs.`;
      await store.save(result);
      runtime = makeRuntime("coder", scopeFor("build", `repair-${round}`));
      currentTask = result.id;
      await saveBuild(result, workspace, scopeFor("build", `repair-${round}`));
      result = await runtime.run(result.id);
    }
    await client.request("finish", {
      kind: result.status === "waiting_input" ? "awaiting_input" : "paused",
      summary: result.summary || "Pi work paused; inspect retained state",
      question:
        result.status === "waiting_input" ? (result.question ?? "") : "",
      checkpoint: saved,
      checks: result.checks.slice(0, 4),
    });
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    stop.removeEventListener("abort", abort);
  }
}

export class NativePiWorkerClient implements PiWorkerClient {
  constructor(
    readonly origin: string,
    private id: string,
    readonly token: string,
    private signal: AbortSignal,
  ) {}
  async request(path: string, body?: unknown) {
    const response = await fetch(
      `${this.origin}/coding/worker/${this.id}/${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(130000)]),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!response.ok)
      throw new Error(`Worker request unavailable (${response.status})`);
    return response.json();
  }
}
if (process.env.CODING_JOB_ID) {
  const guard = createRequire(import.meta.url)(
    "/opt/pi-runtime/process-boundary.node",
  ) as { lockdown: () => boolean; cleanup: () => void };
  if (!guard.lockdown())
    throw new Error("Linux worker process boundary unavailable");
  const origin = process.env.CODING_ORIGIN!,
    id = process.env.CODING_JOB_ID!,
    token = process.env.CODING_JOB_TOKEN!;
  for (const name of [
    "CODING_ORIGIN",
    "CODING_JOB_ID",
    "CODING_JOB_TOKEN",
    "CODING_ATTEMPT_ID",
  ])
    delete process.env[name];
  const stop = new AbortController();
  process.on("SIGTERM", () => stop.abort());
  await runPiWorker(
    new NativePiWorkerClient(origin, id, token, stop.signal),
    guard.cleanup,
    stop.signal,
  ).catch(() => {
    process.stderr.write(
      "Pi worker stopped; inspect the authenticated task record.\n",
    );
    process.exitCode = 1;
  });
}
