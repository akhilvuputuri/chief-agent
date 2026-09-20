import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  RoutineTools,
  RoutineScheduler,
  RoutineDelivery,
  dueWindow,
} from "../src/routines.js";
import { ScheduleParser } from "../src/schedule.js";
import { ensureUser, type Database } from "../src/db.js";
import { action } from "../src/protocol.js";
import { WorkWorker } from "../src/work-worker.js";
import { recoverRuntime } from "../src/execution.js";

async function fixture() {
  const pg = new PGlite();
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => /^\d.*sql$/.test(f))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + file, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "a");
  await ensureUser(db, "b");
  const run = randomUUID();
  await db.query(
    "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'a','schedule a routine')",
    [run],
  );
  const now = new Date();
  const tools = new RoutineTools(db, new ScheduleParser(() => now));
  const create = async (
    schedule = "every 1h",
    missedPolicy: "latest" | "skip" = "latest",
  ) =>
    tools.call("a", run, {
      operation: "routine_create",
      name: "Read updates",
      instruction:
        "Research updates using enabled specialists, cite evidence and report uncertainty.",
      schedule,
      missedPolicy,
    });
  return { pg, db, run, tools, create, now };
}
test("routines validate ownership, foreground authority and schedule changes", async () => {
  const f = await fixture();
  try {
    const r = await f.create();
    assert.equal(r.parsed.kind, "interval");
    await assert.rejects(() =>
      f.tools.call("b", f.run, {
        operation: "routine_update",
        id: r.id,
        status: "paused",
      }),
    );
    assert.deepEqual(
      await f.tools.call("b", f.run, {
        operation: "routine_history",
        id: r.id,
      }),
      [],
    );
    await assert.rejects(() => f.create("every 5m"), /hourly/);
    await f.db.query("UPDATE work_turns SET background=true WHERE run_id=$1", [
      f.run,
    ]);
    await assert.rejects(() => f.create(), /foreground/);
    await f.db.query("UPDATE work_turns SET background=false WHERE run_id=$1", [
      f.run,
    ]);
    const paused = await f.tools.call("a", f.run, {
      operation: "routine_update",
      id: r.id,
      status: "paused",
    });
    assert.equal(paused.status, "paused");
    const resumed = await f.tools.call("a", f.run, {
      operation: "routine_update",
      id: r.id,
      status: "scheduled",
      schedule: "daily at 11pm",
    });
    assert.equal(resumed.parsed.expr, "0 23 * * *");
    assert.throws(() =>
      action.parse({
        operation: "routine_create",
        name: "x",
        instruction: "x",
        schedule: "in 1h",
        user: "b",
      }),
    );
  } finally {
    await f.pg.close();
  }
});
test("due occurrences atomically create exact task snapshots once; overlap and downtime do not flood", async () => {
  const f = await fixture();
  try {
    const r = await f.create();
    const first = new Date(f.now.getTime() - 7200000);
    await f.db.query("UPDATE agent_routines SET next_run=$2 WHERE id=$1", [
      r.id,
      first,
    ]);
    const scheduler = new RoutineScheduler(
      f.db,
      () => true,
      () => f.now,
    );
    await Promise.all([scheduler.tick(), scheduler.tick()]);
    let o = (await f.db.query("SELECT * FROM routine_occurrences")).rows;
    assert.equal(o.length, 1);
    assert.equal(o[0].disposition, "launched");
    assert.ok(o[0].task_id);
    const t = (await f.db.query("SELECT * FROM work_tasks")).rows[0];
    assert.equal(t.status, "queued");
    assert.match(t.request, /Research updates/);
    assert.equal(
      (await f.db.query("SELECT * FROM work_revisions")).rows.length,
      1,
    );
    await f.tools.call("a", f.run, {
      operation: "routine_update",
      id: r.id,
      instruction: "Changed for future occurrences",
    });
    assert.match(
      (await f.db.query("SELECT request FROM work_tasks")).rows[0].request,
      /Research updates/,
    );
    await new RoutineScheduler(
      f.db,
      () => true,
      () => new Date(f.now.getTime() + 3600000),
    ).tick();
    o = (
      await f.db.query("SELECT * FROM routine_occurrences ORDER BY created_at")
    ).rows;
    assert.equal(o.length, 2);
    assert.equal(o[1].disposition, "overlap");
    assert.equal((await f.db.query("SELECT * FROM work_tasks")).rows.length, 1);
    const skip = await f.create("in 1h", "skip");
    await f.db.query("UPDATE agent_routines SET next_run=$2 WHERE id=$1", [
      skip.id,
      first,
    ]);
    await scheduler.tick();
    assert.equal(
      (
        await f.db.query(
          "SELECT disposition FROM routine_occurrences WHERE routine_id=$1",
          [skip.id],
        )
      ).rows[0].disposition,
      "missed",
    );
    assert.equal(
      (
        await f.db.query("SELECT status FROM agent_routines WHERE id=$1", [
          skip.id,
        ])
      ).rows[0].status,
      "completed",
    );
  } finally {
    await f.pg.close();
  }
});
test("scheduled work saves output then delivers independently; ambiguous sends never replay work", async () => {
  const f = await fixture();
  try {
    const r = await f.create("in 1h");
    await f.db.query(
      "UPDATE agent_routines SET next_run=now()-interval '1 minute' WHERE id=$1",
      [r.id],
    );
    await new RoutineScheduler(f.db, () => true).tick();
    let executions = 0,
      sends = 0;
    const delivery = new RoutineDelivery(f.db, async () => {
      sends++;
      throw new Error("ambiguous Telegram result");
    });
    const worker = new WorkWorker(
      f.db,
      async (user, id) => {
        executions++;
        const run = randomUUID();
        await f.db.query(
          "INSERT INTO runtime_runs(id,user_id,task_id,state,stop_reason) VALUES($1,$2,$3,'stopped','answer')",
          [run, user, id],
        );
        return { reply: "Saved report", runId: run };
      },
      async () => {
        throw Error("Must use durable delivery");
      },
      (user, id, p) => delivery.capture(user, id, p),
    );
    await worker.tick();
    assert.equal(sends, 0);
    assert.equal(
      (await f.db.query("SELECT status FROM work_tasks")).rows[0].status,
      "done",
    );
    assert.equal(
      (await f.db.query("SELECT state FROM routine_deliveries")).rows[0].state,
      "pending",
    );
    await delivery.tick();
    await delivery.tick();
    await worker.tick();
    assert.equal(executions, 1);
    assert.equal(sends, 1);
    assert.equal(
      (await f.db.query("SELECT state FROM routine_deliveries")).rows[0].state,
      "uncertain",
    );
    const history = await f.tools.call("a", f.run, {
      operation: "routine_history",
      id: r.id,
    });
    assert.equal(history[0].deliveries[0].result.reply, "Saved report");
    await f.db.query("UPDATE routine_deliveries SET state='sending'");
    await delivery.recover();
    assert.equal(
      (await f.db.query("SELECT state FROM routine_deliveries")).rows[0].state,
      "uncertain",
    );
  } finally {
    await f.pg.close();
  }
});
test("restart preserves occurrence and pauses execution instead of repeating uncertain writes", async () => {
  const f = await fixture();
  try {
    const r = await f.create();
    await f.db.query(
      "UPDATE agent_routines SET next_run=now()-interval '1 minute' WHERE id=$1",
      [r.id],
    );
    await new RoutineScheduler(f.db, () => true).tick();
    const task = (await f.db.query("SELECT * FROM work_tasks")).rows[0];
    const run = randomUUID();
    await f.db.query(
      "INSERT INTO runtime_runs(id,user_id,task_id) VALUES($1,$2,$3)",
      [run, "a", task.id],
    );
    await f.db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write) VALUES($1,$2,'1','calendar_draft','{}',true)",
      [randomUUID(), run],
    );
    await recoverRuntime(f.db);
    assert.equal(
      (await f.db.query("SELECT pause_reason FROM work_tasks")).rows[0]
        .pause_reason,
      "uncertain_write",
    );
    await new RoutineScheduler(f.db, () => true).tick();
    assert.equal((await f.db.query("SELECT * FROM work_tasks")).rows.length, 1);
  } finally {
    await f.pg.close();
  }
});
test("time calculation preserves phase and Singapore cron with latest-only catch-up", () => {
  const f = new Date("2026-09-19T15:00:00Z"),
    now = new Date("2026-09-20T15:03:00Z");
  const a = dueWindow({ kind: "cron", expr: "0 23 * * *" }, f, now);
  assert.equal(a.due.toISOString(), "2026-09-20T15:00:00.000Z");
  assert.equal(a.next!.toISOString(), "2026-09-21T15:00:00.000Z");
  const b = dueWindow({ kind: "interval", minutes: 60 }, f, now);
  assert.equal(b.next!.toISOString(), "2026-09-20T16:00:00.000Z");
});

test("real Assistant keeps scheduled instruction isolated and preserves an approval pause", async () => {
  const { Assistant } = await import("../src/agent.js");
  const { JobTools } = await import("../src/tools.js");
  const f = await fixture();
  try {
    const r = await f.create();
    await f.db.query(
      "UPDATE agent_routines SET next_run=now()-interval '1 minute' WHERE id=$1",
      [r.id],
    );
    await new RoutineScheduler(f.db, () => true).tick();
    const task = (await f.db.query("SELECT * FROM work_tasks")).rows[0];
    const assistant = new Assistant(
      f.db,
      {
        run: async (req) => {
          assert.equal(req.history.length, 0);
          const ctx = JSON.parse(req.runtime!.context);
          assert.equal(ctx.work.task.id, task.id);
          assert.match(ctx.work.task.request, /Research updates/);
          assert.equal(ctx.conversation.lane, "job");
          await assert.rejects(
            () =>
              req.execute!({
                operation: "routine_create",
                name: "Recursive",
                instruction: "again",
                schedule: "every 1h",
                missedPolicy: "latest",
              }),
            /foreground/,
          );
          await f.db.query(
            "INSERT INTO approvals(id,user_id,run_id,operation,payload,expires_at) VALUES($1,'a',$2,'calendar_create','{}',now()+interval '15 minutes')",
            [randomUUID(), req.runId],
          );
          return {
            reply: "Please approve the draft.",
            history: [],
            stopReason: "answer",
          };
        },
      },
      new JobTools(f.db, { call: async () => ({}) }),
      { web: false },
    );
    const delivery = new RoutineDelivery(f.db, async () => {});
    const worker = new WorkWorker(
      f.db,
      (u, id) => assistant.resumeDetailed(u, id),
      async () => {},
      (u, id, p) => delivery.capture(u, id, p),
    );
    await worker.tick();
    const saved = (await f.db.query("SELECT * FROM work_tasks")).rows[0];
    assert.equal(saved.status, "paused");
    assert.equal(saved.pause_reason, "awaiting_approval");
    assert.equal(
      (await f.db.query("SELECT * FROM agent_routines")).rows.length,
      1,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int AS count FROM routine_deliveries",
        )
      ).rows[0].count,
      1,
    );
    assert.equal(
      (await f.db.query("SELECT data FROM events WHERE type='history.loaded'"))
        .rows[0].data.source,
      "task_run",
    );
  } finally {
    await f.pg.close();
  }
});

test("editing a routine cannot rewind a concurrently advanced occurrence", async () => {
  const f = await fixture();
  try {
    const r = await f.create("in 1h");
    await f.db.query(
      "UPDATE agent_routines SET next_run=now()-interval '1 minute' WHERE id=$1",
      [r.id],
    );
    let interleaved = false;
    const wrapped = {
      query: async (sql: string, values?: unknown[]) => {
        const result = await f.db.query(sql, values);
        if (
          !interleaved &&
          sql.startsWith("SELECT * FROM agent_routines WHERE id=")
        ) {
          interleaved = true;
          await new RoutineScheduler(f.db, () => true).tick();
          await f.db.query("UPDATE work_tasks SET status='done'");
        }
        return result;
      },
    } as Database;
    await assert.rejects(
      () =>
        new RoutineTools(wrapped).call("a", f.run, {
          operation: "routine_update",
          id: r.id,
          name: "Renamed",
        }),
      /changed concurrently/,
    );
    await new RoutineScheduler(f.db, () => true).tick();
    assert.equal(
      (await f.db.query("SELECT * FROM routine_occurrences")).rows.length,
      1,
    );
    assert.equal(
      (await f.db.query("SELECT status FROM agent_routines")).rows[0].status,
      "completed",
    );
  } finally {
    await f.pg.close();
  }
});
test("revoked owners cannot starve the bounded scheduler scan", async () => {
  const f = await fixture();
  try {
    const r = await f.create("in 1h");
    await f.db.query(
      "UPDATE agent_routines SET next_run=now()-interval '1 minute' WHERE id=$1",
      [r.id],
    );
    for (let i = 0; i < 20; i++)
      await f.db.query(
        "INSERT INTO agent_routines(id,user_id,name,instruction,schedule,parsed,next_run) VALUES($1,'b','Revoked','No access','in 1h','{\"kind\":\"once\"}',now()-interval '1 day')",
        [randomUUID()],
      );
    const scheduler = new RoutineScheduler(f.db, (u) => u === "a");
    await scheduler.tick();
    await scheduler.tick();
    assert.equal(
      (await f.db.query("SELECT * FROM work_tasks WHERE user_id='a'")).rows
        .length,
      1,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM work_tasks WHERE user_id='b'")).rows
        .length,
      0,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT * FROM agent_routines WHERE user_id='b' AND status='paused'",
        )
      ).rows.length,
      20,
    );
  } finally {
    await f.pg.close();
  }
});
