import { reviewDocumentReader } from "./helpers/pi-review-documents.js";
import { reportDocument } from "@chief-agent/pi-runtime/report";
import { execFileSync } from "node:child_process";
import {
  runPiWorker,
  NativePiWorkerClient,
  piReviewInstructions,
} from "../src/coding/pi-worker.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import {
  readFile,
  readdir,
  mkdtemp,
  mkdir,
  symlink,
  writeFile,
  rm,
  chmod,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { requirementScope } from "../src/coding/requirements.js";
import { CodingController } from "../src/coding/controller.js";
import { selectCodingBackend } from "../src/coding/backend.js";
import { squadScope } from "../src/coding/squad-state.js";
import { ModelError, OpenRouter } from "../src/model.js";
import { formatTelegram } from "../src/telegram-format.js";
import {
  codingSettings,
  outcome,
  assertCodingBrief,
} from "../src/coding/schema.js";
import { codingApi } from "../src/coding/api.js";
import {
  GitHubPublisher,
  artifactHash,
  validateFiles,
  canonicalJson,
} from "../src/coding/github.js";
import {
  CodeBuildSandbox,
  SandboxTimeoutMismatch,
  SandboxAcknowledgementPending,
} from "../src/coding/provider.js";
import { Workspace } from "../src/coding/workspace.js";
import { codingLoop } from "../src/coding/loop.js";
import {
  runWorker,
  WorkerClient,
  WorkerRequestError,
} from "../src/coding/worker.js";
import { runtimeContext } from "../src/runtime.js";
import { server } from "../src/server.js";
import { recoverRuntime } from "../src/execution.js";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
import {
  settings,
  base,
  candidate,
  fixture,
  requirementBrief,
} from "./helpers/coding-fixture.js";
test("Pi profile rejects Python selectors and automatic merge; runtime launcher stays pinned per job", async () => {
  assert(
    codingSettings.safeParse({
      ...settings,
      runtime: "pi",
      maxOutputTokens: 16000,
    }).success,
  );
  assert.equal(
    codingSettings.parse({ ...settings, runtime: "pi" }).maxOutputTokens,
    undefined,
  );
  for (const changes of [
    { maxOutputTokens: 16001 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 1.5 },
  ])
    assert(
      !codingSettings.safeParse({ ...settings, runtime: "pi", ...changes })
        .success,
    );
  assert(
    !codingSettings.safeParse({
      ...settings,
      runtime: "python",
      maxOutputTokens: 16000,
    }).success,
  );
  assert(
    codingSettings.safeParse({
      ...settings,
      runtime: "pi",
      squad: false,
      autoMerge: false,
    }).success,
  );
  for (const changes of [
    { squad: true },
    { harnessVersion: 2 },
    { autoMerge: true },
  ])
    assert(
      !codingSettings.safeParse({ ...settings, runtime: "pi", ...changes })
        .success,
    );
  const calls: any[] = [];
  const provider = new CodeBuildSandbox(
    {
      send: async (c) => {
        calls.push(c.input);
        return { build: { id: "synthetic", timeoutInMinutes: 15 } };
      },
    } as any,
    "fixed-project",
  );
  const input = {
    jobId: randomUUID(),
    attemptId: randomUUID(),
    token: "c".repeat(64),
    origin: "https://example.invalid",
    image: settings.image,
    timeoutMinutes: 15,
  };
  await provider.create({ ...input, runtime: "pi" });
  await provider.create({ ...input, runtime: "python" });
  assert(calls[0].buildspecOverride.includes("dist/coding/pi-worker.js"));
  assert(!calls[0].buildspecOverride.includes("chief_coding_runtime.worker"));
  assert(
    calls[1].buildspecOverride.includes(
      "python -I -m chief_coding_runtime.worker",
    ),
  );
});
test("a Pi default retains legacy automation support without granting it to Pi jobs", async (t) => {
  const f = await fixture(t);
  let initialized = 0;
  const pi = codingSettings.parse({
    ...settings,
    runtime: "pi",
    squad: false,
    autoMerge: false,
  });
  new CodingController(
    f.db,
    pi,
    f.provider,
    {
      ...f.publisher,
      automation: () => {
        initialized++;
        return {} as any;
      },
    },
    "c".repeat(64),
    "https://coding.example.com",
    () => true,
    () => ({
      generate: async () => ({
        message: { role: "assistant", content: "synthetic" },
      }),
    }),
    undefined,
    undefined,
    { input: 2, output: 10 },
    true,
  );
  assert.equal(initialized, 1);
  assert.equal(pi.autoMerge, false);
});
test("Pi review prompt preserves maximum approved context within runtime instructions bound", () => {
  const plan = "p".repeat(6000);
  const context = "c".repeat(16000);
  const instructions = piReviewInstructions({
    candidateHash: "a".repeat(64),
    plan,
    baseSha: base,
    fileCount: 100,
    context,
    checks: [
      "npm ci",
      "npm run check",
      "npm run build",
      "npm run format:check",
    ].map((command) => ({ command, exitCode: 0, output: "r".repeat(32000) })),
  });
  assert(
    instructions.length <= 32000,
    `Review instructions: ${instructions.length}`,
  );
  assert(instructions.includes(plan));
  assert(instructions.includes(context));
  assert(instructions.includes("Changed artifact file count: 100"));
  assert(instructions.includes(base));
  assert.equal((instructions.match(/r{1000}/g) ?? []).length, 4);
});
for (const { documentLength, terminalRecovery } of [
  ...[0, 9357, 32000, -32000].map((documentLength) => ({
    documentLength,
    terminalRecovery: false,
  })),
  { documentLength: 0, terminalRecovery: true },
])
  test(`Pi bridge complete approved workflow preserves ${documentLength || "short"}-character documents${terminalRecovery ? " with terminal HTTP recovery" : ""}`, async (t) => {
    const f = await fixture(t);
    const root = await mkdtemp(join(tmpdir(), "pi-bridge-fixture-"));
    const source = join(root, "source");
    await mkdir(source);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", source, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.name", "Synthetic");
    git("config", "user.email", "synthetic@example.invalid");
    await writeFile(
      join(source, "sum.js"),
      "export const sum = (a, b) => a - b;\n",
    );
    await writeFile(
      join(source, "test.mjs"),
      "import assert from 'node:assert/strict';import {sum} from './sum.js';assert.equal(sum(2,3),5);\n",
    );
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "synthetic-pi-workspace",
        version: "1.0.0",
        type: "module",
        scripts: {
          check: "node test.mjs",
          build: "node --check sum.js",
          "format:check": "node --check test.mjs",
        },
      }),
    );
    await writeFile(
      join(source, "package-lock.json"),
      JSON.stringify({
        name: "synthetic-pi-workspace",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "synthetic-pi-workspace", version: "1.0.0" } },
      }),
    );
    git("add", ".");
    git("commit", "-qm", "Fixture");
    const commit = git("rev-parse", "HEAD").toString().trim();
    const started = await f.start("pi-e2e", "plan");
    const profile = {
      ...settings,
      runtime: "pi",
      squad: false,
      autoMerge: false,
    };
    await f.db.query(
      "UPDATE coding_jobs SET settings=$2::jsonb,base_sha=$3 WHERE id=$1",
      [started.id, JSON.stringify(profile), commit],
    );
    const fullPlan =
      "Change sum.js subtraction to addition; preserve exported API; run check/build/format checks."
        .padEnd(
          Math.abs(documentLength) || 90,
          documentLength < 0 ? "字\n" : " Scope retained.",
        )
        .slice(0, Math.abs(documentLength) || 90);
    const fullReview =
      "The checked fixture implements addition and preserves the API."
        .padEnd(
          Math.abs(documentLength) || 62,
          documentLength < 0 ? "界\n" : " Evidence retained.",
        )
        .slice(0, Math.abs(documentLength) || 62);
    const pages = documentLength ? Math.ceil(fullPlan.length / 4000) : 0;
    const turns = new Map<string, number>();
    const reviewed = new Map<string, number>();
    const readEvidence = reviewDocumentReader();
    const recoveredPhases = new Set<string>();
    f.setGeneration((selected, input) => {
      const system =
        input.messages.find((m: any) => m.role === "system")?.content ?? "";
      const phase =
        selected === settings.reviewerModel
          ? "review"
          : system.includes("Current intent: build")
            ? system.includes("review_findings:")
              ? "repair"
              : "build"
            : "plan";
      if (terminalRecovery && !recoveredPhases.has(phase)) {
        recoveredPhases.add(phase);
        throw new ModelError("Synthetic terminal provider failure", true, {
          httpStatus: 504,
        });
      }
      const reviewKey =
        phase === "review"
          ? (system.match(/exact candidate: ([a-f0-9]{64})/)?.[1] ?? "review")
          : phase;
      if (phase === "review" && !reviewed.has(reviewKey))
        reviewed.set(reviewKey, reviewed.size + 1);
      if (phase === "review") {
        const evidence = readEvidence(input, reviewKey);
        if (evidence) return evidence;
      }
      const rawCount = turns.get(reviewKey) ?? 0;
      turns.set(reviewKey, rawCount + 1);
      const requiredPages = phase === "repair" ? pages * 2 : pages;
      const reading = phase !== "plan" && rawCount < requiredPages;
      if (phase === "build" || phase === "repair")
        assert(system.includes("host has verified owner approval"));
      const count = phase === "plan" ? rawCount : rawCount - requiredPages;
      let tool: { name: string; arguments: any } | undefined;
      if (phase === "plan" && count === 0)
        tool = { name: "read", arguments: { path: "sum.js" } };
      if (phase === "plan" && count === 1)
        tool = {
          name: "report",
          arguments: {
            kind: "plan",
            summary: "Fix addition",
            detail: fullPlan,
          },
        };
      if (phase === "build" && count === 0)
        tool = {
          name: "edit",
          arguments: {
            path: "sum.js",
            edits: [
              {
                oldText: "a - b",
                newText: documentLength === 9357 ? "(a + b) || 0" : "a + b",
              },
            ],
          },
        };
      if (phase === "repair" && count === 0)
        tool = {
          name: "edit",
          arguments: {
            path: "sum.js",
            edits: [{ oldText: "(a + b) || 0", newText: "a + b" }],
          },
        };
      if ((phase === "build" || phase === "repair") && count === 1)
        tool = {
          name: "report",
          arguments: {
            kind: "done",
            summary: "Addition fixed",
            detail: "Implemented approved behavior; actual checks follow.",
          },
        };
      if (phase === "review" && count === 0) {
        assert(system.includes("historical starting state and desired change"));
        assert(!system.includes("No implementation approved"));
        assert(system.includes("host validated owner approval"));
        assert(system.includes(commit));
        assert(
          system.includes(
            documentLength
              ? "approved_plan"
              : "Change sum.js subtraction to addition",
          ),
        );
        tool = { name: "read", arguments: { path: "sum.js" } };
      }
      if (phase === "review" && count === 1)
        tool = {
          name: "report",
          arguments: {
            kind: "review",
            summary: "Reviewed",
            detail:
              documentLength === 9357 && reviewed.get(reviewKey) === 1
                ? "Remove the || 0 fallback; preserve normal addition including NaN. ".padEnd(
                    9357,
                    "Keep complete approved scope. ",
                  )
                : fullReview,
            verdict:
              documentLength === 9357 && reviewed.get(reviewKey) === 1
                ? "REQUEST_CHANGES"
                : "APPROVE",
          },
        };
      if (reading)
        tool = {
          name: "read_document",
          arguments: {
            id:
              phase === "repair" && rawCount >= pages
                ? "review_findings"
                : "approved_plan",
            page:
              phase === "repair" && rawCount >= pages
                ? rawCount - pages
                : rawCount,
          },
        };
      if (phase !== "plan" && !reading && pages) {
        const delivered = input.messages
          .filter((m: any) => m.role === "tool")
          .map((m: any) => m.content)
          .filter(
            (c: any) =>
              typeof c === "string" && c.includes('"id":"approved_plan"'),
          )
          .map((c: any) => JSON.parse(c));
        assert.equal(
          delivered
            .slice(-pages)
            .map((d: any) => d.text)
            .join(""),
          fullPlan,
        );
      }
      return {
        message: {
          role: "assistant",
          content: tool ? null : "Finished.",
          ...(tool
            ? {
                tool_calls: [
                  {
                    id: `${phase}-${count}`,
                    type: "function",
                    function: {
                      name: tool.name,
                      arguments: JSON.stringify(tool.arguments),
                    },
                  },
                ],
              }
            : {}),
        },
      };
    });
    const app = server();
    t.after(() => app.close());
    await codingApi(app, f.c);
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const prepareRepository = async (directory: string, assignment: any) => {
      execFileSync("git", ["clone", "--no-hardlinks", source, directory], {
        stdio: "pipe",
      });
      execFileSync(
        "git",
        ["-C", directory, "checkout", "--detach", assignment.baseSha],
        { stdio: "pipe" },
      );
    };
    const run = async () => {
      const job = await f.row(started.id);
      await runPiWorker(
        new NativePiWorkerClient(
          origin,
          job.id,
          f.c.token(job.id, job.attempt_id),
          new AbortController().signal,
        ),
        () => {},
        new AbortController().signal,
        { prepareRepository },
      );
    };
    await f.c.tick();
    await run();
    assert.equal((await f.row(started.id)).state, "plan_ready");
    await f.c.tick();
    await f.c.tick();
    let receipt = 100;
    let approvalId = "";
    let approvedMessage = 0;
    for (let i = 0; i < 10 && !approvalId; i++)
      await f.c.deliver(async (_owner, _target, text, id, document) => {
        const message_id = ++receipt;
        if (id) {
          assert(document?.content.includes(fullPlan));
          assert.equal(formatTelegram(text, 1024).length, 1);
          assert(document?.content.includes("Original request"));
          approvalId = id;
          approvedMessage = message_id;
        }
        return { message_id };
      });
    assert(approvalId);
    await f.c.requirements.confirm("a", approvalId, true, "a", approvedMessage);
    await f.c.tick();
    await run();
    const result = await f.row(started.id);
    assert.equal(result.state, "publishing");
    assert.equal(result.result.review.verdict, "APPROVE");
    assert.equal(result.checkpoint.plan, fullPlan);
    assert.equal(result.result.review.findings, fullReview);
    assert.equal(result.checkpoint.piState.reportDocument.detail, fullReview);
    assert.equal(result.checkpoint.piState.reportDocument.version, 1);
    assert.equal(
      result.checkpoint.piState.reviewRound,
      documentLength === 9357 ? 2 : 1,
    );
    if (documentLength === 9357)
      assert(!result.checkpoint.files[0].content.includes("|| 0"));
    assert(result.result.checks.every((c: any) => c.exitCode === 0));
    assert(
      result.checkpoint.files.some(
        (c: any) => c.path === "sum.js" && c.content.includes("a + b"),
      ),
    );
    await f.c.tick();
    await f.c.tick();
    assert.equal((await f.row(started.id)).state, "pr_ready");
    assert.equal(f.publishes(), 1);
    if (terminalRecovery) {
      assert.deepEqual([...recoveredPhases].sort(), [
        "build",
        "plan",
        "review",
      ]);
      const calls = (
        await f.db.query(
          "SELECT id,attempt_id,role,state,input FROM coding_model_calls WHERE job_id=$1",
          [started.id],
        )
      ).rows;
      const children = calls.filter((call) => call.input.retryOf);
      assert.equal(children.length, 3);
      for (const child of children) {
        const parent = calls.find((call) => call.id === child.input.retryOf);
        assert.equal(parent.state, "uncertain");
        assert.equal(child.state, "complete");
        assert.equal(child.attempt_id, parent.attempt_id);
        assert.equal(child.role, parent.role);
      }
      assert.equal(
        result.used_models,
        calls.filter((call) => call.attempt_id === result.attempt_id).length,
      );
      assert.equal(
        turns.get("build"),
        2,
        "One edit response and one done response; no tool-loop replay",
      );
    }
  });
test("replacement Pi worker retains acknowledged history across a new sandbox path", async (t) => {
  const f = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), "pi-worker-recovery-"));
  const source = join(root, "source");
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "synthetic@example.invalid");
  await writeFile(
    join(source, "marker.txt"),
    "First-worker observation: synthetic uncertain-action marker.\n",
  );
  git("add", ".");
  git("commit", "-qm", "Fixture");
  const baseSha = git("rev-parse", "HEAD").toString().trim();
  const started = await f.start("pi-replacement", "plan");
  await f.db.query(
    "UPDATE coding_jobs SET settings=$2::jsonb,base_sha=$3 WHERE id=$1",
    [
      started.id,
      JSON.stringify({
        ...settings,
        runtime: "pi",
        squad: false,
        autoMerge: false,
      }),
      baseSha,
    ],
  );
  let turn = 0;
  f.setGeneration(() => {
    if (turn++ === 0)
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "read-marker",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({ path: "marker.txt" }),
              },
            },
          ],
        },
      };
    throw new Error("Synthetic interrupted generation");
  });
  const app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const directories: string[] = [];
  const prepareRepository = async (directory: string, assignment: any) => {
    directories.push(directory);
    execFileSync("git", ["clone", "--no-hardlinks", source, directory], {
      stdio: "pipe",
    });
    execFileSync(
      "git",
      ["-C", directory, "checkout", "--detach", assignment.baseSha],
      { stdio: "pipe" },
    );
  };
  const run = async () => {
    const job = await f.row(started.id);
    await runPiWorker(
      new NativePiWorkerClient(
        origin,
        job.id,
        f.c.token(job.id, job.attempt_id),
        new AbortController().signal,
      ),
      () => {},
      new AbortController().signal,
      { prepareRepository },
    );
  };
  await f.c.tick();
  await run();
  assert.equal((await f.row(started.id)).state, "paused");
  await f.c.tick();
  await f.c.tick();
  const paused = await f.row(started.id);
  await f.c.call("a", f.run, {
    operation: "coding_resume",
    id: paused.id,
    baseRevision: paused.revision,
    requestKey: "explicit-recovery",
  });
  let recovered = false;
  let second = 0;
  f.setGeneration((_model, input) => {
    recovered ||= JSON.stringify(input.messages).includes(
      "First-worker observation: synthetic uncertain-action marker",
    );
    return second++ === 0
      ? {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "report-recovered",
                type: "function",
                function: {
                  name: "report",
                  arguments: JSON.stringify({
                    kind: "plan",
                    summary: "Recovered inspection",
                    detail:
                      "Preserve the observed marker and implement only the requested scope after approval.",
                  }),
                },
              },
            ],
          },
        }
      : { message: { role: "assistant", content: "Finished." } };
  });
  await f.c.tick();
  await run();
  assert.equal((await f.row(started.id)).state, "plan_ready");
  assert(recovered);
  assert.notEqual(directories[0], directories[1]);
  const entries = await f.db.query(
    "SELECT payload->>'index' AS index FROM coding_events WHERE job_id=$1 AND payload->>'kind'='pi_session'",
    [started.id],
  );
  assert(entries.rows.length > 5);
});
test("bundled Pi cutover snapshots new jobs while duplicate legacy requests and rollback retain their backends", async (t) => {
  const f = await fixture(t);
  const config = async (name: string) =>
    JSON.parse(
      await readFile(
        new URL(`../config/${name}.json`, import.meta.url),
        "utf8",
      ),
    );
  const legacy = await config("coding"),
    pi = await config("coding-pi");
  const selected = selectCodingBackend(
    await config("coding-backend"),
    legacy,
    pi,
  );
  assert.equal(selected.runtime, "pi");
  const controller = (profile: typeof settings) =>
    new CodingController(
      f.db,
      profile,
      f.provider,
      f.publisher,
      "c".repeat(64),
      "https://coding.example.com",
      (user) => user === "a",
      () => {
        throw new Error("This routing test must not make model calls");
      },
    );
  const prior = controller(
    selectCodingBackend({ default: "legacy" }, legacy, pi),
  );
  const current = controller(selected);
  const start = (c: CodingController, requestKey: string) =>
    c.call("a", f.run, {
      operation: "coding_start",
      requestKey,
      objective: "Inspect a synthetic bug",
      context: "Synthetic evidence",
      mode: "plan",
    }) as Promise<any>;
  const old = await start(prior, "before-cutover");
  const saved = (await f.row(old.id)).settings;
  const retried = await start(current, "before-cutover");
  assert.equal(retried.id, old.id);
  assert.deepEqual((await f.row(old.id)).settings, saved);
  assert.equal(saved.runtime, "python");
  assert.equal(saved.image, legacy.image);
  const fresh = await start(current, "after-cutover");
  const record = await f.row(fresh.id);
  assert.equal(record.settings.runtime, "pi");
  assert.equal(record.settings.image, pi.image);
  assert.equal(record.settings.autoMerge, false);
  assert.deepEqual(record.settings.limits, { ...saved.limits, ms: 2400000 });
  assert.equal(record.mode, "plan");
  assert.equal(f.creates(), 0);
  const rolledBack = await start(prior, "after-rollback");
  assert.equal((await f.row(rolledBack.id)).settings.runtime, "python");
  assert.deepEqual((await f.row(fresh.id)).settings, record.settings);
  await current.call("a", f.run, { operation: "coding_cancel", id: old.id });
  assert.equal((await f.row(old.id)).state, "cancelled");
  assert.deepEqual((await f.row(old.id)).settings, saved);
});
