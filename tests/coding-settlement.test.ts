import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { settleUncertainCoding } from "../src/execution.js";
import { toolError, WriteBlockedError } from "../src/tool-errors.js";
async function fixture() {
  const pg = new PGlite();
  for (const f of [
    "001_initial",
    "002_preparation",
    "003_skills",
    "004_daily",
    "005_work",
    "006_runtime",
    "009_calendar_approval",
    "024_coding",
  ])
    await pg.exec(
      await readFile(new URL(`../db/${f}.sql`, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  await ensureUser(db, "456");
  const job = async (user = "123", requestKey = randomUUID()) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO coding_jobs(id,user_id,request_key,request_hash,origin_run,objective,context,mode,base_sha,settings,state)
       VALUES($1,$2,$3,'h',$4,'objective','context','plan',$5,'{}','plan_ready')`,
      [id, user, requestKey, randomUUID(), "a".repeat(40)],
    );
    return id;
  };
  /** A stopped (or running) run holding one uncertain coding call started `age` ago. */
  const call = async ({
    user = "123",
    operation = "coding_reply",
    args = {} as Record<string, unknown>,
    raw = undefined as string | undefined,
    runState = "stopped",
    age = "10 minutes",
  } = {}) => {
    const run = randomUUID(),
      id = randomUUID();
    await db.query(
      "INSERT INTO runtime_runs(id,user_id,state,stop_reason) VALUES($1,$2,$3,'failed')",
      [run, user, runState],
    );
    await db.query(
      `INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result,started_at,finished_at)
       VALUES($1,$2,'c',$3,$4::jsonb,true,'uncertain','{"error":{"code":"TOOL_FAILED"}}',now()-$5::interval,now()-$5::interval)`,
      [
        id,
        run,
        operation,
        JSON.stringify({ raw: raw ?? JSON.stringify(args) }),
        age,
      ],
    );
    return { run, id };
  };
  const state = async (id: string) =>
    (await db.query("SELECT state,result FROM runtime_calls WHERE id=$1", [id]))
      .rows[0];
  const reconciled = async (run: string) =>
    (
      await db.query(
        "SELECT data FROM events WHERE run_id=$1 AND type='runtime.call_reconciled'",
        [run],
      )
    ).rows.map((r) => r.data);
  return { db, job, call, state, reconciled };
}
test("a coding_reply that saved no revision for its request key settles as failed, keeping its error", async () => {
  const f = await fixture();
  const jobId = await f.job();
  const { run, id } = await f.call({
    args: { id: jobId, requestKey: "k1", baseRevision: 1, message: "m" },
  });
  assert.equal(await settleUncertainCoding(f.db, "123"), 1);
  const row = await f.state(id);
  assert.equal(row.state, "failed");
  assert.equal(row.result.error.code, "TOOL_FAILED");
  assert.equal(row.result.reconciliation.to, "failed");
  assert.deepEqual(await f.reconciled(run), [
    { id, operation: "coding_reply" },
  ]);
});
test("a coding_reply whose revision exists stays uncertain for an operator", async () => {
  const f = await fixture();
  const jobId = await f.job();
  await f.db.query(
    "INSERT INTO coding_revisions(job_id,revision,request_key,message,mode) VALUES($1,2,'k1','m','plan')",
    [jobId],
  );
  const { id } = await f.call({ args: { id: jobId, requestKey: "k1" } });
  assert.equal(await settleUncertainCoding(f.db, "123"), 0);
  assert.equal((await f.state(id)).state, "uncertain");
});
test("coding_start settles only when no job carries its request key", async () => {
  const f = await fixture();
  await f.job("123", "taken");
  const kept = await f.call({
    operation: "coding_start",
    args: { requestKey: "taken" },
  });
  const settled = await f.call({
    operation: "coding_start",
    args: { requestKey: "free" },
  });
  assert.equal(await settleUncertainCoding(f.db, "123"), 1);
  assert.equal((await f.state(kept.id)).state, "uncertain");
  assert.equal((await f.state(settled.id)).state, "failed");
});
test("coding_resume stays uncertain when a continue event or requirements card used its key", async () => {
  const f = await fixture();
  const jobId = await f.job();
  await f.db.query(
    "INSERT INTO coding_events(job_id,event_key,payload) VALUES($1,'continue:c1','{}'),($1,'requirements:3:r1','{}')",
    [jobId],
  );
  const cont = await f.call({
    operation: "coding_resume",
    args: { id: jobId, requestKey: "c1" },
  });
  const card = await f.call({
    operation: "coding_resume",
    args: { id: jobId, requestKey: "r1" },
  });
  const free = await f.call({
    operation: "coding_resume",
    args: { id: jobId, requestKey: "x1" },
  });
  assert.equal(await settleUncertainCoding(f.db, "123"), 1);
  assert.equal((await f.state(cont.id)).state, "uncertain");
  assert.equal((await f.state(card.id)).state, "uncertain");
  assert.equal((await f.state(free.id)).state, "failed");
});
test("running runs, recent calls, other owners, other operations and unreadable arguments are left alone", async () => {
  const f = await fixture();
  const jobId = await f.job();
  const args = { id: jobId, requestKey: "k" };
  const running = await f.call({ args, runState: "running" });
  const recent = await f.call({ args, age: "30 seconds" });
  const other = await f.call({ args, user: "456" });
  const cancel = await f.call({ operation: "coding_cancel", args });
  const broken = await f.call({ raw: "{not json" });
  const noKey = await f.call({ args: { id: jobId } });
  assert.equal(await settleUncertainCoding(f.db, "123"), 0);
  for (const c of [running, recent, other, cancel, broken, noKey])
    assert.equal((await f.state(c.id)).state, "uncertain");
});
test("a refused write is reported as WRITE_BLOCKED, telling the model not to retry", () => {
  const e = toolError(
    new WriteBlockedError(
      "An uncertain write requires inspection before further writes",
    ),
  );
  assert.equal(e.code, "WRITE_BLOCKED");
  assert.equal(e.retryable, false);
  assert.match(e.message, /writes\. No further writes run in this request/);
  assert.match(e.message, /Do not retry/);
});
