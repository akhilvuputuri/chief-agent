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
test("lost provisioning acknowledgement reconciles one sandbox, cleans up and requires explicit resume", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  f.uncertainCreate();
  await f.c.tick();
  const j = await f.row(job.id);
  assert.equal(j.state, "paused");
  assert.equal(j.cleanup, "pending");
  await assert.rejects(
    f.c.call("a", f.run, {
      operation: "coding_resume",
      id: j.id,
      baseRevision: 1,
      requestKey: "resume",
    }),
    /cleanup/,
  );
  await f.c.tick();
  await f.c.tick();
  assert.equal(f.creates(), 1);
  assert.equal((await f.row(j.id)).cleanup, "complete");
  const r: any = await f.c.call("a", f.run, {
    operation: "coding_reply",
    id: j.id,
    baseRevision: 1,
    requestKey: "reply",
    message: "Use a synthetic regression",
    mode: "plan",
  });
  assert.equal(r.revision, 2);
  assert.equal(r.mode, "plan");
  assert.equal(
    (
      (await f.c.call("a", f.run, {
        operation: "coding_reply",
        id: j.id,
        baseRevision: 1,
        requestKey: "reply",
        message: "Use a synthetic regression",
        mode: "plan",
      })) as any
    ).revision,
    2,
  );
  await assert.rejects(
    f.c.call("a", f.run, {
      operation: "coding_resume",
      id: j.id,
      baseRevision: 1,
      requestKey: "stale",
    }),
    /scope changed/,
  );
});
test("deadline expiry keeps an explicit reason even when the worker exits before reporting", async (t) => {
  for (const terminal of [false, true]) {
    await t.test(terminal ? "already exited" : "still running", async (t) => {
      const f = await fixture(t),
        job = await f.start("deadline", "plan");
      await f.c.tick();
      const j = await f.row(job.id);
      await f.c.heartbeat(j);
      if (terminal) await f.provider.terminate(j.sandbox_id);
      f.advance(settings.limits.ms + 1);
      await f.c.tick();
      const stopped = await f.row(job.id);
      assert.equal(stopped.state, "paused");
      if (terminal) {
        assert.match(stopped.summary, /deadline has expired/);
        assert.match(stopped.summary, /stopping cause is unconfirmed/);
      } else
        assert.match(
          stopped.summary,
          /Allocated coding time expired while the sandbox was still active/,
        );
      assert.equal(f.creates(), 1);
      await assert.rejects(
        f.c.authenticate(j.id, f.c.token(j.id, j.attempt_id)),
      );
    });
  }
});
test("heartbeat expiry pauses instead of starting another worker and revokes the old capability", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  f.advance(181000);
  await f.c.tick();
  assert.equal((await f.row(j.id)).state, "paused");
  await assert.rejects(f.c.authenticate(j.id, f.c.token(j.id, j.attempt_id)));
  await f.c.tick();
  await f.c.tick();
  assert.equal(f.creates(), 1);
});
test("only verified artifact candidates publish; lost PR acknowledgement is reconciled without duplicate publication", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id),
    r = candidate();
  await assert.rejects(
    f.c.finish(j, { ...r, review: { ...r.review, patchHash: "d".repeat(64) } }),
    /exact artifact/,
  );
  await assert.rejects(f.c.finish(j, { ...r, checks: [] }), /passing checks/);
  await f.c.finish(j, r);
  assert.equal((await f.row(j.id)).state, "publishing");
  await f.c.tick();
  f.uncertainPublish();
  await assert.rejects(f.c.tick());
  assert.equal((await f.row(j.id)).cleanup, "complete");
  assert.equal((await f.row(j.id)).state, "publishing");
  await f.c.tick();
  assert.equal(f.publishes(), 1);
  assert.equal((await f.row(j.id)).state, "pr_ready");
  assert.equal((await f.row(j.id)).head_sha, "b".repeat(40));
});
test("worker HTTP routes validate capabilities and reject malformed calls without private error text", async (t) => {
  const f = await fixture(t),
    job = await f.start("plan", "plan");
  await f.c.tick();
  const j = await f.row(job.id),
    app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const path = `/coding/worker/${j.id}/assignment`,
    headers = { authorization: `Bearer ${f.c.token(j.id, j.attempt_id)}` };
  assert.equal((await app.inject({ url: path })).statusCode, 401);
  assert.equal((await app.inject({ url: path, headers })).json().baseSha, base);
  assert.equal(
    (await app.inject({ url: path, headers })).json().protocolVersion,
    1,
  );
  const bad = await app.inject({
    method: "POST",
    url: `/coding/worker/${j.id}/checkpoint`,
    headers,
    payload: {
      plan: "private text",
      files: [{ path: "../escape", content: "secret" }],
    },
  });
  assert.equal(bad.statusCode, 409);
  assert(!bad.body.includes("private text"));
  assert(!bad.body.includes("secret"));
  await assert.rejects(f.c.finish(j, candidate()), /Plan-only/);
});
test("coding continuation accepts indexed tool calls and keeps strict payload validation", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id),
    app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const calls = [0, 1].map((index) => ({
    id: `call-${index}`,
    type: "function",
    index,
    function: {
      name: "plan_read",
      arguments: JSON.stringify({
        section: index === 0 ? "plan" : "summary",
        offset: 0,
      }),
    },
  }));
  const payload = {
    callId: randomUUID(),
    role: "coder",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: calls,
        reasoning_details: [
          {
            type: "reasoning.text",
            text: "Synthetic reasoning",
            format: "synthetic",
            index: 0,
          },
        ],
      },
      ...calls.map((c) => ({
        role: "tool",
        tool_call_id: c.id,
        content: '{"text":"","nextOffset":null}',
      })),
    ],
    tools: [],
  };
  const request = {
    method: "POST" as const,
    url: `/coding/worker/${j.id}/model`,
    headers: { authorization: `Bearer ${f.c.token(j.id, j.attempt_id)}` },
    payload,
  };
  const response = await app.inject(request);
  assert.equal(response.statusCode, 200);
  assert.equal(f.modelCalls(), 1);
  const stored = (
    await f.db.query("SELECT input FROM coding_model_calls WHERE id=$1", [
      payload.callId,
    ])
  ).rows[0].input;
  assert.deepEqual(stored.messages, payload.messages);
  for (const index of [-1, 0.5, "0"]) {
    const invalid = {
      ...payload,
      callId: randomUUID(),
      messages: [
        { ...payload.messages[0], tool_calls: [{ ...calls[0], index }] },
      ],
    };
    assert.equal(
      (await app.inject({ ...request, payload: invalid })).statusCode,
      409,
    );
  }
  const invalid = {
    ...payload,
    callId: randomUUID(),
    messages: [
      {
        ...payload.messages[0],
        tool_calls: [{ ...calls[0], arbitrary: "private payload" }],
      },
    ],
  };
  const denied = await app.inject({ ...request, payload: invalid });
  assert.equal(denied.statusCode, 409);
  assert(!denied.body.includes("private payload"));
  assert.equal(f.modelCalls(), 1);
});
