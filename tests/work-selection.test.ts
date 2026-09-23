import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Database } from "../src/db.js";
import { Execution, recoverRuntime } from "../src/execution.js";
import { WorkTools, renderWork, renderWorkList } from "../src/work.js";

const steps = [
  {
    key: "check",
    title: "Check the source",
    verification: "evidence" as const,
  },
];

async function fixture() {
  const pg = new PGlite();
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL(`../db/${file}`, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES('owner'),('other')");
  const work = new WorkTools(db);
  async function turn(user = "owner") {
    const run = randomUUID();
    await db.query(
      "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,$2,'Current request')",
      [run, user],
    );
    return run;
  }
  async function start(objective: string, user = "owner", run?: string) {
    run ??= await turn(user);
    const snapshot = await work.call(user, run, {
      operation: "work_start",
      objective,
      steps,
    });
    return { id: snapshot.task.id as string, run, snapshot };
  }
  return { pg, db, work, turn, start };
}

test("work status lists brief owner jobs and explicit reads never bind foreground work", async () => {
  const f = await fixture();
  try {
    const one = await f.start("First independent job");
    const two = await f.start("Second independent job");
    const other = await f.start("Private other-owner job", "other");
    const run = await f.turn();
    const jobs = await f.work.call("owner", run, { operation: "work_status" });
    assert.deepEqual(
      new Set(jobs.map((job: any) => job.id)),
      new Set([one.id, two.id]),
    );
    assert(
      jobs.every(
        (job: any) =>
          !Object.hasOwn(job, "request") &&
          !Object.hasOwn(job, "steps") &&
          !Object.hasOwn(job, "evidence"),
      ),
    );
    const exact = await f.work.call("owner", run, {
      operation: "work_status",
      id: one.id,
    });
    assert.equal(exact.task.id, one.id);
    assert.equal(
      await f.work.call("owner", run, {
        operation: "work_status",
        id: other.id,
      }),
      null,
    );
    assert.equal(
      (
        await f.db.query("SELECT task_id FROM work_turns WHERE run_id=$1", [
          run,
        ])
      ).rows[0].task_id,
      null,
    );
    const list = renderWorkList(jobs);
    assert.match(
      list,
      /across conversations \(not necessarily the latest request\)/,
    );
    assert(list.includes(`/continue ${one.id}`));
    assert(list.includes(`/cancel ${two.id}`));
    assert(!list.includes(other.id));
    assert(renderWork(exact).includes(`/cancel ${one.id}`));
  } finally {
    await f.pg.close();
  }
});

test("starting another task cannot replace a turn's established task, including concurrent starts", async () => {
  const f = await fixture();
  try {
    const run = await f.turn();
    const attempts = await Promise.allSettled([
      f.start("First", "owner", run),
      f.start("Second", "owner", run),
    ]);
    assert.equal(
      attempts.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      (await f.db.query("SELECT id FROM work_tasks")).rows.length,
      1,
    );
    const selected = (
      await f.db.query("SELECT task_id FROM work_turns WHERE run_id=$1", [run])
    ).rows[0].task_id;
    await assert.rejects(
      () => f.start("Replacement", "owner", run),
      /already bound/,
    );
    assert.equal(
      (
        await f.db.query("SELECT task_id FROM work_turns WHERE run_id=$1", [
          run,
        ])
      ).rows[0].task_id,
      selected,
    );
    const background = await f.turn();
    await f.db.query("UPDATE work_turns SET background=true WHERE run_id=$1", [
      background,
    ]);
    await assert.rejects(
      () => f.start("Unrequested child job", "owner", background),
      /foreground/,
    );
  } finally {
    await f.pg.close();
  }
});

test("a foreground revision binds its explicit paused job and cannot switch to another job", async () => {
  const f = await fixture();
  try {
    const one = await f.start("Paused research");
    const two = await f.start("Other independent research");
    const run = await f.turn();
    await f.db.query("UPDATE work_tasks SET status='paused' WHERE id=$1", [
      one.id,
    ]);
    const revised = await f.work.call("owner", run, {
      operation: "work_revise",
      id: one.id,
      objective: "Explicit updated scope",
      steps,
    });
    assert.equal(revised.task.revision, 2);
    assert.equal(revised.task.id, one.id);
    assert.equal(
      (
        await f.db.query("SELECT task_id FROM work_turns WHERE run_id=$1", [
          run,
        ])
      ).rows[0].task_id,
      one.id,
    );
    await assert.rejects(
      () =>
        f.work.call("owner", run, {
          operation: "work_revise",
          id: two.id,
          objective: "Wrong job",
          steps,
        }),
      /another task/,
    );
    assert.equal((await f.work.snapshot("owner", two.id))?.task.revision, 1);
    await assert.rejects(
      () =>
        f.work.call("owner", one.run, {
          operation: "work_revise",
          id: one.id,
          objective: "Stale revision",
          steps,
        }),
      /scope changed/,
    );
    await f.db.query("UPDATE work_tasks SET status='paused' WHERE id=$1", [
      one.id,
    ]);
    assert(
      renderWork(await f.work.snapshot("owner", one.id)).includes(
        `/continue ${one.id}`,
      ),
    );
  } finally {
    await f.pg.close();
  }
});

test("revision cannot steal running, leased, or otherwise live work", async () => {
  const f = await fixture();
  try {
    const task = await f.start("Protected work");
    const run = await f.turn();
    const revise = () =>
      f.work.call("owner", run, {
        operation: "work_revise",
        id: task.id,
        objective: "Changed",
        steps,
      });
    await f.db.query("UPDATE work_tasks SET status='running' WHERE id=$1", [
      task.id,
    ]);
    await assert.rejects(revise, /running, leased/);
    const lease = randomUUID();
    await f.db.query(
      "UPDATE work_tasks SET status='active',lease=$2 WHERE id=$1",
      [task.id, lease],
    );
    await assert.rejects(revise, /running, leased/);
    assert.equal((await f.work.snapshot("owner", task.id))?.task.lease, lease);
    await f.db.query("UPDATE work_tasks SET lease=NULL WHERE id=$1", [task.id]);
    const activeRun = randomUUID();
    await f.db.query(
      "INSERT INTO runtime_runs(id,user_id,task_id) VALUES($1,'owner',$2)",
      [activeRun, task.id],
    );
    await assert.rejects(revise, /running, leased/);
    assert.equal(
      (
        await f.db.query("SELECT task_id FROM work_turns WHERE run_id=$1", [
          run,
        ])
      ).rows[0].task_id,
      null,
    );
    assert.equal((await f.work.snapshot("owner", task.id))?.task.revision, 1);
    await f.db.query("UPDATE runtime_runs SET state='stopped' WHERE id=$1", [
      activeRun,
    ]);
    assert.equal((await revise()).task.revision, 2);
  } finally {
    await f.pg.close();
  }
});

test("execution charges only explicit selections once and refuses task switching", async () => {
  const f = await fixture();
  try {
    const old = await f.start("Unrelated old work");
    const run = await f.turn();
    const execution = new Execution(
      f.db,
      "owner",
      run,
      new AbortController().signal,
      { ms: 10000, models: 6, tools: 9 },
    );
    await execution.start();
    await execution.consume("models");
    await execution.elapsed(100);
    await f.work.call("owner", run, { operation: "work_status", id: old.id });
    await execution.attach(true);
    assert.equal(
      (await f.db.query("SELECT task_id FROM runtime_runs WHERE id=$1", [run]))
        .rows[0].task_id,
      null,
    );
    assert.equal((await f.work.snapshot("owner", old.id))?.task.used_models, 0);
    const selected = await f.start("Explicit current job", "owner", run);
    await Promise.all([execution.attach(), execution.attach()]);
    const charged = (await f.work.snapshot("owner", selected.id))!.task;
    assert.equal(charged.used_models, 1);
    assert.equal(Number(charged.used_ms), 100);
    assert.equal(charged.budget_models, 6);
    await execution.consume("models");
    assert.equal(
      (await f.work.snapshot("owner", selected.id))?.task.used_models,
      2,
    );
    await f.db.query("UPDATE work_turns SET task_id=$2 WHERE run_id=$1", [
      run,
      old.id,
    ]);
    await assert.rejects(() => execution.attach(), /refusing to switch/);
    assert.equal(
      (await f.db.query("SELECT task_id FROM runtime_runs WHERE id=$1", [run]))
        .rows[0].task_id,
      selected.id,
    );
    assert.equal((await f.work.snapshot("owner", old.id))?.task.used_models, 0);
  } finally {
    await f.pg.close();
  }
});

test("execution refuses another owner's task even when its turn row is malformed", async () => {
  const f = await fixture();
  try {
    const other = await f.start("Private job", "other");
    const run = await f.turn();
    await f.db.query(
      "UPDATE work_turns SET task_id=$2,background=true WHERE run_id=$1",
      [run, other.id],
    );
    const execution = new Execution(
      f.db,
      "owner",
      run,
      new AbortController().signal,
    );
    await assert.rejects(() => execution.start(), /owner/);
    assert.equal(
      (await f.db.query("SELECT task_id FROM runtime_runs WHERE id=$1", [run]))
        .rows[0].task_id,
      null,
    );
    assert.equal(
      (await f.work.snapshot("other", other.id))?.task.budget_initialized,
      false,
    );
  } finally {
    await f.pg.close();
  }
});

test("yield retains allocation-based continuation and recovery never replays queued chat input", async () => {
  const f = await fixture();
  try {
    const task = await f.start("Long-running job");
    await f.db.query("UPDATE work_tasks SET passes=8 WHERE id=$1", [task.id]);
    assert.deepEqual(
      await f.work.call("owner", task.run, {
        operation: "work_yield",
        id: task.id,
      }),
      { checkpointed: true },
    );
    assert.equal(
      (await f.work.snapshot("owner", task.id))?.task.status,
      "queued",
    );
    for (const state of ["queued", "running", "completed", "interrupted"])
      await f.db.query(
        "INSERT INTO conversation_inputs(id,user_id,message,state) VALUES($1,'owner',$2,$2)",
        [randomUUID(), state],
      );
    await recoverRuntime(f.db);
    const inputs = (
      await f.db.query(
        "SELECT message,state,finished_at FROM conversation_inputs",
      )
    ).rows;
    assert(
      inputs
        .filter((input) => ["queued", "running"].includes(input.message))
        .every((input) => input.state === "failed" && input.finished_at),
    );
    assert(
      inputs
        .filter((input) => ["completed", "interrupted"].includes(input.message))
        .every((input) => input.state === input.message),
    );
    assert.equal(
      (await f.work.snapshot("owner", task.id))?.task.status,
      "paused",
    );
    const run = await f.turn();
    const another = await f.start("Another job");
    await f.work.call("owner", run, { operation: "work_cancel", id: task.id });
    assert.equal(
      (await f.work.snapshot("owner", task.id))?.task.status,
      "cancelled",
    );
    assert.equal(
      (await f.work.snapshot("owner", another.id))?.task.status,
      "active",
    );
  } finally {
    await f.pg.close();
  }
});
