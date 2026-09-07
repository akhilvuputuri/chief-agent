import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Spending, spending } from "../src/spending.js";
import { WebTools } from "../src/providers.js";
import { context } from "../src/context.js";
import type { Database } from "../src/db.js";

async function fixture() {
  const pg = new PGlite();
  for (const file of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + file, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database,
    run = randomUUID(),
    next = randomUUID(),
    task = randomUUID();
  await db.query("INSERT INTO users(id) VALUES('owner'),('other')");
  await db.query(
    "INSERT INTO work_tasks(id,user_id,objective,request) VALUES($1,'owner','test','test')",
    [task],
  );
  for (const id of [run, next])
    await db.query(
      "INSERT INTO runtime_runs(id,user_id,task_id) VALUES($1,'owner',$2)",
      [id, task],
    );
  return { pg, db, run, next, task };
}
test("usage persists across runs, keeps unknowns distinct, and imposes no dollar cap", async () => {
  const f = await fixture();
  try {
    const one = new Spending(f.db, "owner", f.run);
    const id = await one.begin("test", 0.6);
    await one.settle(id, {});
    const two = new Spending(f.db, "owner", f.next);
    await two.begin("test", 50);
    assert.equal(Number((await two.summary()).estimated_unknown_usd), 50.6);
    await assert.rejects(
      () => new Spending(f.db, "other", f.run).begin("test", 1),
      /owner unavailable/,
    );
    await new Spending(f.db, "other", f.run).settle(id, { cost: 0 });
    assert.equal(Number((await one.summary()).unknown_requests), 2);
    await one.settle(id, { cost: 0.2, prompt_tokens: 100 });
    assert.equal(Number((await two.summary()).reported_usd), 0.2);
    assert.equal(Number((await two.summary()).unknown_requests), 1);
  } finally {
    await f.pg.close();
  }
});
test("same-task normalized search reuses original success without provider credentials or extra charges", async () => {
  const f = await fixture();
  try {
    await f.db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write,state,result) VALUES($1,$2,'search','web_search',$3,false,'success',$4)",
      [
        randomUUID(),
        f.run,
        JSON.stringify({ raw: JSON.stringify({ query: "Example   Query" }) }),
        JSON.stringify({
          result: { content: "saved source", provider: "test" },
        }),
      ],
    );
    const tools = new WebTools("");
    const result = await spending.run(new Spending(f.db, "owner", f.next), () =>
      tools.call("web_search", " example query "),
    );
    assert.equal(result.content, "saved source");
    assert.equal((result as any).cacheHit, true);
    assert.equal(
      (await f.db.query("SELECT * FROM provider_charges")).rows.length,
      0,
    );
    await assert.rejects(
      () =>
        spending.run(new Spending(f.db, "other", f.next), () =>
          tools.call("web_search", "example query"),
        ),
      /not configured/,
    );
  } finally {
    await f.pg.close();
  }
});
test("changing task state does not change first prompt and does not orphan tool observations", () => {
  const req: any = {
    message: "help",
    memories: [],
    runtime: { tools: [], context: "first" },
  };
  const messages: any = [
    { role: "user", content: "help" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c", type: "function", function: { name: "x", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "c", content: "actual result" },
  ];
  const first = context(req, messages);
  req.runtime.context = "second";
  const second = context(req, messages);
  assert.equal(first.messages[0].content, second.messages[0].content);
  assert.ok(second.messages.at(-1)!.content!.includes("second"));
  assert.ok(
    second.messages.some(
      (m) => m.role === "tool" && m.content === "actual result",
    ),
  );
});
