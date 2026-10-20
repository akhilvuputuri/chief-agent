import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { codingApi } from "../src/coding/api.js";
import { server } from "../src/server.js";
import { rejectionReason } from "../src/coding/rejection-reason.js";
import { fixture } from "./helpers/coding-fixture.js";
import { sanitize } from "../src/ops-log.js";

test("a refused model request records which condition refused it", async (t) => {
  const f = await fixture(t);
  const job: any = await f.start("rejection-reason", "plan");
  await f.c.tick();
  const active = await f.row(job.id);
  await f.c.heartbeat(active);
  const token = (f.c as any).token(job.id, active.attempt_id);
  const app = await server({} as any);
  t.after(() => app.close());
  await codingApi(app, f.c);
  const call = () =>
    app.inject({
      method: "POST",
      url: `/coding/worker/${job.id}/model`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        callId: randomUUID(),
        role: "coder",
        messages: [{ role: "user", content: "Synthetic task" }],
        tools: [],
      },
    });
  for (const [setup, reason] of [
    ["UPDATE coding_jobs SET model_busy=true WHERE id=$1", "model_slot_busy"],
    [
      "UPDATE coding_jobs SET model_busy=false,used_models=(settings->'limits'->>'models')::int WHERE id=$1",
      "model_allocation_exhausted",
    ],
  ] as const) {
    await f.db.query(setup, [job.id]);
    const refused = await call();
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().code, "worker_request_rejected");
    const status: any = await f.c.status("a", job.id);
    assert.equal(status.lastFailure.reason, reason);
  }
});

test("only the host's own fixed messages map to reasons; anything else is unclassified", () => {
  assert.equal(
    rejectionReason(new Error("Another model request is already in flight")),
    "model_slot_busy",
  );
  assert.equal(
    rejectionReason(new Error("Model request key conflict")),
    "model_key_conflict",
  );
  assert.equal(
    rejectionReason(new Error("private upstream text /home/x")),
    "unclassified",
  );
  assert.equal(rejectionReason("not an error"), "unclassified");
});

test("after a restart, a model call cut off mid-way frees the job's model slot", async (t) => {
  const f = await fixture(t);
  const job: any = await f.start("restart-mid-call", "plan");
  await f.c.tick();
  const active = await f.row(job.id);
  // The gateway stopped during a call: slot held, ledger row still pending.
  await f.db.query("UPDATE coding_jobs SET model_busy=true WHERE id=$1", [
    job.id,
  ]);
  const cut = randomUUID();
  await f.db.query(
    "INSERT INTO coding_model_calls(id,job_id,attempt_id,role,request_hash,input) VALUES($1,$2,$3,'coder','h','{}'::jsonb)",
    [cut, job.id, active.attempt_id],
  );
  await f.c.recoverModels();
  assert.equal((await f.row(job.id)).model_busy, false);
  assert.equal(
    (
      await f.db.query("SELECT state FROM coding_model_calls WHERE id=$1", [
        cut,
      ])
    ).rows[0].state,
    "uncertain",
  );
});

test("the refusal reason survives the operational log allowlist", () => {
  const line: any = sanitize("coding.request_rejected", "warn", {
    taskId: randomUUID(),
    phase: "model",
    errorCode: "worker_request_rejected",
    httpStatus: 409,
    reason: "model_slot_busy",
  });
  assert.equal(line.reason, "model_slot_busy");
  assert.equal(line.dropped, undefined);
});
