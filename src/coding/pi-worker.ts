import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { z } from "zod";
import {
  CodingRuntime,
  planHash,
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
          plan: assignment.checkpoint.plan,
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
      await writeFile(
        join(dir, "restored.jsonl"),
        entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
        { mode: 0o600 },
      );
    }
  }
  async function uploadSession(task: Task, scope: string) {
    const dir = join(
      store.path(task.id),
      `sessions-${task.revision}-${task.intent}`,
    );
    const names = await readdir(dir).catch(() => []);
    const name = names.find((n) => n.endsWith(".jsonl"));
    if (!name) return;
    const entries = (await readFile(join(dir, name), "utf8"))
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
  function makeRuntime(
    role: "coder" | "reviewer",
    scope: string,
    working = workspace,
    reviewing = false,
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
        contextWindow: 40000,
        maxTokens: 8000,
        reasoning: config.effort,
        requestIdField: "runtime_call_id",
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
        await uploadSession(task, scope);
        if (reviewing) {
          const next = {
            ...saved,
            piState: { version: 1 as const, toolsUsed: task.used.tools },
          };
          await client.request("checkpoint", next);
          saved = next;
        } else {
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
            piState: { version: 1, toolsUsed: task.used.tools },
          };
          validateFiles(next.files);
          await client.request("checkpoint", next);
          saved = next;
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
    const scope = scopeFor(assignment.mode === "implement" ? "build" : "plan");
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
    await restoreSession(task, scope);
    let result = await runtime.run(task.id);
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
      const reviewRoot = join(root, `review-${candidateHash}`);
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
      await new PiWorkspace(reviewRoot)
        .initialize()
        .then((w) => w.restore(saved.files));
      const reviewScope = scopeFor("review", candidateHash);
      runtime = makeRuntime("reviewer", reviewScope, reviewRoot, true);
      const review = await runtime.start({
        workspace: reviewRoot,
        objective: assignment.objective,
        instructions: `Independently review this exact candidate: ${candidateHash}. Complete approved requirements:\n${assignment.checkpoint.plan}\nOriginal context:\n${assignment.context}\nPassing check receipts:\n${JSON.stringify(result.checks.map((c) => ({ command: c.command, exitCode: c.exitCode, output: c.output.slice(-1000) })))}\nInspect actual source. Return report kind review with APPROVE or REQUEST_CHANGES. Do not implement findings.`,
        limits: {
          ...assignment.settings.limits,
          ms: allocationMs,
        },
      });
      review.intent = "review";
      review.used = { ...result.used };
      await store.save(review);
      currentTask = review.id;
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
      result.instructions = `${assignment.context}\nIndependent reviewer findings for ${candidateHash}:\n${verdict.report.detail}`;
      await store.save(result);
      runtime = makeRuntime(
        "coder",
        scopeFor("build", `repair-${result.revision}`),
      );
      currentTask = result.id;
      result = await runtime.run(result.id);
    }
    await client.request("finish", {
      kind: "paused",
      summary: result.summary || "Pi work paused; inspect retained state",
      question: "",
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
