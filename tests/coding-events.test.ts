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
test("a brief controller outage retries the same safe callback; revoked capabilities fail immediately", async () => {
  let calls = 0;
  const client = new WorkerClient(
    "https://coding.example.com",
    randomUUID(),
    "a".repeat(64),
    new AbortController().signal,
    (async () => {
      calls++;
      return calls === 1
        ? new Response("unavailable", { status: 503 })
        : new Response('{"accepted":true}', { status: 200 });
    }) as any,
  );
  assert.deepEqual(await client.request("heartbeat", {}), { accepted: true });
  assert.equal(calls, 2);
  const denied = new WorkerClient(
    "https://coding.example.com",
    randomUUID(),
    "a".repeat(64),
    new AbortController().signal,
    (async () => new Response("denied", { status: 401 })) as any,
  );
  await assert.rejects(
    denied.request("heartbeat", {}),
    (e) => e instanceof WorkerRequestError && e.status === 401,
  );
});
test("Chief dispatch returns to the conversation and worker delivery preserves the originating thread", async (t) => {
  const f = await fixture(t);
  let modelCalls = 0;
  const assistant = new Assistant(
    f.db,
    new CustomAgent({
      model: "fixture/chief",
      generate: async (input) => {
        modelCalls++;
        if (modelCalls === 1) {
          assert(input.tools.some((t) => t.name === "coding_start"));
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "dispatch",
                  type: "function",
                  function: {
                    name: "coding_start",
                    arguments: JSON.stringify({
                      requestKey: "chief-dispatch",
                      objective: "Plan a synthetic bug fix",
                      mode: "plan",
                    }),
                  },
                },
              ],
            },
          };
        }
        return {
          message: {
            role: "assistant",
            content: "The coding job is queued. I will collect its updates.",
          },
        };
      },
    }),
    new JobTools(
      f.db,
      { call: async () => ({}) },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      f.c,
    ),
    { coding: true },
  );
  const response = await assistant.respondDetailed(
    "a",
    "Use the coding sandbox to plan this bug fix",
    undefined,
    undefined,
    { threadId: 17 },
  );
  assert.match(response.reply, /queued/);
  assert.equal(f.creates(), 0);
  const job = (
    await f.db.query(
      "SELECT * FROM coding_jobs WHERE request_key='chief-dispatch'",
    )
  ).rows[0];
  assert.equal(Number(job.thread_id), 17);
  await f.c.tick();
  const j = await f.row(job.id);
  await f.c.progress(j, {
    key: "planning",
    stage: "planning",
    summary: "Inspecting the fixture",
  });
  let target: unknown;
  await f.c.deliver(async (user, destination) => {
    assert.equal(user, "a");
    target = destination;
  });
  assert.deepEqual(target, { kind: "topic", topic: "coding" });
});
test("revocation preserves the publication fence until a lost PR acknowledgement is reconciled", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  await f.c.finish(j, candidate());
  await f.c.tick();
  f.uncertainPublish();
  await assert.rejects(f.c.tick());
  f.revoke();
  await f.c.tick();
  f.restoreOwner();
  const saved = await f.row(job.id);
  assert.equal(saved.state, "paused");
  assert.equal(saved.publication_started, true);
  assert.equal(saved.pr_url, null);
  await assert.rejects(
    f.c.call("a", f.run, {
      operation: "coding_resume",
      id: j.id,
      baseRevision: 1,
      requestKey: "unsafe-resume",
    }),
  );
  assert.equal((await f.row(job.id)).revision, 1);
  assert.equal(f.publishes(), 1);
});
test("JSONB field ordering cannot break progress or finished-result reconciliation", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id),
    e = { key: "started", stage: "planning", summary: "Synthetic progress" };
  await f.c.progress(j, e);
  await f.db.query(
    "UPDATE coding_events SET payload=$2::jsonb WHERE job_id=$1 AND event_key<>'fixture-approved'",
    [j.id, JSON.stringify({ summary: e.summary, stage: e.stage, key: e.key })],
  );
  assert.equal((await f.c.progress(j, e)).accepted, true);
  const r = candidate();
  await f.c.finish(j, r);
  await f.db.query("UPDATE coding_jobs SET result=$2::jsonb WHERE id=$1", [
    j.id,
    canonicalJson(r),
  ]);
  assert.equal((await f.c.finish(await f.row(j.id), r)).accepted, true);
});
test("a pre-send database failure returns the coding notice to pending without a Telegram attempt", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  await f.c.progress(j, {
    key: "question",
    stage: "planning",
    summary: "Synthetic question",
  });
  const query = f.db.query.bind(f.db);
  let fail = true,
    sends = 0;
  f.db.query = async (sql, values) => {
    if (sql.startsWith("SELECT * FROM coding_jobs WHERE id=") && fail) {
      fail = false;
      throw new Error("synthetic lookup failure");
    }
    return query(sql, values);
  };
  await f.c.deliver(async () => {
    sends++;
  });
  assert.equal(sends, 0);
  assert.equal(
    (
      await query(
        "SELECT delivery FROM coding_events WHERE event_key<>'fixture-approved'",
      )
    ).rows[0].delivery,
    "pending",
  );
  await f.c.deliver(async () => {
    sends++;
  });
  assert.equal(sends, 1);
});
test("sandbox inspection accepts only explicit terminal states", async () => {
  let status = "QUEUED";
  const p = new CodeBuildSandbox(
    { send: async () => ({ builds: [{ buildStatus: status }] }) } as any,
    "fixture",
  );
  assert.equal(await p.inspect("fixture"), "running");
  status = "IN_PROGRESS";
  assert.equal(await p.inspect("fixture"), "running");
  status = "STOPPED";
  assert.equal(await p.inspect("fixture"), "terminal");
  status = "UNKNOWN";
  await assert.rejects(p.inspect("fixture"), /Unknown/);
});
