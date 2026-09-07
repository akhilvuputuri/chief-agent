import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { recordContext } from "../src/record-context.js";
import type { Database } from "../src/db.js";

test("record inventory survives restart and excludes other owners and unrelated tasks", async () => {
  const pg = new PGlite();
  try {
    for (const f of (await readdir(new URL("../db/", import.meta.url)))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await pg.exec(
        await readFile(new URL("../db/" + f, import.meta.url), "utf8"),
      );
    const db = pg as unknown as Database;
    await db.query("INSERT INTO users(id) VALUES('a'),('b')");
    const task = randomUUID(),
      old = randomUUID(),
      resumed = randomUUID(),
      other = randomUUID(),
      unrelated = randomUUID();
    await db.query(
      "INSERT INTO work_tasks(id,user_id,objective,request) VALUES($1,'a','Review','Review')",
      [task],
    );
    for (const [id, owner, taskId] of [
      [old, "a", task],
      [resumed, "a", task],
      [other, "b", null],
      [unrelated, "a", null],
    ])
      await db.query(
        "INSERT INTO runtime_runs(id,user_id,task_id) VALUES($1,$2,$3)",
        [id, owner, taskId],
      );
    for (const [run, title] of [
      [old, "Exact"],
      [other, "Other owner"],
      [unrelated, "Unrelated"],
    ])
      await db.query(
        "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result) VALUES($1,$2,'list','job_list','{}',false,'success',$3)",
        [
          randomUUID(),
          run,
          JSON.stringify({
            result: Array.from({ length: 22 }, (_, i) => ({
              id: String(i),
              title,
              description: "x".repeat(10000),
            })),
          }),
        ],
      );
    const result = await recordContext(db, "a", resumed);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.records.length, 22);
    assert.equal(result[0]!.records[21].id, "21");
    assert.equal(result[0]!.records[0].title, "Exact");
    assert.ok(JSON.stringify(result).length < 5000);
    assert.equal((await recordContext(db, "b", resumed)).length, 0);
    await db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result,started_at) VALUES($1,$2,'empty','job_list','{}',false,'success',$3,now()+interval '1 second')",
      [randomUUID(), resumed, JSON.stringify({ result: [] })],
    );
    const refreshed = await recordContext(db, "a", resumed);
    assert.equal(refreshed.length, 2);
    assert.equal(refreshed[0]!.records.length, 22);
    assert.equal(refreshed[1]!.records.length, 0);
  } finally {
    await pg.close();
  }
});
