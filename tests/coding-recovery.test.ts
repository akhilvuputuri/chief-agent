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
        assert.match(stopped.summary, /after its time ran out/);
        assert.match(stopped.summary, /the cause is unconfirmed/);
      } else
        assert.match(
          stopped.summary,
          /Coding time ran out while the coding box was still working/,
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
test("an active attempt whose sandbox ID was not recorded is reconciled by attempt before workers authenticate", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const launched = await f.row(job.id);
  // A restart lost the recorded identity of a launched sandbox.
  await f.db.query("UPDATE coding_jobs SET sandbox_id=NULL WHERE id=$1", [
    job.id,
  ]);
  const token = f.c.token(job.id, launched.attempt_id);
  await assert.rejects(f.c.authenticate(job.id, token));
  await f.c.tick();
  const found = await f.row(job.id);
  assert.equal(found.sandbox_id, launched.sandbox_id);
  assert.equal(found.state, "provisioning");
  assert.equal((await f.c.authenticate(job.id, token)).id, job.id);
  assert.equal(f.creates(), 1);
});
test("an active attempt whose sandbox cannot be found is paused with cleanup still pending", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  await f.db.query("UPDATE coding_jobs SET sandbox_id=NULL WHERE id=$1", [
    job.id,
  ]);
  f.provider.find = async () => undefined;
  await f.c.tick();
  const j = await f.row(job.id);
  assert.equal(j.state, "paused");
  assert.match(j.summary, /could not be identified/);
  assert.equal(j.cleanup, "pending");
  assert.equal(f.creates(), 1);
});
test("when the provider's own record proves nothing launched, cleanup settles and the queue moves on", async (t) => {
  // After an uncertain create: paused with cleanup pending, then the authoritative lookup.
  const f = await fixture(t),
    job = await f.start();
  Object.assign(f.provider, {
    authoritativeFind: true,
    find: async () => undefined,
  });
  f.uncertainCreate();
  await f.c.tick();
  assert.equal((await f.row(job.id)).cleanup, "pending");
  await f.c.tick();
  const j = await f.row(job.id);
  assert.equal(j.state, "paused");
  assert.equal(j.cleanup, "complete");
  assert.match(j.summary, /never started; resume/);
  // While an attempt is still active with no recorded sandbox, it pauses with nothing to clean.
  const g = await fixture(t),
    other = await g.start();
  await g.c.tick();
  await g.db.query("UPDATE coding_jobs SET sandbox_id=NULL WHERE id=$1", [
    other.id,
  ]);
  Object.assign(g.provider, {
    authoritativeFind: true,
    find: async () => undefined,
  });
  await g.c.tick();
  const o = await g.row(other.id);
  assert.equal(o.state, "paused");
  assert.match(o.summary, /never started/);
  assert.equal(o.cleanup, "none");
  const next = await g.start("next");
  await g.c.tick();
  assert.equal((await g.row(next.id)).state, "provisioning");
});
test("cancelling paused jobs keeps their settled cleanup, even while another attempt runs", async (t) => {
  const f = await fixture(t);
  const paused: string[] = [];
  for (const [key, cleanup] of [
    ["old-1", "complete"],
    ["old-2", "complete"],
    ["old-3", "none"],
  ]) {
    const job = await f.start(key);
    await f.db.query(
      "UPDATE coding_jobs SET state='paused',attempt_id=gen_random_uuid(),sandbox_id=$2,cleanup=$3 WHERE id=$1",
      [job.id, `fixture:${key}`, cleanup],
    );
    paused.push(job.id);
  }
  const running = await f.start("current");
  await f.c.tick();
  assert.equal((await f.row(running.id)).state, "provisioning");
  // Before the fix, the first cancel reopened cleanup and the rest hit the single-worker slot.
  for (const id of paused)
    await f.c.call("a", f.run, { operation: "coding_cancel", id });
  const rows = await Promise.all(paused.map((id) => f.row(id)));
  assert.deepEqual(
    rows.map((r) => [r.state, r.cleanup]),
    [
      ["cancelled", "complete"],
      ["cancelled", "complete"],
      ["cancelled", "none"],
    ],
  );
  // A running attempt still gets its sandbox cleaned up when cancelled.
  await f.c.call("a", f.run, { operation: "coding_cancel", id: running.id });
  assert.equal((await f.row(running.id)).cleanup, "pending");
});
test("a provider's startup grace defers heartbeat loss only until the first heartbeat", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  f.startupGrace(12 * 60_000);
  await f.c.tick();
  const j = await f.row(job.id);
  assert.equal(j.state, "provisioning");
  // A cold box: no heartbeat for minutes is not yet a lost worker.
  f.advance(10 * 60_000);
  await f.c.tick();
  assert.equal((await f.row(j.id)).state, "provisioning");
  // Once the worker has said it is alive, the normal 180 s rule applies again.
  await f.c.heartbeat(await f.row(j.id));
  assert.equal((await f.row(j.id)).state, "running");
  f.advance(181000);
  await f.c.tick();
  assert.equal((await f.row(j.id)).state, "paused");
});
test("a provisioning worker past the startup grace is paused as lost", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  f.startupGrace(12 * 60_000);
  await f.c.tick();
  f.advance(12 * 60_000 + 181000);
  await f.c.tick();
  assert.equal((await f.row(job.id)).state, "paused");
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
