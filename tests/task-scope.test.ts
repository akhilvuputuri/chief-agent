import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { TaskScope } from "../src/task-scope.js";
import type { Database } from "../src/db.js";
test("scope preserves identities and enforces ownership, evidence and revisions", async () => {
  const pg = new PGlite();
  try {
    for (const file of (await readdir(new URL("../db/", import.meta.url)))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await pg.exec(
        await readFile(new URL("../db/" + file, import.meta.url), "utf8"),
      );
    const db = pg as unknown as Database,
      task = randomUUID(),
      run = randomUUID(),
      list = randomUUID(),
      observation = randomUUID();
    await db.query("INSERT INTO users(id) VALUES('owner'),('other')");
    await db.query(
      "INSERT INTO work_tasks(id,user_id,objective,request) VALUES($1,'owner','compare','compare')",
      [task],
    );
    await db.query(
      "INSERT INTO runtime_runs(id,user_id,task_id) VALUES($1,'owner',$2)",
      [run, task],
    );
    await db.query(
      "INSERT INTO work_turns(run_id,user_id,request,task_id) VALUES($1,'owner','compare',$2)",
      [run, task],
    );
    async function call(id: string, op: string, result: unknown) {
      await db.query(
        "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result) VALUES($1::uuid,$2,($1::uuid)::text,$3,'{}',false,'success',$4)",
        [id, run, op, JSON.stringify({ result })],
      );
    }
    await call(list, "job_list", [
      { id: "a", title: "A", url: "https://a.example" },
      { id: "b", title: "B", url: "https://b.example" },
    ]);
    const s = new TaskScope(db);
    await assert.rejects(() => s.bind("other", run, task, list, ["a"]));
    await assert.rejects(() => s.bind("owner", run, task, list, ["invented"]));
    await s.bind("owner", run, task, list, ["a", "b"]);
    await assert.rejects(
      () => s.bind("owner", run, task, list, ["a"]),
      /fixed/,
    );
    await call(observation, "job_analyze", { role: { id: "a" } });
    await assert.rejects(
      () =>
        s.finding("owner", task, "b", "wrong target", "complete", [
          observation,
        ]),
      /does not identify/,
    );
    await assert.rejects(
      () => s.finding("owner", task, "a", "unsupported", "complete", []),
      /require/,
    );
    await s.finding(
      "owner",
      task,
      "a",
      "Customer experience unknown",
      "complete",
      [observation],
    );
    await assert.rejects(
      () => s.validate("owner", task, ["a", "b"]),
      /Missing/,
    );
    await s.finding("owner", task, "b", "Posting unavailable", "blocked", []);
    await assert.rejects(
      () => s.validate("owner", task, ["a", "b", "outside"]),
      /outside/,
    );
    const restored = new TaskScope(db);
    await restored.validate("owner", task, ["a", "b"]);
    assert.equal((await restored.view("owner", task))!.targets.length, 2);
    const next = randomUUID();
    await db.query(
      "INSERT INTO runtime_runs(id,user_id,task_id) VALUES($1,'owner',$2)",
      [next, task],
    );
    await db.query(
      "INSERT INTO work_turns(run_id,user_id,request,task_id) VALUES($1,'owner','only b',$2)",
      [next, task],
    );
    await restored.bind("owner", next, task, list, ["b"]);
    assert.equal((await restored.view("owner", task))!.targets.length, 1);
    assert.equal((await restored.view("owner", task))!.findings.length, 1);
  } finally {
    await pg.close();
  }
});
