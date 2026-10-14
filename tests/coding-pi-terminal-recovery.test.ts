import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { codingApi } from "../src/coding/api.js";
import { server } from "../src/server.js";
import { ModelError } from "../src/model.js";
import { fixture, settings } from "./helpers/coding-fixture.js";

async function setup(t: TestContext) {
  const f = await fixture(t),
    started = await f.start("terminal-recovery", "plan");
  await f.c.tick();
  await f.db.query("UPDATE coding_jobs SET settings=$2::jsonb WHERE id=$1", [
    started.id,
    JSON.stringify({
      ...settings,
      runtime: "pi",
      squad: false,
      autoMerge: false,
    }),
  ]);
  const job = await f.row(started.id),
    app = server();
  t.after(() => app.close());
  await codingApi(app, f.c);
  const payload = {
    runtime_call_id: randomUUID(),
    model: settings.leaderModel ?? settings.model,
    messages: [{ role: "user", content: "Synthetic exact objective" }],
    tools: [],
    max_tokens: 8000,
    runtime_purpose: "agent",
    stream: false,
  };
  const send = (body = payload, parent?: string) =>
    app.inject({
      method: "POST",
      url: `/coding/worker/${job.id}/pi/coder/v1/chat/completions`,
      headers: {
        authorization: `Bearer ${f.c.token(job.id, job.attempt_id)}`,
        ...(parent ? { "x-runtime-retry-of": parent } : {}),
      },
      payload: body,
    });
  return { f, job, app, payload, send };
}

test("host terminal receipts cover rate limits and the explicit server-error allowlist", async (t) => {
  const { f, payload, send } = await setup(t);
  for (const status of [429, 500, 502, 503]) {
    f.setGeneration(() => {
      throw new ModelError("Synthetic terminal reply", true, {
        httpStatus: status,
      });
    });
    const id = randomUUID(),
      response = await send({ ...payload, runtime_call_id: id });
    assert.equal(response.statusCode, 409);
    assert.equal(
      response.json().code,
      status === 429 ? "model_rate_limited" : "model_transient_failure",
    );
    assert.equal(response.json().recovery.callId, id);
    assert.equal(response.json().recovery.providerStatus, status);
  }
  assert.equal(f.modelCalls(), 4);
});

test("Pi recovery uses two durable admissions, preserves failure and permits only one matching child", async (t) => {
  const { f, job, payload, send } = await setup(t);
  f.setGeneration(() => {
    throw new ModelError("Synthetic terminal failure", true, {
      httpStatus: 504,
    });
  });
  const first = await send();
  assert.equal(first.statusCode, 409);
  assert.deepEqual(first.json().recovery, {
    version: 1,
    kind: "terminal-provider-http",
    callId: payload.runtime_call_id,
    attemptId: job.attempt_id,
    providerStatus: 504,
  });
  assert.equal((await f.row(job.id)).model_busy, false);
  f.setGeneration(() => ({
    message: { role: "assistant", content: "Synthetic result" },
  }));
  for (const change of [
    { messages: [{ role: "user", content: "Changed objective" }] },
    { max_tokens: 4000 },
    { runtime_purpose: "compaction" },
  ]) {
    const rejected = await send(
      { ...payload, ...change, runtime_call_id: randomUUID() },
      payload.runtime_call_id,
    );
    assert.equal(rejected.statusCode, 409);
    assert.equal(rejected.json().recovery, undefined);
  }
  const child = { ...payload, runtime_call_id: randomUUID() };
  assert.equal((await send(child, payload.runtime_call_id)).statusCode, 200);
  assert.equal(
    (await send(child, payload.runtime_call_id)).statusCode,
    200,
    "exact child replay returns the retained result",
  );
  assert.equal(
    (
      await send(
        { ...payload, runtime_call_id: randomUUID() },
        payload.runtime_call_id,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await send(
        { ...payload, runtime_call_id: randomUUID() },
        child.runtime_call_id,
      )
    ).statusCode,
    409,
  );
  assert.equal(f.modelCalls(), 2);
  assert.equal((await f.row(job.id)).used_models, 2);
  const rows = (
    await f.db.query(
      "SELECT id,state,input FROM coding_model_calls WHERE job_id=$1 ORDER BY created_at,id",
      [job.id],
    )
  ).rows;
  assert.equal(rows.length, 2);
  assert.equal(
    rows.find((r) => r.id === payload.runtime_call_id).state,
    "uncertain",
  );
  assert.equal(
    rows.find((r) => r.id === child.runtime_call_id).input.retryOf,
    payload.runtime_call_id,
  );
});

test("a second terminal failure has no further recovery receipt", async (t) => {
  const { f, payload, send } = await setup(t);
  f.setGeneration(() => {
    throw new ModelError("Synthetic terminal failure", true, {
      httpStatus: 504,
    });
  });
  assert((await send()).json().recovery);
  const second = await send(
    { ...payload, runtime_call_id: randomUUID() },
    payload.runtime_call_id,
  );
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().recovery, undefined);
  assert.equal(f.modelCalls(), 2);
});

for (const scenario of [
  "cancel",
  "deadline",
  "superseded",
  "owner-revoked",
  "budget",
])
  test(`host recovery rechecks ${scenario}`, async (t) => {
    const { f, job, payload, send } = await setup(t);
    f.setGeneration(() => {
      throw new ModelError("Synthetic terminal failure", true, {
        httpStatus: 504,
      });
    });
    assert((await send()).json().recovery);
    if (scenario === "cancel")
      await f.c.call("a", f.run, { operation: "coding_cancel", id: job.id });
    if (scenario === "deadline") f.advance(24 * 60 * 60 * 1000);
    if (scenario === "superseded")
      await f.db.query("UPDATE coding_jobs SET attempt_id=$2 WHERE id=$1", [
        job.id,
        randomUUID(),
      ]);
    if (scenario === "owner-revoked") f.revoke();
    if (scenario === "budget")
      await f.db.query("UPDATE coding_jobs SET used_models=$2 WHERE id=$1", [
        job.id,
        settings.limits.models,
      ]);
    assert.notEqual(
      (
        await send(
          { ...payload, runtime_call_id: randomUUID() },
          payload.runtime_call_id,
        )
      ).statusCode,
      200,
    );
    assert.equal(f.modelCalls(), 1);
  });

for (const [name, diagnostics, transient] of [
  ["unknown transport", { failureCode: "transport" }, true],
  ["incomplete", { httpStatus: 504, failureCode: "incomplete" }, true],
  ["empty", { httpStatus: 504, failureCode: "empty" }, true],
  ["permanent", { httpStatus: 504 }, false],
  ["authentication", { httpStatus: 401 }, false],
] as const)
  test(`host excludes ${name} from recovery`, async (t) => {
    const { f, payload, send } = await setup(t);
    f.setGeneration(() => {
      throw new ModelError("Synthetic failure", transient, diagnostics);
    });
    const response = await send();
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().recovery, undefined);
    assert.equal(
      (
        await send(
          { ...payload, runtime_call_id: randomUUID() },
          payload.runtime_call_id,
        )
      ).statusCode,
      409,
    );
    assert.equal(f.modelCalls(), 1);
  });

for (const kind of ["failure-journal", "success-persistence"])
  test(`no recovery after ${kind} failure`, async (t) => {
    const { f, send } = await setup(t);
    const query = f.db.query.bind(f.db);
    f.db.query = async (sql: string, values?: unknown[]) => {
      if (
        kind === "failure-journal" &&
        sql.includes("INSERT INTO coding_events") &&
        values?.some(
          (v) => typeof v === "string" && v.includes("worker_request_rejected"),
        )
      )
        throw Error("Synthetic journal failure");
      if (
        kind === "success-persistence" &&
        sql.includes("UPDATE coding_model_calls SET state='complete'")
      )
        throw Error("Synthetic persistence failure");
      return query(sql, values);
    };
    f.setGeneration(() => {
      if (kind === "failure-journal")
        throw new ModelError("Synthetic terminal failure", true, {
          httpStatus: 504,
        });
      return {
        message: {
          role: "assistant",
          content: "Complete synthetic generation",
        },
      };
    });
    const response = await send();
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().recovery, undefined);
    assert.equal(f.modelCalls(), 1);
  });
