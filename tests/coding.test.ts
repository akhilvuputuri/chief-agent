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
import { ModelError } from "../src/model.js";
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

const settings = codingSettings.parse({
  repository: "akhilvuputuri/chief-agent",
  branch: "main",
  image: `ghcr.io/example/worker@sha256:${"a".repeat(64)}`,
  model: "fixture/coder",
  reviewerModel: "fixture/reviewer",
  effort: "high",
  limits: { ms: 900000, models: 40, tools: 100 },
});
const base = "a".repeat(40);
const candidate = () => {
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
      command: `npm run ${s}`,
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
async function fixture(t: TestContext) {
  const pg = new PGlite();
  t.after(() => pg.close());
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => /^\d.*sql$/.test(f))
    .sort())
    await pg.exec(
      await readFile(new URL(`../db/${file}`, import.meta.url), "utf8"),
    );
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
    settings,
    provider,
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

test("expanded coding allocations survive assignment, provisioning, status and checkpoint validation", async (t) => {
  const limits = { ms: 7200000, models: 400, tools: 1000 };
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
      squadState: { ...cp.squadState, sequence: 2, toolsUsed: 1001 },
    }),
  );
});

test("coding is unavailable by default and discovered through the work tools when enabled", () => {
  const off = runtimeContext({}, null).tools;
  assert(!off.some((t) => t.name.startsWith("coding_")));
  const on = runtimeContext(
    { coding: true },
    null,
    undefined,
    new Set(["work"]),
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

test("remaining job deadline aborts a stalled model and exposes its exact timeout category", async (t) => {
  const f = await fixture(t);
  const job: any = await f.start("deadline-stream", "plan");
  await f.c.tick();
  const row = await f.row(job.id);
  // The fixture host clock is stable, so the remaining allocation is deterministic.
  const allocationStart = new Date(row.heartbeat_at).getTime();
  await f.db.query(
    'UPDATE coding_jobs SET attempt_deadline=$2,settings=settings || \'{"harnessVersion":2,"squad":true}\'::jsonb WHERE id=$1',
    [job.id, new Date(allocationStart + 100)],
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
      /Invalid worker capability/,
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

test("CodeBuild refuses an insufficient or unconfirmed timeout while retaining the created sandbox identity", async () => {
  for (const actual of [45, undefined, NaN, 1, 2161]) {
    let calls = 0;
    const p = new CodeBuildSandbox(
      {
        send: async () => {
          calls++;
          return { build: { id: "fixture:short", timeoutInMinutes: actual } };
        },
      } as any,
      "fixture-project",
    );
    await assert.rejects(
      p.create({
        jobId: randomUUID(),
        attemptId: randomUUID(),
        token: "synthetic",
        origin: "https://example.invalid",
        image: settings.image,
        timeoutMinutes: 125,
      }),
      (error: unknown) => {
        assert(error instanceof SandboxTimeoutMismatch);
        assert.equal(error.sandboxId, "fixture:short");
        assert.equal(error.requestedMinutes, 125);
        assert.equal(error.actualMinutes, actual === 45 ? 45 : undefined);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("cancelled launch retains its rejected receipt identity without changing cancellation or relaunching", async (t) => {
  const f = await fixture(t),
    job = await f.start("cancelled-timeout-receipt", "plan");
  let rejectReceipt!: () => void;
  const receipt = new Promise<string>((_resolve, reject) => {
    rejectReceipt = () =>
      reject(new SandboxTimeoutMismatch("fixture:cancelled-short", 125, 45));
  });
  f.provider.create = async () => receipt;
  const dispatch = f.c.tick();
  let launching;
  for (let i = 0; i < 30; i++) {
    launching = await f.row(job.id);
    if (launching.state === "provisioning") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(launching.state, "provisioning");
  await f.c.call("a", f.run, { operation: "coding_cancel", id: job.id });
  rejectReceipt();
  await dispatch;
  const cancelled = await f.row(job.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.summary, "Cancelled by the owner");
  assert.equal(cancelled.sandbox_id, "fixture:cancelled-short");
  assert.equal(cancelled.cleanup, "pending");
  assert.equal(
    (
      await f.db.query(
        "SELECT 1 FROM coding_events WHERE job_id=$1 AND event_key=$2",
        [job.id, `${cancelled.attempt_id}:paused`],
      )
    ).rows.length,
    0,
  );
  f.provider.find = async () => {
    throw new Error("reconciliation must not discard a known receipt");
  };
  let stopped = false;
  f.provider.inspect = async () => (stopped ? "terminal" : "running");
  f.provider.terminate = async (id) => {
    assert.equal(id, "fixture:cancelled-short");
    stopped = true;
  };
  await f.c.tick();
  await f.c.tick();
  assert.equal((await f.row(job.id)).cleanup, "complete");
  assert.equal(f.modelCalls(), 0);
});

test("restart reconciliation verifies active allocation before allowing worker authentication", async (t) => {
  const f = await fixture(t),
    job = await f.start("recovered-short-timeout", "plan");
  await f.db.query(
    "UPDATE coding_jobs SET settings=jsonb_set(settings,'{limits}', $2::jsonb) WHERE id=$1",
    [job.id, JSON.stringify({ ms: 7200000, models: 400, tools: 1000 })],
  );
  await f.c.tick();
  await f.db.query("UPDATE coding_jobs SET sandbox_id=NULL WHERE id=$1", [
    job.id,
  ]);
  f.provider.find = async (_id: string, required?: number) => {
    assert.equal(required, 125);
    throw new SandboxTimeoutMismatch("fixture:recovered-short", 125, 45);
  };
  await f.c.tick();
  const paused = await f.row(job.id);
  assert.equal(paused.state, "paused");
  assert.equal(paused.sandbox_id, "fixture:recovered-short");
  assert.match(paused.summary, /accepted 45 minutes/);
  await assert.rejects(
    f.c.authenticate(job.id, f.c.token(job.id, paused.attempt_id)),
    /Invalid worker capability/,
  );
  let stopped = false;
  f.provider.inspect = async () => (stopped ? "terminal" : "running");
  f.provider.terminate = async () => {
    stopped = true;
  };
  await f.c.tick();
  await f.c.tick();
  assert.equal((await f.row(job.id)).cleanup, "complete");
  assert.equal(f.creates(), 1);
  assert.equal(f.modelCalls(), 0);
});

test("CodeBuild reconciliation validates active receipts while permitting cleanup lookup of a short sandbox", async () => {
  const attempt = randomUUID();
  const p = new CodeBuildSandbox(
    {
      send: async (command) =>
        command.constructor.name === "ListBuildsForProjectCommand"
          ? { ids: ["fixture:recovered"] }
          : {
              builds: [
                {
                  id: "fixture:recovered",
                  timeoutInMinutes: 45,
                  environment: {
                    environmentVariables: [
                      { name: "CODING_ATTEMPT_ID", value: attempt },
                    ],
                  },
                },
              ],
            },
    } as any,
    "fixture-project",
  );
  await assert.rejects(p.find(attempt, 125), SandboxTimeoutMismatch);
  assert.equal(await p.find(attempt), "fixture:recovered");
});

test("CodeBuild accepts a confirmed sufficient timeout", async () => {
  for (const actual of [125, 130]) {
    const p = new CodeBuildSandbox(
      {
        send: async () => ({
          build: { id: "fixture:accepted", timeoutInMinutes: actual },
        }),
      } as any,
      "fixture-project",
    );
    assert.equal(
      await p.create({
        jobId: randomUUID(),
        attemptId: randomUUID(),
        token: "synthetic",
        origin: "https://example.invalid",
        image: settings.image,
        timeoutMinutes: 125,
      }),
      "fixture:accepted",
    );
  }
});

test("terminal provider metadata explains timeout and falls back safely if the diagnostic read fails", async (t) => {
  for (const diagnosticReadFails of [false, true]) {
    const f = await fixture(t),
      job = await f.start(`terminal-diagnostic-${diagnosticReadFails}`, "plan");
    await f.c.tick();
    f.provider.inspect = async () => "terminal";
    Object.assign(f.provider, {
      terminalReason: async () => {
        if (diagnosticReadFails)
          throw new Error("private provider diagnostic error");
        return "Sandbox provider timed out after 45 minutes before a result was recorded; saved work is retained";
      },
    });
    await f.c.tick();
    const paused = await f.row(job.id);
    assert.equal(paused.state, "paused");
    assert.equal(paused.cleanup, "pending");
    assert.match(
      paused.summary,
      diagnosticReadFails
        ? /stopped before a result/
        : /timed out after 45 minutes/,
    );
    assert(!paused.summary.includes("private"));
    await f.c.tick();
    assert.equal((await f.row(job.id)).cleanup, "complete");
    assert.equal(f.creates(), 1);
    assert.equal(f.modelCalls(), 0);
  }
});

test("CodeBuild identifies a timed-out BUILD even when the overall build status is FAILED", async () => {
  const p = new CodeBuildSandbox(
    {
      send: async () => ({
        builds: [
          {
            buildStatus: "FAILED",
            timeoutInMinutes: 45,
            phases: [{ phaseType: "BUILD", phaseStatus: "TIMED_OUT" }],
          },
        ],
      }),
    } as any,
    "fixture-project",
  );
  assert.match(
    (await p.terminalReason("fixture:timedout"))!,
    /timed out after 45 minutes/,
  );
});

test("workspace rejects traversal and symlinks, captures new/deleted files and kills commands on cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-workspace-test-"));
  const stop = new AbortController(),
    w = new Workspace(root, stop.signal);
  await w.command("git", ["init"]);
  await w.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  await w.write("src/new.ts", "export const a=1;\n");
  await assert.rejects(w.write("../escape", "x"));
  const outside = await mkdtemp(join(tmpdir(), "chief-outside-"));
  await symlink(outside, join(root, "link"));
  await assert.rejects(w.write("link/escape", "x"));
  await rm(join(root, "link"));
  await w.command("git", ["add", "src/new.ts"]);
  await w.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  await w.remove("src/new.ts");
  await w.write("src/other.ts", "export const b=2;\n");
  const c = await w.snapshot("plan", "summary");
  assert.equal(c.files.find((f) => f.path === "src/new.ts")?.content, null);
  assert.equal(
    c.files.find((f) => f.path === "src/other.ts")?.content,
    "export const b=2;\n",
  );
  const running = w.command(process.execPath, [
    "-e",
    "setInterval(()=>{},10000)",
  ]);
  setTimeout(() => stop.abort(), 25);
  assert.equal((await running).exitCode, -1);
});
test("review tools cannot write even if the model invents an unavailable command", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-review-test-")),
    w = new Workspace(root, new AbortController().signal);
  let call = 0;
  const messages: any[] = [
    { role: "system", content: "review" },
    { role: "user", content: "fixture" },
  ];
  const model: any = {
    generate: async () => ({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: String(++call),
            type: "function",
            function: {
              name: call === 1 ? "command" : "report",
              arguments: JSON.stringify(
                call === 1
                  ? { command: "touch forbidden" }
                  : {
                      kind: "REQUEST_CHANGES",
                      summary: "Concrete fixture finding",
                    },
              ),
            },
          },
        ],
      },
    }),
  };
  const r = await codingLoop({
    model,
    workspace: w,
    messages,
    mode: "review",
    budget: { models: 3, tools: 3 },
    signal: new AbortController().signal,
    checkpoint: async () => {
      throw new Error("unexpected write");
    },
  });
  assert.equal(r.kind, "REQUEST_CHANGES");
  assert(messages[3].content.includes("rejected"));
  assert(!(await readdir(root)).includes("forbidden"));
});
test("publication rejects unsafe file manifests", () => {
  for (const path of [
    "../escape",
    ".git/config",
    ".env",
    ".github/workflows/pwn.yml",
  ])
    assert.throws(() => validateFiles([{ path, content: "x" }]));
});

test("worker implements, verifies and reviews a real disposable fixture before returning its candidate", async () => {
  let fixtureBase = "";
  const reports: any[] = [];
  let coderCalls = 0,
    reviewerCalls = 0;
  const client: any = {
    request: async (path: string, body: any) => {
      if (path === "assignment")
        return {
          id: randomUUID(),
          revision: 1,
          objective: "字".repeat(8000),
          context: "字".repeat(14000),
          mode: "implement",
          baseSha: fixtureBase,
          settings,
          checkpoint: { plan: "", summary: "", patch: "", files: [] },
          deadline: new Date(Date.now() + 60000).toISOString(),
          usedModels: 0,
        };
      reports.push({ path, body });
      return { accepted: true };
    },
    adapter: (role: string) => ({
      generate: async (input: any) => {
        if (role === "reviewer") {
          reviewerCalls++;
          assert(input.messages[1].content.includes("fixture.js"));
          assert(
            Buffer.byteLength(
              JSON.stringify({
                callId: randomUUID(),
                role: "reviewer",
                messages: input.messages,
                tools: input.tools,
              }),
            ) < 180000,
            "review receives bounded metadata, not a full large patch",
          );
          const last = input.messages.findLast((m: any) => m.role === "tool");
          const page = last ? JSON.parse(last.content) : undefined;
          if (!page || page.nextOffset !== null)
            return {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `plan-${reviewerCalls}`,
                    type: "function",
                    function: {
                      name: "plan_read",
                      arguments: JSON.stringify({
                        offset: page?.nextOffset ?? 0,
                      }),
                    },
                  },
                ],
              },
            };
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "review",
                  type: "function",
                  function: {
                    name: "report",
                    arguments: JSON.stringify({
                      kind: "APPROVE",
                      summary:
                        "Synthetic change matches the requested fixture.",
                    }),
                  },
                },
              ],
            },
          };
        }
        coderCalls++;
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `coder-${coderCalls}`,
                type: "function",
                function: {
                  name: coderCalls === 1 ? "file_write" : "report",
                  arguments: JSON.stringify(
                    coderCalls === 1
                      ? {
                          path: "fixture.js",
                          content: "export const fixture = true;\n",
                        }
                      : {
                          kind: "candidate",
                          summary: "Fixed the fixture",
                          plan: "字".repeat(32000),
                        },
                  ),
                },
              },
            ],
          },
        };
      },
    }),
  };
  const source = await mkdtemp(join(tmpdir(), "chief-worker-fixture-")),
    seed = new Workspace(source, new AbortController().signal);
  await seed.command("git", ["init"]);
  await seed.write(".gitignore", "node_modules\n");
  await seed.write("fixture.js", "export const fixture = false;\n");
  await seed.write(
    "package.json",
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      type: "module",
      scripts: {
        check:
          "node -e \"import('./fixture.js').then(m=>{if(!m.fixture)process.exit(1)})\"",
        build: "node --check fixture.js",
        "format:check": "node --check fixture.js",
      },
    }),
  );
  await seed.write(
    "package-lock.json",
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "fixture", version: "1.0.0" } },
    }),
  );
  await seed.command("git", ["add", "-A"]);
  await seed.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  fixtureBase = (
    await seed.command("git", ["rev-parse", "HEAD"])
  ).output.trim();
  // Exercise an artifact larger than one API message without asking the model to emit it.
  await seed.write("large-a.txt", "a".repeat(75000));
  await seed.write("large-b.txt", "b".repeat(75000));
  await runWorker(
    client,
    new AbortController().signal,
    async (w, _repo, _base, c) => {
      assert.equal(
        (await w.command("git", ["clone", source, "."])).exitCode,
        0,
      );
      if (!c.files.length) {
        await w.write("large-a.txt", "a".repeat(75000));
        await w.write("large-b.txt", "b".repeat(75000));
        for (let i = 0; i < 92; i++)
          await w.write(
            `src/${"x".repeat(200)}-${i}.ts`,
            "export const fixture = true;\n",
          );
      }
      await w.restore(c);
    },
  );
  const result = reports.find((r) => r.path === "finish").body;
  assert.equal(result.kind, "candidate");
  assert(result.checkpoint.patch.length > 120000);
  assert.equal(reviewerCalls, 7);
  assert.equal(result.review.patchHash, artifactHash(result.checkpoint));
  assert.equal(result.checks.length, 3);
  assert(result.checks.every((c: any) => c.exitCode === 0));
  assert(reports.some((r) => r.path === "checkpoint"));
});

test("GitHub publication reconciles a lost PR response and rejects an externally changed head", async () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const repo = "example/repo",
    id = randomUUID();
  let created = false,
    external = false,
    posts = 0;
  const transport: any = async (url: string, options: any) => {
    const path = new URL(url).pathname;
    let data: any;
    if (path.endsWith("/access_tokens"))
      data = {
        token: "fixture",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      };
    else if (path.endsWith("/pulls") && options.method === "GET")
      data = created
        ? [
            {
              state: "open",
              draft: true,
              html_url: `https://github.com/${repo}/pull/1`,
              head: { sha: "head", repo: { full_name: repo } },
              base: { repo: { full_name: repo } },
            },
          ]
        : [];
    else if (path.endsWith(`/git/commits/${base}`))
      data = { tree: { sha: "base-tree" } };
    else if (path.endsWith("/git/trees/base-tree"))
      data = { tree: [], truncated: false };
    else if (path.endsWith("/git/trees") && options.method === "POST")
      data = { sha: "candidate-tree" };
    else if (path.endsWith("/git/commits") && options.method === "POST") {
      assert.deepEqual(JSON.parse(options.body).author, {
        name: "Human Fixture",
        email: "fixture@example.com",
      });
      data = { sha: "head" };
    } else if (path.endsWith("/git/refs")) data = {};
    else if (path.endsWith("/pulls") && options.method === "POST") {
      created = true;
      posts++;
      assert(!options.body.includes("private incident"));
      throw new Error("Response lost after PR creation");
    } else if (path.endsWith("/git/commits/head"))
      data = {
        tree: { sha: external ? "externally-changed" : "candidate-tree" },
        parents: [{ sha: base }],
      };
    else throw new Error(`Unexpected fixture path ${path}`);
    return new Response(JSON.stringify(data), { status: 200 });
  };
  const publisher = new GitHubPublisher(
    repo,
    "1",
    "2",
    key,
    { name: "Human Fixture", email: "fixture@example.com" },
    transport,
  );
  const job = {
    id,
    revision: 1,
    base_sha: base,
    objective: "private incident",
    result: candidate(),
    settings: { repository: repo },
  };
  await assert.rejects(publisher.publish(job));
  assert.equal((await publisher.publish(job)).head, "head");
  assert.equal(posts, 1);
  external = true;
  await assert.rejects(publisher.publish(job), /no longer matches/);
});

test("revoking a queued owner leaves no nonexistent sandbox cleanup and releases the global lane", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  f.revoke();
  await f.c.tick();
  await f.c.tick();
  const j = await f.row(job.id);
  assert.equal(j.state, "paused");
  assert.equal(j.cleanup, "none");
  assert.equal(f.creates(), 0);
  f.restoreOwner();
  await f.start("other");
  await f.c.tick();
  assert.equal(f.creates(), 1);
});
test("revoking a publishing owner pauses the candidate after cleanup and releases the global lane", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  await f.c.finish(j, candidate());
  f.revoke();
  await f.c.tick();
  await f.c.tick();
  await f.c.tick();
  const stopped = await f.row(job.id);
  assert.equal(stopped.state, "paused");
  assert.equal(stopped.cleanup, "complete");
  assert.equal(f.publishes(), 0);
  f.restoreOwner();
  await f.start("other");
  await f.c.tick();
  assert.equal(f.creates(), 2);
});
test("file modes survive snapshot, restore and artifact identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-mode-test-")),
    w = new Workspace(root, new AbortController().signal);
  await w.command("git", ["init"]);
  await w.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  await w.write("script.sh", "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "script.sh"), 0o755);
  const c = await w.snapshot("plan", "summary");
  assert.equal(c.files[0]?.mode, "100755");
  const dest = await mkdtemp(join(tmpdir(), "chief-mode-restore-")),
    restored = new Workspace(dest, new AbortController().signal);
  await restored.restore(c);
  assert((await stat(join(dest, "script.sh"))).mode & 0o111);
  const altered = {
    ...c,
    files: c.files.map((f) => ({ ...f, mode: "100644" as const })),
  };
  assert.notEqual(artifactHash(c), artifactHash(altered));
});
test("small histories remain below the worker API message ceiling until the actual allocation is used", async () => {
  let calls = 0;
  const model: any = {
    generate: async (input: any) => {
      assert(input.messages.length <= 120);
      calls++;
      const entries =
        calls <= 33
          ? Array.from({ length: 3 }, (_, i) => ({
              id: `${calls}-${i}`,
              type: "function",
              function: {
                name: "file_read",
                arguments: JSON.stringify({ path: "tiny.ts" }),
              },
            }))
          : [
              {
                id: "finish",
                type: "function",
                function: {
                  name: "report",
                  arguments: JSON.stringify({
                    kind: "candidate",
                    summary: "Synthetic complete",
                  }),
                },
              },
            ];
      return {
        message: { role: "assistant", content: null, tool_calls: entries },
      };
    },
  };
  const report = await codingLoop({
    model,
    workspace: {
      read: async () => ({ text: "tiny", nextOffset: null }),
    } as any,
    messages: [
      { role: "system", content: "fixture" },
      { role: "user", content: "assignment" },
    ],
    mode: "implement",
    budget: { models: 40, tools: 100 },
    signal: new AbortController().signal,
    checkpoint: async () => {},
  });
  assert.equal(calls, 34);
  assert.equal(report.kind, "candidate");
});
test("cancellation while the model claim is acknowledged prevents subsequent paid dispatch", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  const query = f.db.query.bind(f.db);
  let cancelled = false;
  f.db.query = async (sql, values) => {
    const result = await query(sql, values);
    if (sql.includes("INSERT INTO coding_model_calls") && !cancelled) {
      cancelled = true;
      await f.c.call("a", f.run, { operation: "coding_cancel", id: j.id });
    }
    return result;
  };
  await assert.rejects(
    f.c.generate(j, {
      callId: randomUUID(),
      role: "coder",
      messages: [{ role: "user", content: "fixture" }],
      tools: [],
    }),
    /cancelled/,
  );
  assert.equal(f.modelCalls(), 0);
  assert.equal((await f.row(j.id)).state, "cancelled");
});
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
test("UTF-8 observations fit the model endpoint byte limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-utf8-test-")),
    w = new Workspace(root, new AbortController().signal);
  await w.write("unicode.txt", "字".repeat(80000));
  let calls = 0;
  const model: any = {
    generate: async (input: any) => {
      assert(
        Buffer.byteLength(
          JSON.stringify({
            callId: randomUUID(),
            role: "coder",
            messages: input.messages,
            tools: input.tools,
          }),
        ) <= 180000,
      );
      calls++;
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: String(calls),
              type: "function",
              function: {
                name: calls <= 3 ? "file_read" : "report",
                arguments: JSON.stringify(
                  calls <= 3
                    ? { path: "unicode.txt", offset: 0 }
                    : { kind: "candidate", summary: "Synthetic complete" },
                ),
              },
            },
          ],
        },
      };
    },
  };
  await codingLoop({
    model,
    workspace: w,
    messages: [
      { role: "system", content: "fixture" },
      { role: "user", content: "assignment" },
    ],
    mode: "implement",
    budget: { models: 5, tools: 5 },
    signal: new AbortController().signal,
    checkpoint: async () => {},
  });
  assert.equal(calls, 4);
});
test("staged executable modes match the artifact even when disk permissions are unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-index-mode-")),
    w = new Workspace(root, new AbortController().signal);
  await w.command("git", ["init"]);
  await w.write("script.sh", "#!/bin/sh\nexit 0\n");
  await w.command("git", ["add", "-A"]);
  await w.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  await w.command("git", ["config", "core.filemode", "false"]);
  await w.command("git", ["update-index", "--chmod=+x", "script.sh"]);
  assert.equal((await stat(join(root, "script.sh"))).mode & 0o111, 0);
  const c = await w.snapshot("plan", "summary");
  assert.equal(c.files[0]?.mode, "100755");
  assert.match(c.patch, /new mode 100755/);
});

test("broker retries preserve exact source text while private diagnostic copies remain scrubbed", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id);
  f.setReply("Use the literal template: Bearer ${placeholder}");
  const input = {
    callId: randomUUID(),
    role: "coder" as const,
    messages: [{ role: "user" as const, content: "Synthetic template" }],
    tools: [],
  };
  const first = await f.c.generate(j, input),
    cached = await f.c.generate(j, input);
  assert.deepEqual(cached, first);
  assert.equal(f.modelCalls(), 1);
  const record = (
    await f.db.query(
      "SELECT result,result_box FROM coding_model_calls WHERE id=$1",
      [input.callId],
    )
  ).rows[0];
  assert(record.result_box);
  assert.notEqual(record.result.message.content, first.message.content);
});

test("a rename artifact includes both the old deletion and the new indexed file", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-rename-test-")),
    w = new Workspace(root, new AbortController().signal);
  await w.command("git", ["init"]);
  await w.write("old.txt", "fixture\n");
  await w.command("git", ["add", "-A"]);
  await w.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  await w.command("git", ["mv", "old.txt", "new.txt"]);
  const c = await w.snapshot("plan", "summary");
  assert.equal(c.files.find((f) => f.path === "old.txt")?.content, null);
  assert.equal(c.files.find((f) => f.path === "new.txt")?.content, "fixture\n");
});
test("non-UTF-8 indexed content is rejected instead of publishing replacement bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-encoding-test-")),
    w = new Workspace(root, new AbortController().signal);
  await w.command("git", ["init"]);
  await w.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  await writeFile(join(root, "latin.txt"), Buffer.from("636166e90a", "hex"));
  await assert.rejects(w.snapshot("plan", "summary"), /not valid UTF-8/);
});
test("oversized owner briefs are rejected and large saved plans remain resumable through paging", async (t) => {
  assert.throws(
    () =>
      assertCodingBrief(
        "字".repeat(8000),
        "字".repeat(23000),
        "字".repeat(32000),
      ),
    /shorter objective/,
  );
  const f = await fixture(t);
  await assert.rejects(
    f.c.call("a", f.run, {
      operation: "coding_start",
      requestKey: "large",
      objective: "字".repeat(8000),
      context: "字".repeat(16000),
      mode: "plan",
    }),
    /brief is too large/,
  );
  assert.equal(f.creates(), 0);
  assert.equal(
    (await f.db.query("SELECT count(*) AS n FROM coding_jobs")).rows[0].n,
    0,
  );
  const job = await f.start();
  await f.db.query(
    "UPDATE coding_jobs SET mode='plan',state='plan_ready',checkpoint=$2::jsonb WHERE id=$1",
    [
      job.id,
      JSON.stringify({
        plan: "字".repeat(32000),
        patch: "",
        summary: "",
        files: [],
      }),
    ],
  );
  const resumed: any = await f.c.call("a", f.run, {
    operation: "coding_reply",
    id: job.id,
    baseRevision: 1,
    requestKey: "revise",
    message: "Keep the same scope, refine the tests",
    mode: "plan",
  });
  assert.equal((await f.row(job.id)).checkpoint.plan.length, 32000);
  assert.equal(resumed.revision, 2);
});

test("required dependency installation keeps npm caches outside the captured checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-npm-home-")),
    pack = await mkdtemp(join(tmpdir(), "chief-npm-pack-")),
    dep = await mkdtemp(join(tmpdir(), "chief-npm-dep-"));
  const signal = new AbortController().signal,
    w = new Workspace(root, signal),
    d = new Workspace(dep, signal);
  await d.write(
    "package.json",
    JSON.stringify({
      name: "chief-fixture-dep",
      version: "1.0.0",
      main: "index.js",
    }),
  );
  await d.write("index.js", "module.exports=true;\n");
  assert.equal(
    (
      await d.command("npm", [
        "pack",
        "--offline",
        "--ignore-scripts",
        "--pack-destination",
        pack,
      ])
    ).exitCode,
    0,
  );
  await w.command("git", ["init"]);
  await w.write(".gitignore", "node_modules\n");
  await w.write(
    "package.json",
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      dependencies: {
        "chief-fixture-dep": `file:${join(pack, "chief-fixture-dep-1.0.0.tgz")}`,
      },
    }),
  );
  assert.equal(
    (
      await w.command("npm", [
        "install",
        "--package-lock-only",
        "--offline",
        "--ignore-scripts",
      ])
    ).exitCode,
    0,
  );
  await w.command("git", ["add", "-A"]);
  await w.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  const installed = await w.command("npm", [
    "ci",
    "--offline",
    "--ignore-scripts",
  ]);
  assert.equal(installed.exitCode, 0, installed.output);
  assert(!(await readdir(root)).includes(".npm"));
  assert.equal((await w.snapshot("plan", "summary")).files.length, 0);
});

test("lease-release failure cannot permanently disable controller ticks", async (t) => {
  const f = await fixture(t),
    job = await f.start(),
    query = f.db.query.bind(f.db);
  let fail = true;
  f.db.query = async (sql, values) => {
    if (fail && sql.startsWith("UPDATE coding_jobs SET lease=NULL")) {
      fail = false;
      throw new Error("synthetic release failure");
    }
    return query(sql, values);
  };
  await assert.rejects(f.c.tick());
  await query(
    "UPDATE coding_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",
    [job.id],
  );
  f.advance(181000);
  await f.c.tick();
  assert.equal((await f.row(job.id)).state, "paused");
  assert.equal(f.creates(), 1);
});

test("review approval requires contiguous delivery of the entire saved plan", async () => {
  let calls = 0;
  const plan = "x".repeat(12000),
    messages: any[] = [
      { role: "system", content: "review" },
      { role: "user", content: "preview only" },
    ];
  const model: any = {
    generate: async () => {
      calls++;
      const read = calls === 2 || calls === 3;
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: String(calls),
              type: "function",
              function: {
                name: read ? "plan_read" : "report",
                arguments: JSON.stringify(
                  read
                    ? { offset: calls === 2 ? 0 : 6000 }
                    : { kind: "APPROVE", summary: "Synthetic approval" },
                ),
              },
            },
          ],
        },
      };
    },
  };
  const r = await codingLoop({
    model,
    workspace: {} as any,
    messages,
    mode: "review",
    budget: { models: 5, tools: 5 },
    signal: new AbortController().signal,
    checkpoint: async () => {},
    plan: () => plan,
  });
  assert.equal(r.kind, "APPROVE");
  assert.equal(calls, 4);
  assert(JSON.parse(messages[3].content).error.includes("complete saved plan"));
});
test("a large unchanged index does not prevent capturing one changed file", async () => {
  const root = await mkdtemp(join(tmpdir(), "chief-large-index-")),
    w = new Workspace(root, new AbortController().signal);
  await w.command("git", ["init"]);
  const generated = await w.command(process.execPath, [
    "-e",
    "const fs=require('fs');for(let i=0;i<2100;i++)fs.writeFileSync('f'.repeat(200)+'-'+i+'.txt','fixture\\n');",
  ]);
  assert.equal(generated.exitCode, 0);
  await w.command("git", ["add", "-A"]);
  await w.command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    "fixture",
  ]);
  const name = "f".repeat(200) + "-0.txt";
  await w.write(name, "changed\n");
  const c = await w.snapshot("plan", "summary");
  assert.equal(c.files.length, 1);
  assert.equal(c.files[0]?.path, name);
  assert.equal(c.files[0]?.content, "changed\n");
});

test("review cannot approve a plan read in the same generated tool batch", async () => {
  let calls = 0;
  const plan = "Acceptance criterion at the end.";
  const model: any = {
    generate: async (input: any) => {
      calls++;
      if (calls === 2)
        assert(
          input.messages.some(
            (m: any) => m.role === "tool" && m.content.includes(plan),
          ),
        );
      const report = {
        id: `report-${calls}`,
        type: "function",
        function: {
          name: "report",
          arguments: JSON.stringify({
            kind: "APPROVE",
            summary: "Synthetic verdict",
          }),
        },
      };
      return {
        message: {
          role: "assistant",
          content: null,
          tool_calls:
            calls === 1
              ? [
                  {
                    id: "read",
                    type: "function",
                    function: { name: "plan_read", arguments: '{"offset":0}' },
                  },
                  report,
                ]
              : [report],
        },
      };
    },
  };
  const r = await codingLoop({
    model,
    workspace: {} as any,
    messages: [
      { role: "system", content: "review" },
      { role: "user", content: "preview" },
    ],
    mode: "review",
    budget: { models: 3, tools: 4 },
    signal: new AbortController().signal,
    checkpoint: async () => {},
    plan: () => plan,
  });
  assert.equal(r.kind, "APPROVE");
  assert.equal(calls, 2);
});

test("Python launcher is host-selected and drops capabilities before executing the package", async () => {
  const commands: any[] = [];
  const provider = new CodeBuildSandbox(
    {
      send: async (command: any) => {
        commands.push(command);
        return { build: { id: "fixture:python", timeoutInMinutes: 20 } };
      },
    } as any,
    "fixture-project",
  );
  await provider.create({
    jobId: randomUUID(),
    attemptId: randomUUID(),
    token: "a".repeat(64),
    origin: "https://fixture.example",
    image: settings.image,
    runtime: "python",
    timeoutMinutes: 20,
  });
  assert(
    commands[0].input.buildspecOverride.includes(
      "--no-new-privs --bounding-set=-all python -I -m chief_coding_runtime.worker",
    ),
  );
  assert(!commands[0].input.buildspecOverride.includes("worker.js"));
});

test("coding gateway preserves opaque OpenRouter reasoning through validated model requests", async (t) => {
  const f = await fixture(t),
    job = await f.start();
  await f.c.tick();
  const j = await f.row(job.id),
    app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const input = {
    callId: randomUUID(),
    role: "coder",
    messages: [
      {
        role: "assistant",
        content: null,
        reasoning_details: [
          { type: "reasoning.encrypted", data: "synthetic-opaque", index: 0 },
        ],
        tool_calls: [
          {
            id: "one",
            type: "function",
            function: { name: "file_read", arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { role: "tool", content: "Synthetic fixture", tool_call_id: "one" },
    ],
    tools: [],
  };
  input.messages[0].tool_calls![0].function.arguments = JSON.stringify({
    path: "large.txt",
    content: "x".repeat(32000),
  });
  const request = {
    method: "POST" as const,
    url: `/coding/worker/${j.id}/model`,
    headers: { authorization: `Bearer ${f.c.token(j.id, j.attempt_id)}` },
    payload: input,
  };
  assert.equal((await app.inject(request)).statusCode, 200);
  assert.equal((await app.inject(request)).statusCode, 200);
  assert.equal(f.modelCalls(), 1);
  const changed = {
    ...input,
    messages: input.messages.map((m) =>
      m.role === "assistant"
        ? {
            ...m,
            reasoning_details: [
              { type: "reasoning.encrypted", data: "changed", index: 0 },
            ],
          }
        : m,
    ),
  };
  assert.equal(
    (await app.inject({ ...request, payload: changed })).statusCode,
    409,
  );
});

async function requirementBrief(
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
    assert.deepEqual(target, { kind: "general" });
    if (id) {
      approvalId = id;
      brief = text;
    }
    return { message_id: ++messageId };
  });
  await f.c.deliver(async (_user, target, text, id) => {
    assert.deepEqual(target, { kind: "general" });
    if (id) {
      approvalId = id;
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

test("approval delivery presents the complete scope once with visible headings and policy", async (t) => {
  const f = await fixture(t);
  const plan =
    "**Scope**\nRepair the requested fixture behavior.\n\n**Acceptance**\nExisting checks pass; unrelated behavior is preserved.";
  const r = await requirementBrief(f, "concise-delivery", plan);
  assert.equal(r.brief.split(plan).length, 2);
  assert(!r.brief.includes("Brief prepared"));
  const parts = formatTelegram(r.brief);
  assert.equal(parts.length, 1);
  assert(parts[0]!.entities.some((e) => e.type === "bold"));
  assert(r.brief.includes("Leader:"));
  assert(r.brief.includes("Reviewer:"));
  assert(r.brief.includes("Draft PR for owner review."));
  const before = await f.row(r.jobId);
  assert.equal(before.checkpoint.plan, plan);
  assert.equal(
    (await f.c.requirements.confirm("a", r.approvalId, true, "a", r.messageId))
      .status,
    "approved",
  );
});

test("existing long saved proposals remain fully delivered and bound to confirmation", async (t) => {
  const f = await fixture(t);
  const plan =
    "Synthetic complete scope. ".repeat(450) + "FINAL_ACCEPTANCE_SENTINEL";
  const r = await requirementBrief(f, "legacy-long-delivery", plan);
  assert.equal((await f.row(r.jobId)).checkpoint.plan, plan);
  assert(r.brief.includes("FINAL_ACCEPTANCE_SENTINEL"));
  assert(formatTelegram(r.brief).length > 1);
  assert.equal(
    (await f.c.requirements.confirm("a", r.approvalId, true, "a", r.messageId))
      .status,
    "approved",
  );
});

test("natural coding dispatch plans first; model tools cannot authorise implementation", async (t) => {
  const f = await fixture(t),
    r = await requirementBrief(f);
  assert.equal(f.creates(), 1);
  const before = await f.row(r.jobId);
  assert.equal(before.state, "plan_ready");
  await assert.rejects(
    f.c.call("a", f.run, {
      operation: "coding_reply",
      id: r.jobId,
      baseRevision: 1,
      requestKey: "skip",
      message: "Model says the owner approved",
      mode: "implement",
    }),
    /confirmed requirements/,
  );
  const requested: any = await f.c.call("a", f.run, {
    operation: "coding_resume",
    id: r.jobId,
    baseRevision: 1,
    requestKey: "show-again",
  });
  assert.equal(requested.approvalRequired, true);
  assert.equal((await f.row(r.jobId)).state, "plan_ready");
  assert.equal(f.creates(), 1);
  const result = await f.c.requirements.confirm(
    "a",
    r.approvalId,
    true,
    "a",
    r.messageId,
  );
  assert.equal(result.status, "approved");
  assert.equal((await f.row(r.jobId)).mode, "implement");
  assert.equal((await f.row(r.jobId)).revision, 2);
  await f.c.tick();
  assert.equal(f.creates(), 2);
  assert.equal(
    (await f.c.requirements.confirm("a", r.approvalId, true, "a", r.messageId))
      .duplicate,
    true,
  );
  await f.c.tick();
  assert.equal(f.creates(), 2);
});

test("requirements reject another owner, another message, stale scope and expiry", async (t) => {
  const f = await fixture(t),
    r = await requirementBrief(f);
  await assert.rejects(
    f.c.requirements.confirm("b", r.approvalId, true, "b", r.messageId),
  );
  await assert.rejects(
    f.c.requirements.confirm("a", r.approvalId, true, "b", r.messageId),
  );
  await assert.rejects(
    f.c.requirements.confirm("a", r.approvalId, true, "a", r.messageId + 1),
  );
  f.advance(900001);
  await assert.rejects(
    f.c.requirements.confirm("a", r.approvalId, true, "a", r.messageId),
    /expired/,
  );
  assert.equal(f.creates(), 1);
  await f.c.call("a", f.run, {
    operation: "coding_reply",
    id: r.jobId,
    baseRevision: 1,
    requestKey: "change",
    message: "Change the acceptance criteria",
    mode: "plan",
  });
  await assert.rejects(
    f.c.requirements.confirm("a", r.approvalId, true, "a", r.messageId),
    /changed/,
  );
  assert.equal((await f.row(r.jobId)).mode, "plan");
});

test("declining requirements never starts implementation and unknown delivery cannot authorise work", async (t) => {
  const f = await fixture(t),
    r = await requirementBrief(f);
  assert.equal(
    (await f.c.requirements.confirm("a", r.approvalId, false, "a", r.messageId))
      .status,
    "revise",
  );
  assert.equal((await f.row(r.jobId)).state, "plan_ready");
  await f.c.call("a", f.run, {
    operation: "coding_resume",
    id: r.jobId,
    baseRevision: 2,
    requestKey: "uncertain",
  });
  let uncertainId = "";
  await f.c.deliver(async (_u, _t, _text, id) => {
    uncertainId = id!;
    throw new Error("send outcome unknown");
  });
  assert.equal(
    (
      await f.db.query("SELECT delivery FROM coding_events WHERE id=$1", [
        uncertainId,
      ])
    ).rows[0].delivery,
    "uncertain",
  );
  await assert.rejects(
    f.c.requirements.confirm("a", uncertainId, true, "a", 999),
  );
  assert.equal(f.creates(), 1);
});

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
test("Pi profile rejects Python selectors and automatic merge; runtime launcher stays pinned per job", async () => {
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

test("Pi bridge plans, accepts bound fixture confirmation, builds, reviews and publishes a checked artifact", async (t) => {
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
  const turns = new Map<string, number>();
  f.setGeneration((selected, input) => {
    const system =
      input.messages.find((m: any) => m.role === "system")?.content ?? "";
    const phase =
      selected === settings.reviewerModel
        ? "review"
        : system.includes("Current intent: build")
          ? "build"
          : "plan";
    const count = turns.get(phase) ?? 0;
    turns.set(phase, count + 1);
    let tool: { name: string; arguments: any } | undefined;
    if (phase === "plan" && count === 0)
      tool = { name: "read", arguments: { path: "sum.js" } };
    if (phase === "plan" && count === 1)
      tool = {
        name: "report",
        arguments: {
          kind: "plan",
          summary: "Fix addition",
          detail:
            "Change sum.js subtraction to addition; preserve exported API; run check/build/format checks.",
        },
      };
    if (phase === "build" && count === 0)
      tool = {
        name: "edit",
        arguments: {
          path: "sum.js",
          edits: [{ oldText: "a - b", newText: "a + b" }],
        },
      };
    if (phase === "build" && count === 1)
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
      assert(system.includes("Change sum.js subtraction to addition"));
      tool = { name: "read", arguments: { path: "sum.js" } };
    }
    if (phase === "review" && count === 1)
      tool = {
        name: "report",
        arguments: {
          kind: "review",
          summary: "Reviewed",
          detail:
            "The checked fixture implements addition and preserves the API.",
          verdict: "APPROVE",
        },
      };
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
    await f.c.deliver(async (_owner, _target, _text, id) => {
      const message_id = ++receipt;
      if (id) {
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
  assert.deepEqual(record.settings.limits, saved.limits);
  assert.equal(record.mode, "plan");
  assert.equal(f.creates(), 0);
  const rolledBack = await start(prior, "after-rollback");
  assert.equal((await f.row(rolledBack.id)).settings.runtime, "python");
  assert.deepEqual((await f.row(fresh.id)).settings, record.settings);
  await current.call("a", f.run, { operation: "coding_cancel", id: old.id });
  assert.equal((await f.row(old.id)).state, "cancelled");
  assert.deepEqual((await f.row(old.id)).settings, saved);
});

test("coding model-role commands snapshot new Pi jobs without changing existing jobs or other roles", async (t) => {
  const f = await fixture(t);
  const selected = codingSettings.parse({
    ...settings,
    runtime: "pi",
    squad: false,
    autoMerge: false,
  });
  const catalog = [
    "openai/gpt-6.1-sol",
    "anthropic/claude-sonnet-5.5",
    "anthropic/claude-haiku-5.5",
    "google/gemini-3.8-flash",
    "deepseek/deepseek-v4.1-flash",
    "qwen/qwen3.8-max-0902",
    "z-ai/glm-5.3-flash",
    "mistralai/mistral-large-4-0",
  ].map((id) => ({ id, inputPrice: 1, outputPrice: 5, tools: true }));
  const controller = new CodingController(
    f.db,
    selected,
    f.provider,
    f.publisher,
    "c".repeat(64),
    "https://coding.example.com",
    (user) => user === "a",
    () => {
      throw new Error("Model selection does not dispatch inference");
    },
    undefined,
    async () => catalog,
  );
  const start = async (requestKey: string) =>
    (await controller.call("a", f.run, {
      operation: "coding_start",
      requestKey,
      objective: "Plan a synthetic fix",
      context: "Fixture",
      mode: "plan",
    })) as any;
  const original = await start("original-pi-models");
  const saved = (await f.row(original.id)).settings;
  for (const [index, choice] of catalog.entries()) {
    for (const role of ["leader", "coder", "reviewer"] as const) {
      const prior = (await controller.call("a", f.run, {
        operation: "coding_models",
      })) as any;
      const result = (await controller.call("a", f.run, {
        operation: "coding_model_set",
        role,
        model: choice.id,
      })) as any;
      assert.equal(result[role], choice.id);
      assert.equal(result.appliesTo, "new jobs only");
      for (const other of ["leader", "coder", "reviewer"].filter(
        (r) => r !== role,
      ))
        assert.equal(result[other], prior.preferences[other]);
    }
    const fresh = await start(`model-${index}`);
    const snapshot = (await f.row(fresh.id)).settings;
    assert.equal(snapshot.leaderModel, choice.id);
    assert.equal(snapshot.model, choice.id);
    assert.equal(snapshot.reviewerModel, choice.id);
    assert.equal(snapshot.runtime, "pi");
    assert.equal(snapshot.autoMerge, false);
    assert.deepEqual((await f.row(original.id)).settings, saved);
  }
  await assert.rejects(
    controller.call("b", f.run, {
      operation: "coding_model_set",
      role: "coder",
      model: catalog[0].id,
    }),
  );
  assert.equal(f.creates(), 0);
  assert.equal(f.modelCalls(), 0);
});

test("Pi provider failures expose typed diagnostics without retrying uncertain model calls", async (t) => {
  for (const [failure, code] of [
    [
      new ModelError("Synthetic empty provider response", true, {
        failureCode: "empty",
        finishReason: "stop",
      }),
      "model_transient_failure",
    ],
    [
      new ModelError("Synthetic reasoning exhausted output", false, {
        failureCode: "empty",
        finishReason: "length",
      }),
      "model_incomplete",
    ],
  ] as const) {
    const f = await fixture(t);
    const started = await f.start(randomUUID(), "plan");
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
    f.failModel(failure);
    const app = server();
    t.after(() => app.close());
    await codingApi(app, f.c);
    const callId = randomUUID();
    const request = {
      method: "POST" as const,
      url: `/coding/worker/${job.id}/pi/coder/v1/chat/completions`,
      headers: { authorization: `Bearer ${f.c.token(job.id, job.attempt_id)}` },
      payload: {
        runtime_call_id: callId,
        model: settings.model,
        messages: [{ role: "user", content: "Synthetic failure probe" }],
        tools: [],
      },
    };
    const response = await app.inject(request);
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, code);
    const saved = (
      await f.db.query("SELECT state FROM coding_model_calls WHERE id=$1", [
        callId,
      ])
    ).rows[0];
    assert.equal(saved.state, "uncertain");
    const status = (await f.c.status("a", job.id)) as any;
    assert.equal(status.lastFailure.code, code);
    await app.inject(request);
    assert.equal(f.modelCalls(), 1);
  }
});
