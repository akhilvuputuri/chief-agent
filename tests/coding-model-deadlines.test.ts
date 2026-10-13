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
for (const runtime of ["python", "pi"])
  test(`${runtime} remaining job deadline aborts a stalled model and exposes its exact timeout category`, async (t) => {
    const f = await fixture(t);
    const job: any = await f.start("deadline-stream", "plan");
    await f.c.tick();
    const row = await f.row(job.id);
    // The fixture host clock is stable, so the remaining allocation is deterministic.
    const allocationStart = new Date(row.heartbeat_at).getTime();
    await f.db.query(
      "UPDATE coding_jobs SET attempt_deadline=$2,settings=$3::jsonb WHERE id=$1",
      [
        job.id,
        new Date(allocationStart + 100),
        JSON.stringify(
          runtime === "pi"
            ? { ...settings, runtime: "pi", squad: false, autoMerge: false }
            : { ...settings, harnessVersion: 2, squad: true },
        ),
      ],
    );
    f.stallModel();
    const current = await f.row(job.id);
    const token = (f.c as any).token(job.id, current.attempt_id);
    const app = await server({} as any);
    t.after(() => app.close());
    await codingApi(app, f.c);
    const keepAlive = setTimeout(() => {}, 2000);
    t.after(() => clearTimeout(keepAlive));
    const response = await app.inject({
      method: "POST",
      url: `/coding/worker/${job.id}/model`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        callId: randomUUID(),
        role: "leader",
        messages: [{ role: "user", content: "Synthetic task" }],
        tools: [],
      },
    });
    assert.equal(response.json().code, "model_timeout");
    const status: any = await f.c.status("a", job.id);
    assert.equal(status.lastFailure.timeoutKind, "total");
    assert.equal(status.lastFailure.phase, "model");
    assert.ok(status.lastFailure.elapsedMs >= 50);
    assert.equal((await f.row(job.id)).model_busy, false);
  });
test("empty provider answers permit a fresh generation but never replay the uncertain call", async (t) => {
  const f = await fixture(t);
  const job: any = await f.start("empty-model", "plan");
  await f.c.tick();
  await f.db.query(
    'UPDATE coding_jobs SET settings=settings || \'{"harnessVersion":2,"squad":true}\'::jsonb WHERE id=$1',
    [job.id],
  );
  const active = await f.row(job.id);
  const token = (f.c as any).token(job.id, active.attempt_id);
  f.failModel(
    new ModelError("private upstream answer", true, {
      failureCode: "empty",
      finishReason: "stop",
    }),
  );
  const app = await server({} as any);
  t.after(() => app.close());
  await codingApi(app, f.c);
  const payload = {
    callId: randomUUID(),
    role: "leader",
    messages: [{ role: "user", content: "Synthetic task" }],
    tools: [],
  };
  const request = {
    method: "POST" as const,
    url: `/coding/worker/${job.id}/model`,
    headers: { authorization: `Bearer ${token}` },
  };
  const failed = await app.inject({ ...request, payload });
  assert.equal(failed.json().code, "model_transient_failure");
  assert(!failed.body.includes("private upstream"));
  const status: any = await f.c.status("a", job.id);
  assert.equal(status.lastFailure.providerFailure, "empty");
  assert.equal((await f.row(job.id)).model_busy, false);
  const replay = await app.inject({ ...request, payload });
  assert.equal(replay.json().code, "worker_request_rejected");
  assert.equal(f.modelCalls(), 1);
  const fresh = await app.inject({
    ...request,
    payload: { ...payload, callId: randomUUID() },
  });
  assert.equal(fresh.json().code, "model_transient_failure");
  assert.equal(f.modelCalls(), 2);
  assert.equal((await f.row(job.id)).used_models, 2);
  f.failModel(
    new ModelError("private malformed response", false, {
      failureCode: "malformed",
    }),
  );
  const malformed = await app.inject({
    ...request,
    payload: { ...payload, callId: randomUUID() },
  });
  assert.equal(malformed.json().code, "model_provider_failed");
  assert.equal(
    ((await f.c.status("a", job.id)) as any).lastFailure.providerFailure,
    "malformed",
  );
});
test("new harness exposes a bounded transient model category without provider error text", async (t) => {
  const f = await fixture(t);
  const job: any = await f.start("transient-model", "plan");
  await f.c.tick();
  await f.db.query(
    'UPDATE coding_jobs SET settings=settings || \'{"harnessVersion":2,"squad":true}\'::jsonb WHERE id=$1',
    [job.id],
  );
  const active = await f.row(job.id);
  const token = (f.c as any).token(job.id, active.attempt_id);
  f.failModel(
    new ModelError("private provider error", true, { httpStatus: 429 }),
  );
  const app = await server({} as any);
  t.after(() => app.close());
  await codingApi(app, f.c);
  const callId = randomUUID();
  const response = await app.inject({
    method: "POST",
    url: `/coding/worker/${job.id}/model`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      callId,
      role: "leader",
      messages: [{ role: "user", content: "Synthetic task" }],
      tools: [],
    },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, "model_rate_limited");
  assert.ok(!response.body.includes("private provider error"));
  const status: any = await f.c.status("a", job.id);
  assert.equal(status.lastFailure.code, "model_rate_limited");
  assert.equal(status.lastFailure.callId, callId);
  assert.ok(status.lastFailure.elapsedMs >= 0);
  assert.equal((await f.row(job.id)).model_busy, false);
});
test("worker rejection status is bounded, owner-scoped and fenced to the current attempt", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id),
    app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const url = `/coding/worker/${j.id}/model`,
    payload = { private: "Bearer hidden-secret" };
  assert.equal(
    (await app.inject({ method: "POST", url, payload })).statusCode,
    401,
  );
  assert.equal((await f.c.status("a", j.id)).lastFailure, undefined);
  const rejected = await app.inject({
    method: "POST",
    url,
    payload,
    headers: { authorization: `Bearer ${f.c.token(j.id, j.attempt_id)}` },
  });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().code, "invalid_worker_payload");
  const status = await f.c.status("a", j.id);
  assert.equal(status.lastFailure.code, "invalid_worker_payload");
  assert.equal(status.lastFailure.phase, "model");
  assert.equal(status.lastFailure.httpStatus, 409);
  assert(!JSON.stringify(status).includes("hidden-secret"));
  await assert.rejects(f.c.status("b", j.id));
  await f.c.progress(j, {
    key: "request-rejected:fake",
    stage: "planning",
    summary: "Fake failure",
  });
  assert.equal(
    (await f.c.status("a", j.id)).lastFailure.code,
    "invalid_worker_payload",
  );
  const before = (
    await f.db.query(
      "SELECT count(*)::int AS n FROM coding_events WHERE payload->>'kind'='worker_request_rejected'",
    )
  ).rows[0].n;
  await f.db.query("UPDATE coding_jobs SET attempt_id=$2 WHERE id=$1", [
    j.id,
    randomUUID(),
  ]);
  await f.c.recordRejection(j, {
    phase: "model",
    code: "worker_request_rejected",
    httpStatus: 409,
  });
  assert.equal((await f.c.status("a", j.id)).lastFailure, undefined);
  const after = (
    await f.db.query(
      "SELECT count(*)::int AS n FROM coding_events WHERE payload->>'kind'='worker_request_rejected'",
    )
  ).rows[0].n;
  assert.equal(after, before);
});
test("late finish rejection remains visible for the same completed attempt", async (t) => {
  const f = await fixture(t),
    job = await f.start("late-finish", "plan");
  await f.c.tick();
  const j = await f.row(job.id),
    app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  await f.c.finish(j, {
    kind: "plan_ready",
    summary: "Synthetic ready plan",
    checkpoint: { ...j.checkpoint, plan: "Synthetic complete requirements" },
  });
  const request = {
    method: "POST" as const,
    url: `/coding/worker/${j.id}/finish`,
    headers: { authorization: `Bearer ${f.c.token(j.id, j.attempt_id)}` },
    payload: { private: "Secret must not appear" },
  };
  const rejected = await app.inject(request);
  assert.equal(rejected.statusCode, 409);
  const status = await f.c.status("a", j.id);
  assert.equal(status.state, "plan_ready");
  assert.equal(status.lastFailure.phase, "finish");
  assert.equal(status.lastFailure.code, "invalid_worker_payload");
  assert(!JSON.stringify(status).includes("Secret must not appear"));
  await f.db.query("UPDATE coding_jobs SET attempt_id=$2 WHERE id=$1", [
    j.id,
    randomUUID(),
  ]);
  assert.equal((await app.inject(request)).statusCode, 401);
  assert.equal((await f.c.status("a", j.id)).lastFailure, undefined);
});
test("provider failure is recorded without exposing provider error text", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id),
    app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  f.failModel(
    new ModelError("private provider response Bearer secret", false, {
      httpStatus: 404,
    }),
  );
  const response = await app.inject({
    method: "POST",
    url: `/coding/worker/${j.id}/model`,
    headers: { authorization: `Bearer ${f.c.token(j.id, j.attempt_id)}` },
    payload: {
      callId: randomUUID(),
      role: "coder",
      messages: [{ role: "user", content: "Synthetic" }],
      tools: [],
    },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, "model_provider_failed");
  assert.equal(
    (await f.c.status("a", j.id)).lastFailure.code,
    "model_provider_failed",
  );
  assert(!response.body.includes("secret"));
  const events = (
    await f.db.query(
      "SELECT payload FROM coding_events WHERE payload->>'kind'='worker_request_rejected'",
    )
  ).rows;
  assert(!JSON.stringify(events).includes("secret"));
  assert.equal((await f.row(j.id)).used_models, 1);
});
