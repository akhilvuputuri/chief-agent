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
import { SandboxAcknowledgementPending } from "../src/coding/provider.js";
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
test("two-hour Pi settings use a 100-minute active attempt, inside the box task's two-hour deadline", async (t) => {
  const f = await fixture(t),
    job = await f.start("pi-bounded-attempt", "plan");
  const historical = {
    ...settings,
    runtime: "pi",
    squad: false,
    autoMerge: false,
    limits: { ms: 7200000, models: 400, tools: 1000 },
  };
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    job.id,
    JSON.stringify(historical),
  ]);
  await f.c.tick();
  let current = await f.row(job.id);
  assert.equal(f.sandboxRequests()[0].timeoutMinutes, 105);
  assert.deepEqual((await f.c.assignment(current)).settings, historical);
  await f.c.heartbeat(current);
  current = await f.row(job.id);
  assert.equal(
    new Date(current.attempt_deadline).getTime() -
      new Date(current.heartbeat_at).getTime(),
    6000000,
  );
  const deadline = new Date(current.attempt_deadline).getTime();
  await f.c.heartbeat(current);
  assert.equal(
    new Date((await f.row(job.id)).attempt_deadline).getTime(),
    deadline,
  );
  assert.deepEqual((await f.c.status("a", job.id)).limits, historical.limits);
});
test("Pi output allowance is captured per job and cannot be changed by caller hints", async (t) => {
  const f = await fixture(t),
    started = await f.start("pi-output-snapshot", "plan");
  const current = {
    ...settings,
    runtime: "pi",
    squad: false,
    autoMerge: false,
    maxOutputTokens: 16000,
  };
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    started.id,
    JSON.stringify(current),
  ]);
  await f.c.tick();
  const job = await f.row(started.id);
  assert.equal((await f.c.assignment(job)).settings.maxOutputTokens, 16000);
  f.setGeneration((_model, input) => {
    assert.equal(input.maxOutputTokens, 16000);
    assert.equal(input.requireComplete, true);
    assert.equal(input.stream, true);
    assert.equal(typeof input.onProgress, "function");
    return { message: { role: "assistant", content: "Complete" } };
  });
  const app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const response = await app.inject({
    method: "POST",
    url: `/coding/worker/${job.id}/pi/coder/v1/chat/completions`,
    headers: { authorization: `Bearer ${f.c.token(job.id, job.attempt_id)}` },
    payload: {
      runtime_call_id: randomUUID(),
      model: settings.model,
      messages: [{ role: "user", content: "Fixture" }],
      tools: [],
      max_tokens: 50000,
      requireComplete: false,
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(f.modelCalls(), 1);
  assert.equal((await f.row(job.id)).settings.maxOutputTokens, 16000);
});
test("expanded coding allocations survive assignment, provisioning, status and checkpoint validation", async (t) => {
  const limits = { ms: 7200000, models: 1000, tools: 2500 };
  const expanded = codingSettings.parse({
    ...settings,
    runtime: "python",
    squad: true,
    limits,
  });
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    assert.throws(() =>
      codingSettings.parse({
        ...expanded,
        limits: { ...limits, [key]: limits[key] + 1 },
      }),
    );
  }
  const f = await fixture(t),
    job = await f.start("expanded", "plan");
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    job.id,
    JSON.stringify(expanded),
  ]);
  await f.c.tick();
  const j = await f.row(job.id);
  assert.equal(f.sandboxRequests()[0].timeoutMinutes, 125);
  assert.deepEqual((await f.c.assignment(j)).settings.limits, limits);
  await f.c.heartbeat(j);
  const live = await f.row(job.id);
  assert.equal(
    new Date(live.attempt_deadline).getTime() -
      new Date(live.heartbeat_at).getTime(),
    7200000,
  );
  assert.deepEqual((await f.c.status("a", job.id)).limits, limits);
  assert.deepEqual((await f.c.status("a"))[0].limits, limits);
  const cp = {
    ...live.checkpoint,
    squadState: {
      sequence: 1,
      revision: live.revision,
      attemptId: live.attempt_id,
      scopeHash: squadScope(live, live.checkpoint.plan),
      phase: "planning",
      candidateVersion: 0,
      candidateHash: "",
      toolsUsed: 800,
      checks: [],
      findings: "",
    },
  };
  await f.c.save(live, cp);
  assert.equal((await f.c.status("a", job.id)).squad.toolsUsed, 800);
  await assert.rejects(
    f.c.save(await f.row(job.id), {
      ...cp,
      squadState: { ...cp.squadState, sequence: 2, toolsUsed: 2501 },
    }),
  );
});
test("coding is unavailable by default and discovered through its own domain when enabled", () => {
  const off = runtimeContext({}, null).tools;
  assert(!off.some((t) => t.name.startsWith("coding_")));
  const on = runtimeContext(
    { coding: true },
    null,
    undefined,
    new Set(["coding"]),
  ).tools;
  for (const name of [
    "coding_start",
    "coding_status",
    "coding_reply",
    "coding_resume",
    "coding_cancel",
  ])
    assert(
      on.some((t) => t.name === name),
      name,
    );
});
test("dispatch is owner-scoped, foreground-only and idempotent against the original request", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  assert.equal(job.state, "queued");
  assert.equal(f.creates(), 0);
  assert.equal((await f.start()).id, job.id);
  await assert.rejects(f.c.status("b", job.id));
  await assert.rejects(
    f.c.call("a", f.run, {
      operation: "coding_start",
      requestKey: "request",
      objective: "different",
      context: "",
      mode: "implement",
    }),
    /different request/,
  );
  await f.db.query("UPDATE work_turns SET background=true WHERE run_id=$1", [
    f.run,
  ]);
  await assert.rejects(f.start("second"), /foreground/);
});
test("worker jobs survive Chief recovery; attempt capabilities cannot cross jobs or revive cancellation", async (t) => {
  const f = await fixture(t),
    job = await f.start(),
    second = await f.start("second");
  await f.c.tick();
  const j = await f.row(job.id),
    token = f.c.token(j.id, j.attempt_id);
  await recoverRuntime(f.db);
  assert.equal((await f.row(j.id)).state, "provisioning");
  assert.equal((await f.c.authenticate(j.id, token)).id, j.id);
  await assert.rejects(f.c.authenticate(second.id, token));
  await f.c.call("a", f.run, { operation: "coding_cancel", id: j.id });
  await assert.rejects(f.c.authenticate(j.id, token));
  await assert.rejects(f.c.heartbeat(j), /superseded/);
  await assert.rejects(f.c.finish(j, candidate()), /superseded/);
  await f.c.tick();
  await f.c.tick();
  assert.equal((await f.row(j.id)).cleanup, "complete");
  await f.c.tick();
  assert.equal(f.creates(), 2);
});
