import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { settleUncertainDrafts } from "../src/execution.js";
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
  ])
    await pg.exec(
      await readFile(new URL(`../db/${f}.sql`, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  await ensureUser(db, "456");
  /** A stopped (or running) run holding one uncertain call started `age` ago. */
  const call = async ({
    user = "123",
    operation = "calendar_draft",
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
       VALUES($1,$2,'c',$3,'{}',true,'uncertain','{"error":{"code":"TOOL_FAILED"}}',now()-$4::interval,now()-$4::interval)`,
      [id, run, operation, age],
    );
    // JobTools.execute records a failed receipt when the draft throws.
    await db.query(
      "INSERT INTO tool_receipts(id,user_id,run_id,operation,status) VALUES($1,$2,$3,'calendar_draft','failed')",
      [randomUUID(), user, run],
    );
    return { run, id, user };
  };
  /** An earlier successful draft call in `run`, with the approval and receipt it accounts for. */
  const earlierDraft = async (run: string) => {
    const approval = randomUUID(),
      receipt = randomUUID();
    await db.query(
      "INSERT INTO approvals(id,user_id,run_id,operation,payload) VALUES($1,'123',$2,'calendar_create','{}')",
      [approval, run],
    );
    await db.query(
      "INSERT INTO tool_receipts(id,user_id,run_id,operation,status) VALUES($1,'123',$2,'calendar_draft','success')",
      [receipt, run],
    );
    await db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result) VALUES($1,$2,'earlier','calendar_draft','{}',true,'success',$3::jsonb)",
      [
        randomUUID(),
        run,
        JSON.stringify({
          result: { approvalId: approval },
          receiptId: receipt,
        }),
      ],
    );
  };
  const state = async (id: string) =>
    (await db.query("SELECT state,result FROM runtime_calls WHERE id=$1", [id]))
      .rows[0];
  return { pg, db, call, state, earlierDraft };
}
test("an uncertain calendar_draft that saved nothing settles as failed, keeping its error", async () => {
  const f = await fixture();
  try {
    const c = await f.call();
    assert.equal(await settleUncertainDrafts(f.db, "123"), 1);
    const row = await f.state(c.id);
    assert.equal(row.state, "failed");
    assert.equal(row.result.error.code, "TOOL_FAILED");
    assert.equal(row.result.reconciliation.from, "uncertain");
    const events = await f.db.query(
      "SELECT data FROM events WHERE run_id=$1 AND type='runtime.call_reconciled'",
      [c.run],
    );
    assert.deepEqual(events.rows[0].data, {
      id: c.id,
      operation: "calendar_draft",
    });
    assert.equal(await settleUncertainDrafts(f.db, "123"), 0);
  } finally {
    await f.pg.close();
  }
});
test("draft settlement refuses anything it cannot prove saved nothing", async () => {
  const f = await fixture();
  try {
    const running = await f.call({ runState: "running" });
    const recent = await f.call({ age: "30 seconds" });
    const otherWrite = await f.call({ operation: "memory_set" });
    const otherOwner = await f.call({ user: "456" });
    const approved = await f.call();
    // Dated before the call started: timestamps are not trusted, only accounting.
    await f.db.query(
      "INSERT INTO approvals(id,user_id,run_id,operation,payload,created_at) VALUES($1,'123',$2,'calendar_create','{}',now()-interval '1 hour')",
      [randomUUID(), approved.run],
    );
    const receipted = await f.call();
    await f.db.query(
      "INSERT INTO tool_receipts(id,user_id,run_id,operation,status,created_at) VALUES($1,'123',$2,'calendar_draft','success',now()-interval '1 hour')",
      [randomUUID(), receipted.run],
    );
    assert.equal(await settleUncertainDrafts(f.db, "123"), 0);
    for (const c of [
      running,
      recent,
      otherWrite,
      otherOwner,
      approved,
      receipted,
    ])
      assert.equal((await f.state(c.id)).state, "uncertain");
  } finally {
    await f.pg.close();
  }
});
test("records a successful draft call accounts for, or other operations, do not hold it", async () => {
  const f = await fixture();
  try {
    const c = await f.call();
    await f.earlierDraft(c.run);
    await f.db.query(
      "INSERT INTO approvals(id,user_id,run_id,operation,payload) VALUES($1,'123',$2,'job_delete','{}')",
      [randomUUID(), c.run],
    );
    assert.equal(await settleUncertainDrafts(f.db, "123"), 1);
    assert.equal((await f.state(c.id)).state, "failed");
  } finally {
    await f.pg.close();
  }
});
test("the two-minute margin is measured from when the call started", async () => {
  const f = await fixture();
  try {
    const early = await f.call({ age: "110 seconds" });
    const late = await f.call({ age: "130 seconds" });
    assert.equal(await settleUncertainDrafts(f.db, "123"), 1);
    assert.equal((await f.state(early.id)).state, "uncertain");
    assert.equal((await f.state(late.id)).state, "failed");
  } finally {
    await f.pg.close();
  }
});
