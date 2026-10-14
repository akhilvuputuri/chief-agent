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
test("model calls are counted once, persist evidence and never replay an uncertain request", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  const input = {
    callId: randomUUID(),
    role: "coder" as const,
    messages: [{ role: "user" as const, content: "Synthetic request" }],
    tools: [],
  };
  await f.c.generate(j, input);
  await f.c.generate(j, input);
  assert.equal(f.modelCalls(), 1);
  assert.equal((await f.row(j.id)).used_models, 1);
  f.failModel();
  const failed = { ...input, callId: randomUUID() };
  await assert.rejects(f.c.generate(j, failed));
  await assert.rejects(f.c.generate(j, failed), /uncertain/);
  assert.equal(f.modelCalls(), 2);
  const records = (
    await f.db.query("SELECT state FROM coding_model_calls ORDER BY created_at")
  ).rows;
  assert.deepEqual(
    records.map((r) => r.state),
    ["complete", "uncertain"],
  );
});
test("progress duplicates do not rewrite later state and uncertain Telegram deliveries stay inspectable", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  const first = { key: "first", stage: "planning", summary: "Planning" };
  await f.c.progress(j, first);
  await f.c.progress(j, {
    key: "second",
    stage: "verifying",
    summary: "Verifying",
  });
  await f.c.progress(j, first);
  assert.equal((await f.row(j.id)).stage, "verifying");
  await assert.rejects(
    f.c.progress(j, { ...first, summary: "different" }),
    /conflict/,
  );
  await f.c.deliver(async () => {
    throw new Error("delivery uncertain");
  });
  const events = (
    await f.db.query("SELECT delivery FROM coding_events ORDER BY created_at")
  ).rows;
  assert.equal(events.filter((e) => e.delivery === "uncertain").length, 1);
  await f.db.query(
    "UPDATE coding_events SET delivery='sending' WHERE delivery='pending'",
  );
  await f.c.recoverDelivery();
  assert(
    (await f.db.query("SELECT 1 FROM coding_events WHERE delivery='pending'"))
      .rows.length === 0,
  );
});
test("the CodeBuild request uses a trusted worker image and fixed buildspec, no project source or logs", async () => {
  const commands: any[] = [];
  const p = new CodeBuildSandbox(
    {
      send: async (command: any) => {
        commands.push(command);
        return { build: { id: "fixture:one", timeoutInMinutes: 20 } };
      },
    } as any,
    "fixture-project",
  );
  await p.create({
    jobId: randomUUID(),
    attemptId: randomUUID(),
    token: "a".repeat(64),
    origin: "https://fixture.example",
    image: settings.image,
    timeoutMinutes: 20,
  });
  const req = commands[0].input;
  assert.equal(req.sourceTypeOverride, "NO_SOURCE");
  assert.equal(req.privilegedModeOverride, false);
  assert.equal(req.autoRetryLimitOverride, 0);
  assert.equal(req.imageOverride, settings.image);
  assert(req.buildspecOverride.includes("--reuid=1000"));
  assert(!req.buildspecOverride.includes("npm"));
  assert.equal(req.logsConfigOverride.cloudWatchLogs.status, "DISABLED");
});
test("timeout rejection atomically pauses dispatch and retains the sandbox for cleanup without relaunch", async (t) => {
  const f = await fixture(t),
    job = await f.start("timeout-rejected", "plan");
  let launches = 0,
    stopped = 0;
  f.provider.create = async () => {
    launches++;
    throw new SandboxTimeoutMismatch("fixture:short", 125, 45);
  };
  f.provider.inspect = async () => (stopped ? "terminal" : "running");
  f.provider.terminate = async (id) => {
    assert.equal(id, "fixture:short");
    stopped++;
  };
  await f.c.tick();
  const rejected = await f.row(job.id);
  assert.equal(rejected.state, "paused");
  assert.equal(rejected.sandbox_id, "fixture:short");
  assert.equal(rejected.cleanup, "pending");
  assert.match(rejected.summary, /accepted 45 minutes/);
  await assert.rejects(
    f.c.authenticate(job.id, f.c.token(job.id, rejected.attempt_id)),
    /Invalid worker capability/,
  );
  await f.c.tick();
  await f.c.tick();
  assert.equal((await f.row(job.id)).cleanup, "complete");
  assert.equal(launches, 1);
  assert.equal(stopped, 1);
  assert.equal(f.modelCalls(), 0);
});
test("worker dispatch waits for confirmed sandbox acknowledgement", async (t) => {
  const f = await fixture(t),
    job = await f.start("pending-timeout-receipt", "plan");
  const create = f.provider.create;
  let release!: () => void;
  const receipt = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.provider.create = async (r) => {
    const id = await create(r);
    await receipt;
    return id;
  };
  const dispatch = f.c.tick();
  let launching;
  for (let i = 0; i < 20; i++) {
    launching = await f.row(job.id);
    if (launching.state === "provisioning") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(launching.state, "provisioning");
  assert.equal(launching.sandbox_id, null);
  try {
    await assert.rejects(
      f.c.authenticate(job.id, f.c.token(job.id, launching.attempt_id)),
      SandboxAcknowledgementPending,
    );
    assert.equal(f.modelCalls(), 0);
  } finally {
    release();
    await dispatch;
  }
  const acknowledged = await f.row(job.id);
  assert(acknowledged.sandbox_id);
  await f.c.authenticate(job.id, f.c.token(job.id, acknowledged.attempt_id));
});
test("immutable Node and Pi workers receive a delayed valid launch assignment without premature work", async (t) => {
  for (const runtime of ["node", "pi"] as const) {
    await t.test(runtime, async (t) => {
      const f = await fixture(t),
        job = await f.start(`delayed-${runtime}-receipt`, "plan");
      const create = f.provider.create;
      let release!: () => void;
      const receipt = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.provider.create = async (r) => {
        await receipt;
        return create(r);
      };
      const dispatch = f.c.tick();
      let launching;
      for (let i = 0; i < 30; i++) {
        launching = await f.row(job.id);
        if (launching.state === "provisioning") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const token = f.c.token(job.id, launching.attempt_id),
        app = server();
      t.after(() => app.close());
      await codingApi(app, f.c);
      const prematureFinish = await app.inject({
        method: "POST",
        url: `/coding/worker/${job.id}/finish`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      assert.equal(prematureFinish.statusCode, 503);
      const invalid = await app.inject({
        method: "GET",
        url: `/coding/worker/${job.id}/assignment`,
        headers: { authorization: `Bearer ${"d".repeat(64)}` },
      });
      assert.equal(invalid.statusCode, 401);
      const authenticate = f.c.authenticate.bind(f.c);
      let pendingReads = 0;
      f.c.authenticate = async (...args) => {
        try {
          return await authenticate(...args);
        } catch (error) {
          if (error instanceof SandboxAcknowledgementPending) {
            pendingReads++;
            release();
            await dispatch;
          }
          throw error;
        }
      };
      let requests = 0;
      const transport: typeof fetch = async (url, options) => {
        requests++;
        const reply = await app.inject({
          method: options?.method as any,
          url: new URL(String(url)).pathname,
          headers: options?.headers as any,
          payload: options?.body as string | undefined,
        });
        return new Response(reply.body, { status: reply.statusCode });
      };
      const originalFetch = globalThis.fetch;
      const signal = AbortSignal.timeout(10000);
      const client =
        runtime === "pi"
          ? new NativePiWorkerClient(
              "https://coding.example.com",
              job.id,
              token,
              signal,
            )
          : new WorkerClient(
              "https://coding.example.com",
              job.id,
              token,
              signal,
              transport,
            );
      if (runtime === "pi") globalThis.fetch = transport;
      try {
        assert.equal((await client.request("assignment")).id, job.id);
      } finally {
        globalThis.fetch = originalFetch;
        release();
        await dispatch;
      }
      assert.equal(pendingReads, 1);
      assert.equal(requests, 1);
      assert.equal(f.modelCalls(), 0);
    });
  }
});
