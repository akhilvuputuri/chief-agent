import { reportDocument } from "@chief-agent/pi-runtime/report";
import { execFileSync } from "node:child_process";
import {
  runPiWorker,
  NativePiWorkerClient,
  piReviewInstructions,
} from "../../src/coding/pi-worker.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAfter, migratedPGlite } from "./pglite.js";
import { ensureUser, type Database } from "../../src/db.js";
import { requirementScope } from "../../src/coding/requirements.js";
import { CodingController } from "../../src/coding/controller.js";
import { selectCodingBackend } from "../../src/coding/backend.js";
import { squadScope } from "../../src/coding/squad-state.js";
import { ModelError, OpenRouter } from "../../src/model.js";
import { formatTelegram } from "../../src/telegram-format.js";
import {
  codingSettings,
  outcome,
  assertCodingBrief,
} from "../../src/coding/schema.js";
import { codingApi } from "../../src/coding/api.js";
import {
  GitHubPublisher,
  artifactHash,
  validateFiles,
  canonicalJson,
} from "../../src/coding/github.js";
import { SandboxAcknowledgementPending } from "../../src/coding/provider.js";
import { Workspace } from "../../src/coding/workspace.js";
import { codingLoop } from "../../src/coding/loop.js";
import {
  runWorker,
  WorkerClient,
  WorkerRequestError,
} from "../../src/coding/worker.js";
import { runtimeContext } from "../../src/runtime.js";
import type { SandboxProvider } from "../../src/coding/provider.js";
import { server } from "../../src/server.js";
import { recoverRuntime } from "../../src/execution.js";
import { Assistant } from "../../src/agent.js";
import { CustomAgent } from "../../src/custom-agent.js";
import { JobTools } from "../../src/tools.js";
export const settings = codingSettings.parse({
  repository: "akhilvuputuri/chief-agent",
  branch: "main",
  image: `ghcr.io/example/worker@sha256:${"a".repeat(64)}`,
  model: "fixture/coder",
  reviewerModel: "fixture/reviewer",
  effort: "high",
  limits: { ms: 900000, models: 40, tools: 100 },
});
export const base = "a".repeat(40);
export const candidate = () => {
  const c = {
    plan: "Fix the fixture",
    patch: "fixture diff",
    summary: "Fixture changed",
    files: [
      { path: "src/fixture.ts", content: "export const fixture = true;\n" },
    ],
  };
  return outcome.parse({
    kind: "candidate",
    summary: "Fixture complete",
    checkpoint: c,
    checks: ["check", "build", "format:check"].map((s) => ({
      command: `lockstep run ${s}`,
      exitCode: 0,
      output: "passed",
    })),
    review: {
      verdict: "APPROVE",
      findings: "Fixture reviewed",
      model: settings.reviewerModel,
      patchHash: artifactHash(c),
    },
  });
};
export async function fixture(
  t: TestContext,
  options: {
    /** Replaces the in-memory sandbox, e.g. with a real box sandbox on this database. */
    provider?: (db: Database) => SandboxProvider;
    settings?: typeof settings;
  } = {},
) {
  const pg = await migratedPGlite();
  closeAfter(t, pg);
  const db = pg as unknown as Database;
  await ensureUser(db, "a");
  await ensureUser(db, "b");
  const run = randomUUID();
  await db.query(
    "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'a','synthetic coding request')",
    [run],
  );
  let now = new Date();
  let permitted = true;
  let creates = 0,
    publishes = 0,
    modelCalls = 0,
    uncertainCreate = false,
    uncertainPublish = false,
    failModel = false;
  let stallModel = false;
  let startupGrace = 0;
  const sandboxes = new Map<
    string,
    { id: string; state: "running" | "terminal" }
  >();
  const sandboxRequests: { timeoutMinutes: number }[] = [];
  const provider = {
    create: async (r: any) => {
      creates++;
      sandboxRequests.push({ timeoutMinutes: r.timeoutMinutes });
      const id = `fixture:${r.attemptId}`;
      sandboxes.set(r.attemptId, { id, state: "running" });
      if (uncertainCreate) throw new Error("private provider error");
      return id;
    },
    find: async (attempt: string, _timeoutMinutes?: number) =>
      sandboxes.get(attempt)?.id,
    inspect: async (id: string) => {
      const s = [...sandboxes.values()].find((v) => v.id === id);
      if (!s) throw new Error("missing");
      return s.state;
    },
    terminate: async (id: string) => {
      const s = [...sandboxes.values()].find((v) => v.id === id)!;
      s.state = "terminal";
    },
    startupGraceMs: () => startupGrace,
  };
  let failModelError = new Error("private model error");
  let published = false;
  let modelReply = "fixture reply";
  let generationReply: ((model: string, input: any) => any) | undefined;
  const publisher = {
    resolve: async () => base,
    publish: async () => {
      if (!published) {
        publishes++;
        published = true;
        if (uncertainPublish) throw new Error("PR acknowledgement lost");
      }
      return {
        url: "https://github.com/example/repo/pull/1",
        head: "b".repeat(40),
      };
    },
  };
  const c = new CodingController(
    db,
    options.settings ?? settings,
    options.provider?.(db) ?? provider,
    publisher,
    "c".repeat(64),
    "https://coding.example.com",
    (u) => u === "a" && permitted,
    (selectedModel) => ({
      generate: async (input) => {
        modelCalls++;
        if (stallModel) {
          if (input.signal.aborted) throw input.signal.reason;
          await new Promise((_resolve, reject) =>
            input.signal.addEventListener(
              "abort",
              () => reject(input.signal.reason),
              { once: true },
            ),
          );
        }
        if (failModel) throw failModelError;
        return generationReply
          ? generationReply(selectedModel, input)
          : { message: { role: "assistant", content: modelReply } };
      },
    }),
    () => now,
  );
  // Most controller tests seed an already-approved implementation phase;
  // separate lifecycle tests below exercise real planning/delivery/confirmation.
  const start = async (
    key = "request",
    mode: "plan" | "implement" = "implement",
  ) => {
    const result = (await c.call("a", run, {
      operation: "coding_start",
      requestKey: key,
      objective: "Fix a synthetic bug",
      context: "Synthetic evidence",
      mode,
    })) as any;
    if (mode === "implement" && result.mode === "plan") {
      await db.query(
        "UPDATE coding_jobs SET mode='implement',checkpoint=$2::jsonb WHERE id=$1",
        [
          result.id,
          JSON.stringify({
            plan: "Fix the fixture",
            patch: "",
            summary: "",
            files: [],
          }),
        ],
      );
      const job = (
        await db.query("SELECT * FROM coding_jobs WHERE id=$1", [result.id])
      ).rows[0];
      await db.query(
        "INSERT INTO coding_events(job_id,event_key,payload,delivery) VALUES($1,'fixture-approved',$2::jsonb,'suppressed') ON CONFLICT DO NOTHING",
        [
          job.id,
          JSON.stringify({
            decision: "approved",
            approvedScope: requirementScope(job),
          }),
        ],
      );
    }
    return c.status("a", result.id);
  };
  const row = async (id: string) =>
    (await db.query("SELECT * FROM coding_jobs WHERE id=$1", [id])).rows[0];
  return {
    startupGrace: (ms: number) => {
      startupGrace = ms;
    },
    db,
    c,
    run,
    start,
    row,
    provider,
    publisher,
    creates: () => creates,
    sandboxRequests: () => sandboxRequests,
    publishes: () => publishes,
    modelCalls: () => modelCalls,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    revoke: () => {
      permitted = false;
    },
    restoreOwner: () => {
      permitted = true;
    },
    uncertainCreate: () => {
      uncertainCreate = true;
    },
    uncertainPublish: () => {
      uncertainPublish = true;
    },
    failModel: (error = new Error("private model error")) => {
      failModel = true;
      failModelError = error;
    },
    stallModel: () => {
      stallModel = true;
    },
    setGeneration: (reply: (model: string, input: any) => any) => {
      generationReply = reply;
    },
    setReply: (text: string) => {
      modelReply = text;
    },
  };
}
export async function requirementBrief(
  f: Awaited<ReturnType<typeof fixture>>,
  key = "real-plan",
  plan = "Scope: requested feature. Acceptance: synthetic tests pass.",
) {
  const job: any = await f.c.call("a", f.run, {
    operation: "coding_start",
    requestKey: key,
    objective: "Build the requested feature",
    context: "Synthetic scope",
    mode: "implement",
  });
  assert.equal(job.mode, "plan");
  await f.c.tick();
  const running = await f.row(job.id);
  await f.c.finish(running, {
    kind: "plan_ready",
    summary: "Brief prepared",
    checkpoint: {
      plan,
      patch: "",
      summary: "Brief prepared",
      files: [],
    },
  });
  await f.c.tick();
  await f.c.tick();
  let messageId = 100;
  let approvalId = "";
  let brief = "";
  await f.c.deliver(async (_user, target, text, id) => {
    assert.deepEqual(target, { kind: "topic", topic: "coding" });
    if (id) {
      approvalId = id.id;
      brief = text;
    }
    return { message_id: ++messageId };
  });
  await f.c.deliver(async (_user, target, text, id) => {
    assert.deepEqual(target, { kind: "topic", topic: "coding" });
    if (id) {
      approvalId = id.id;
      brief = text;
    }
    return { message_id: ++messageId };
  });
  assert(
    approvalId,
    JSON.stringify({
      job: await f.row(job.id),
      events: (
        await f.db.query(
          "SELECT event_key,payload,delivery FROM coding_events WHERE job_id=$1",
          [job.id],
        )
      ).rows,
    }),
  );
  assert(brief.includes(plan));
  return { jobId: job.id, approvalId, messageId, brief };
}
