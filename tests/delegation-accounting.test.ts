import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Database } from "../src/db.js";
import { Execution, recoverRuntime } from "../src/execution.js";
import { Spending, spending } from "../src/spending.js";
import { WebTools } from "../src/providers.js";
async function fixture() {
  const pg = new PGlite();
  for (const f of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + f, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await db.query("INSERT INTO users(id) VALUES('owner'),('other')");
  const task = randomUUID(),
    rootId = randomUUID();
  await db.query(
    "INSERT INTO work_tasks(id,user_id,objective,request,status) VALUES($1,'owner','test','test','active')",
    [task],
  );
  await db.query(
    "INSERT INTO work_turns(run_id,user_id,request,task_id,background) VALUES($1,'owner','test',$2,true)",
    [rootId, task],
  );
  const root = new Execution(db, "owner", rootId, new AbortController().signal);
  await root.start();
  const child = async (user = "owner", parentId = rootId) => {
    const x = new Execution(
      db,
      user,
      randomUUID(),
      root.signal,
      { ms: 120000, models: 8, tools: 20 },
      user === "owner" ? root : undefined,
    );
    await x.start();
    await x.trace("research.child_started", { parentRunId: parentId });
    return x;
  };
  return { pg, db, root, child, task };
}
async function savedSearch(
  db: Database,
  run: string,
  content: string,
  age = "0 minutes",
  cacheHit = false,
) {
  await db.query(
    "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result,started_at) VALUES($1::uuid,$2,$1::uuid::text,'web_search',$3,false,'success',$4,now()-$5::interval)",
    [
      randomUUID(),
      run,
      JSON.stringify({ raw: JSON.stringify({ query: "Example Query" }) }),
      JSON.stringify({ result: { content, cacheHit } }),
      age,
    ],
  );
}
test("normalized searches reuse parent, sibling and task context without crossing owner/unrelated runs or expiry", async () => {
  const f = await fixture(),
    web = new WebTools("");
  try {
    const first = await f.child(),
      second = await f.child();
    await savedSearch(f.db, f.root.run, "parent");
    const lookup = (r: Execution) =>
      spending.run(new Spending(f.db, r.user, r.run), () =>
        web.call("web_search", " EXAMPLE   query "),
      );
    assert.equal((await lookup(first)).content, "parent");
    await f.db.query("DELETE FROM runtime_calls");
    await savedSearch(f.db, first.run, "sibling");
    assert.equal((await lookup(second)).content, "sibling");
    assert.equal((await lookup(f.root)).content, "sibling");
    const later = new Execution(f.db, "owner", randomUUID(), f.root.signal);
    await f.db.query(
      "INSERT INTO work_turns(run_id,user_id,request,task_id,background) VALUES($1,'owner','test',$2,true)",
      [later.run, f.task],
    );
    await later.start();
    assert.equal((await lookup(later)).content, "sibling");
    const other = await f.child("other");
    await assert.rejects(() => lookup(other), /not configured/);
    const unrelated = new Execution(f.db, "owner", randomUUID(), f.root.signal);
    await unrelated.start();
    await assert.rejects(() => lookup(unrelated), /not configured/);
    await f.db.query("DELETE FROM runtime_calls");
    await savedSearch(f.db, first.run, "expired", "2 hours");
    await assert.rejects(() => lookup(second), /not configured/);
    await f.db.query("DELETE FROM runtime_calls");
    await savedSearch(f.db, first.run, "copy", "0 minutes", true);
    await assert.rejects(() => lookup(second), /not configured/);
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM provider_charges")).rows[0]
        .n,
      0,
    );
  } finally {
    await f.pg.close();
  }
});
test("child elapsed time is durable before parent completion and recovery does not discard it", async () => {
  const f = await fixture();
  try {
    const child = await f.child();
    await f.root.beginCall("delegate", "research_delegate", {});
    await child.elapsed(90000);
    await child.consume("models");
    assert.equal(
      Number(
        (
          await f.db.query("SELECT used_ms FROM work_tasks WHERE id=$1", [
            f.task,
          ])
        ).rows[0].used_ms,
      ),
      90000,
    );
    assert.equal((await child.remaining()).ms, 30000);
    await recoverRuntime(f.db);
    const row = (
      await f.db.query("SELECT used_ms,status FROM work_tasks WHERE id=$1", [
        f.task,
      ])
    ).rows[0];
    assert(Number(row.used_ms) >= 90000 && Number(row.used_ms) < 92000);
    assert.equal(row.status, "paused");
    const before = Number(row.used_ms);
    await recoverRuntime(f.db);
    assert.equal(
      Number(
        (
          await f.db.query("SELECT used_ms FROM work_tasks WHERE id=$1", [
            f.task,
          ])
        ).rows[0].used_ms,
      ),
      before,
    );
  } finally {
    await f.pg.close();
  }
});
test("successful delegation charges child work and parent overhead once across successive children", async () => {
  const f = await fixture();
  try {
    await f.root.elapsed(5000);
    const first = await f.child();
    await first.elapsed(90000);
    await f.root.elapsed(95000);
    const second = await f.child();
    await second.elapsed(10000);
    await f.root.elapsed(12000);
    assert.equal(
      Number(
        (
          await f.db.query("SELECT used_ms FROM runtime_runs WHERE id=$1", [
            f.root.run,
          ])
        ).rows[0].used_ms,
      ),
      112000,
    );
    assert.equal(
      Number(
        (
          await f.db.query("SELECT used_ms FROM work_tasks WHERE id=$1", [
            f.task,
          ])
        ).rows[0].used_ms,
      ),
      112000,
    );
    assert.equal((await f.root.remaining()).ms, 900000 - 112000);
    assert.equal((await second.remaining()).ms, 110000);
    await f.root.finish("answer");
    await recoverRuntime(f.db);
    assert.equal(
      Number(
        (
          await f.db.query("SELECT used_ms FROM work_tasks WHERE id=$1", [
            f.task,
          ])
        ).rows[0].used_ms,
      ),
      112000,
    );
  } finally {
    await f.pg.close();
  }
});
