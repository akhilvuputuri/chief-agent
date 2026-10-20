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
test("a reply to the exact brief confirms once; approved requirements cannot change in a worker checkpoint", async (t) => {
  const f = await fixture(t),
    r = await requirementBrief(f);
  assert.equal(
    await f.c.requirements.confirmReply("a", "a", r.messageId + 1, true),
    undefined,
  );
  assert.equal(
    (await f.c.requirements.confirmReply("a", "a", r.messageId, true))!.status,
    "approved",
  );
  await f.c.tick();
  const running = await f.row(r.jobId);
  await assert.rejects(
    f.c.save(running, {
      ...running.checkpoint,
      plan: "Silently expanded scope",
    }),
    /immutable/,
  );
  assert.equal((await f.row(r.jobId)).checkpoint.plan, running.checkpoint.plan);
  await f.c.save(running, {
    ...running.checkpoint,
    summary: "Valid implementation progress",
  });
});
test("approved implementation resumes retain the same requirements without a model-granted approval", async (t) => {
  const f = await fixture(t),
    r = await requirementBrief(f);
  await f.c.requirements.confirm("a", r.approvalId, true, "a", r.messageId);
  const scope = (await f.row(r.jobId)).context;
  await f.c.tick();
  f.advance(1200000);
  await f.c.tick();
  await f.c.tick();
  await f.c.tick();
  const paused = await f.row(r.jobId);
  assert.equal(paused.state, "paused");
  assert.equal(paused.cleanup, "complete");
  await f.c.call("a", f.run, {
    operation: "coding_resume",
    id: r.jobId,
    baseRevision: paused.revision,
    requestKey: "resume-approved",
  });
  assert.equal((await f.row(r.jobId)).context, scope);
  await f.c.tick();
  assert.equal(f.creates(), 3);
});
test("missing approval pauses a legacy implementation before provisioning and concurrent confirmation queues once", async (t) => {
  const f = await fixture(t),
    job = await f.start("unapproved", "plan");
  await f.db.query("UPDATE coding_jobs SET mode='implement' WHERE id=$1", [
    job.id,
  ]);
  await f.c.tick();
  assert.equal(f.creates(), 0);
  assert.equal((await f.row(job.id)).state, "paused");
  const r = await requirementBrief(f, "confirmed");
  const results = await Promise.allSettled([
    f.c.requirements.confirm("a", r.approvalId, true, "a", r.messageId),
    f.c.requirements.confirm("a", r.approvalId, true, "a", r.messageId),
  ]);
  assert(results.some((result) => result.status === "fulfilled"));
  assert.equal((await f.row(r.jobId)).revision, 2);
  await f.c.tick();
  assert.equal(f.creates(), 2);
});
test("decline advances the locked revision and a concurrent approve cannot overwrite it", async (t) => {
  const f = await fixture(t),
    r = await requirementBrief(f);
  const results = await Promise.allSettled([
    f.c.requirements.confirm("a", r.approvalId, false, "a", r.messageId),
    f.c.requirements.confirm("a", r.approvalId, true, "a", r.messageId),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  const current = await f.row(r.jobId);
  assert.equal(current.revision, 2);
  assert.equal(current.mode, "plan");
  assert.equal(current.state, "plan_ready");
  assert.equal(
    (
      await f.db.query(
        "SELECT payload->>'decision' AS decision FROM coding_events WHERE id=$1",
        [r.approvalId],
      )
    ).rows[0].decision,
    "revise",
  );
  await f.c.tick();
  assert.equal(f.creates(), 1);
});
test("Pi compatible model facade preserves role pins, journal replay and native framing", async (t) => {
  const f = await fixture(t);
  const started = await f.start("pi", "plan");
  await f.c.tick();
  let job = await f.row(started.id);
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    job.id,
    JSON.stringify({
      ...settings,
      runtime: "pi",
      squad: false,
      autoMerge: false,
    }),
  ]);
  job = await f.row(job.id);
  const app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const headers = {
    authorization: `Bearer ${f.c.token(job.id, job.attempt_id)}`,
  };
  const url = `/coding/worker/${job.id}/pi/coder/v1/chat/completions`;
  const payload = {
    runtime_call_id: randomUUID(),
    model: settings.model,
    messages: [
      { role: "user", content: "Synthetic request" },
      {
        role: "assistant",
        content: null,
        reasoning_content: "",
        reasoning_details: [
          {
            type: "reasoning.text",
            text: "Synthetic retained reasoning",
            format: "deepseek",
            index: 0,
          },
        ],
        tool_calls: [
          {
            id: "synthetic-read",
            type: "function",
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        content: "Synthetic source result",
        tool_call_id: "synthetic-read",
      },
    ],
    tools: [],
    stream: true,
  };
  f.setGeneration((_model, input) => {
    assert.equal(input.requireComplete, true);
    assert.equal(input.maxOutputTokens, 8000);
    assert.equal(input.messages[1].reasoning_content, "");
    assert.deepEqual(
      input.messages[1].reasoning_details,
      payload.messages[1].reasoning_details,
    );
    assert.equal(input.messages[2].tool_call_id, "synthetic-read");
    return { message: { role: "assistant", content: "fixture reply" } };
  });
  assert.equal(
    (await app.inject({ method: "POST", url, payload })).statusCode,
    401,
  );
  const response = await app.inject({ method: "POST", url, headers, payload });
  assert.equal(response.statusCode, 200);
  assert(response.body.includes("fixture reply"));
  assert(response.body.endsWith("data: [DONE]\n\n"));
  assert.equal(
    (await app.inject({ method: "POST", url, headers, payload })).statusCode,
    200,
  );
  assert.equal(f.modelCalls(), 1);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url,
        headers,
        payload: {
          ...payload,
          model: "unapproved/model",
          runtime_call_id: randomUUID(),
        },
      })
    ).statusCode,
    409,
  );
  assert.equal(f.modelCalls(), 1);
  for (const value of [42, "x".repeat(120001)]) {
    const rejected = await app.inject({
      method: "POST",
      url,
      headers,
      payload: {
        ...payload,
        runtime_call_id: randomUUID(),
        messages: [
          { role: "assistant", content: null, reasoning_content: value },
        ],
      },
    });
    assert.equal(rejected.statusCode, 409);
    assert.equal(f.modelCalls(), 1);
  }
  const unsupported = await app.inject({
    method: "POST",
    url,
    headers,
    payload: {
      ...payload,
      runtime_call_id: randomUUID(),
      messages: [
        {
          role: "assistant",
          content: null,
          unknown_compatibility_field: "unsupported",
        },
      ],
    },
  });
  assert.equal(unsupported.statusCode, 409);
  assert.equal(f.modelCalls(), 1);
});
test("Pi sessions append encrypted immutable entries and survive attempt changes", async (t) => {
  const f = await fixture(t);
  const started = await f.start("pi-session", "plan");
  await f.c.tick();
  let job = await f.row(started.id);
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    job.id,
    JSON.stringify({
      ...settings,
      runtime: "pi",
      squad: false,
      autoMerge: false,
    }),
  ]);
  job = await f.row(job.id);
  const scope = "e".repeat(64);
  const entries = [
    { type: "session", id: "synthetic" },
    {
      type: "message",
      id: "m1",
      message: { role: "user", content: "synthetic private transcript" },
    },
  ];
  await f.c.piSessionAppend(job, { scope, after: 0, entries });
  await f.c.piSessionAppend(job, { scope, after: 0, entries });
  await assert.rejects(
    f.c.piSessionAppend(job, {
      scope,
      after: 0,
      entries: [{ type: "session", id: "forged" }],
    }),
  );
  await assert.rejects(f.c.piSessionAppend(job, { scope, after: 99, entries }));
  const data = await f.db.query(
    "SELECT payload FROM coding_events WHERE job_id=$1 AND payload->>'kind'='pi_session'",
    [job.id],
  );
  assert.equal(data.rows.length, 2);
  assert(!JSON.stringify(data.rows).includes("synthetic private transcript"));
  await f.db.query("UPDATE coding_jobs SET attempt_id=$2 WHERE id=$1", [
    job.id,
    randomUUID(),
  ]);
  job = await f.row(job.id);
  const restored = await f.c.piSessionRead(job, scope, 0);
  assert.deepEqual(restored.entries, entries);
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    job.id,
    JSON.stringify(settings),
  ]);
  await assert.rejects(f.c.piSessionRead(await f.row(job.id), scope, 0));
});
