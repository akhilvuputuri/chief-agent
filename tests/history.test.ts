import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Database } from "../src/db.js";
import { HistoryStore } from "../src/history.js";
import { Execution, recoverRuntime } from "../src/execution.js";
import type { Message } from "../src/model.js";
import { Assistant } from "../src/agent.js";
import { CustomAgent } from "../src/custom-agent.js";
import { JobTools } from "../src/tools.js";
const migration = () =>
  readFile(new URL("../db/012_message_storage.sql", import.meta.url), "utf8");
async function fixture(legacy = false) {
  const pg = new PGlite();
  for (const f of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (legacy && f.startsWith("012")) continue;
    await pg.exec(
      await readFile(new URL("../db/" + f, import.meta.url), "utf8"),
    );
  }
  await pg.exec("INSERT INTO users(id) VALUES('owner'),('other')");
  const db = pg as unknown as Database;
  return { pg, db, store: new HistoryStore(db) };
}
const user = (content: string): Message => ({ role: "user", content });
const answer = (content: string): Message => ({ role: "assistant", content });
test("migration exactly preserves legacy ordering, duplicate occurrences, reasoning and incomplete tools; reapplication does nothing", async () => {
  const f = await fixture(true);
  const run = randomUUID();
  const messages: Message[] = [
    user("same"),
    user("same"),
    {
      role: "assistant",
      content: null,
      reasoning_details: [{ text: "opaque" }],
      tool_calls: [
        {
          id: "call",
          type: "function",
          function: {
            name: "memory_set",
            arguments: '{"key":"a","value":"b"}',
          },
        },
      ],
    },
  ];
  try {
    await f.db.query(
      "INSERT INTO runtime_runs(id,user_id,messages) VALUES($1,$2,$3::jsonb)",
      [run, "owner", JSON.stringify(messages)],
    );
    await f.db.query(
      "INSERT INTO conversations(user_id,history) VALUES($1,$2::jsonb)",
      ["owner", JSON.stringify(messages)],
    );
    await f.pg.exec(await migration());
    await f.pg.exec(await migration());
    const reconstructed = (
      await f.db.query(
        "SELECT c.payload FROM run_messages r JOIN message_contents c USING(user_id,hash) WHERE r.run_id=$1 ORDER BY ordinal",
        [run],
      )
    ).rows.map((r) => r.payload);
    assert.deepEqual(reconstructed, messages);
    const stableIds = (
      await f.db.query("SELECT id FROM conversation_messages ORDER BY ordinal")
    ).rows;
    await f.pg.exec(
      await readFile(
        new URL("../scripts/restore-legacy-history.sql", import.meta.url),
        "utf8",
      ),
    );
    assert.deepEqual(
      (await f.db.query("SELECT history FROM conversations")).rows[0].history,
      messages,
    );
    // Simulate a turn written by the previous application after rollback.
    await f.db.query("UPDATE conversations SET history=history || $1::jsonb", [
      JSON.stringify([answer("legacy rollback reply")]),
    ]);
    await f.pg.exec(await migration());
    assert.deepEqual(
      (
        await f.db.query(
          "SELECT id FROM conversation_messages ORDER BY ordinal LIMIT 3",
        )
      ).rows,
      stableIds,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM message_contents")).rows.length,
      3,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM conversation_messages")).rows.length,
      4,
    );
    assert.deepEqual(
      (await f.db.query("SELECT messages,message_count FROM runtime_runs"))
        .rows[0],
      { messages: [], message_count: 3 },
    );
    assert.deepEqual((await f.store.recent("owner", run)).messages, [
      user("same"),
      user("same"),
    ]);
  } finally {
    await f.pg.close();
  }
});
test("checkpoint appends once, rejects changed prefixes and stale concurrent writes atomically, scopes payloads and references", async () => {
  const f = await fixture();
  const run = randomUUID();
  const ex = new Execution(f.db, "owner", run, new AbortController().signal);
  try {
    await ex.start();
    const messages = [user("hello"), answer("hi")];
    await ex.checkpoint(messages);
    await ex.checkpoint(messages);
    await ex.checkpoint([...messages, answer("more")]);
    await assert.rejects(() => ex.checkpoint([user("changed")]), /append-only/);
    await f.store.append("owner", null, 0, messages, run);
    assert.equal(
      (await f.db.query("SELECT * FROM message_contents")).rows.length,
      3,
    );
    const before = (await f.db.query("SELECT * FROM message_contents")).rows
      .length;
    await assert.rejects(
      () => f.store.append("owner", run, 0, [answer("must not commit")]),
      /concurrently/,
    );
    assert.equal(
      (await f.db.query("SELECT * FROM message_contents")).rows.length,
      before,
    );
    assert.equal(await f.store.count("owner", run), 3);
    await assert.rejects(
      () => f.store.append("other", run, 3, [user("intruder")]),
      /concurrently/,
    );
    await assert.rejects(() => f.store.append("other", null, 0, messages, run));
    assert.equal(await f.store.count("other"), 0);
    await f.store.append("other", null, 0, messages);
    assert.equal(
      (await f.db.query("SELECT * FROM message_contents")).rows.length,
      5,
    );
    assert.deepEqual((await f.store.recent("other", run)).messages, []);
  } finally {
    await f.pg.close();
  }
});
test("bounded reads omit complete tool groups without deleting originals; lexical search and paged reads enforce owner scope", async () => {
  const f = await fixture();
  try {
    const messages: Message[] = [];
    for (let i = 0; i < 100; i++)
      messages.push(user(`meeting zebras ${i}`), answer("x".repeat(4000)));
    messages.push(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "job_list", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "a", content: '{"rows":[]}' },
      answer("done"),
    );
    await f.store.append("owner", null, 0, messages);
    const recent = await f.store.recent("owner");
    assert.ok(recent.omitted > 0);
    assert.ok(JSON.stringify(recent.messages).length <= 100000);
    assert.ok(recent.messages.filter((m) => m.role === "user").length <= 20);
    assert.ok(recent.messages.some((m) => m.tool_call_id === "a"));
    assert.equal(await f.store.count("owner"), 203);
    const matches = await f.store.search("owner", "zebras");
    assert.equal(matches.length, 10);
    const read = await f.store.read("owner", matches[0].id, 0);
    assert.match(read.content, /zebras/);
    await assert.rejects(
      () => f.store.read("other", matches[0].id, 0),
      /not found/,
    );
    assert.deepEqual(await f.store.search("other", "zebras"), []);
    const old = (
      await f.db.query(
        "SELECT id FROM conversation_messages WHERE user_id=$1 AND ordinal=0",
        ["owner"],
      )
    ).rows[0].id;
    assert.match((await f.store.read("owner", old, 0)).content, /zebras 0/);
    await f.db.query("DELETE FROM conversations WHERE user_id=$1", ["owner"]);
    assert.equal(await f.store.count("owner"), 0);
    assert.deepEqual(await f.store.search("owner", "zebras"), []);
    await assert.rejects(() => f.store.read("owner", old, 0), /not found/);
  } finally {
    await f.pg.close();
  }
});
test("restart preserves checkpoint and uncertain write journal without replay", async () => {
  const f = await fixture();
  const run = randomUUID();
  const ex = new Execution(f.db, "owner", run, new AbortController().signal);
  try {
    await ex.start();
    await ex.checkpoint([user("save this"), answer("checking")]);
    await ex.beginCall("a", "memory_set", { key: "a", value: "b" });
    await recoverRuntime(f.db);
    assert.equal(
      (await f.db.query("SELECT state FROM runtime_calls")).rows[0].state,
      "uncertain",
    );
    assert.deepEqual((await f.store.recent("owner", run)).messages, [
      user("save this"),
      answer("checking"),
    ]);
  } finally {
    await f.pg.close();
  }
});
test("many turns read bounded state, append only new conversation events, retrieve omitted originals through validated tools", async () => {
  const f = await fixture();
  let calls = 0;
  const tools = new JobTools(f.db, { call: async () => ({}) });
  const assistant = new Assistant(
    f.db,
    new CustomAgent({
      generate: async (input) => {
        calls++;
        assert.ok(input.messages.length < 100);
        return { message: answer(`response ${calls}`) };
      },
    }),
    tools,
    { web: false },
  );
  try {
    const old = Array.from({ length: 30 }, (_, i) => [
      user(`original giraffes ${i}`),
      answer(`past ${i}`),
    ]).flat();
    await f.store.append("owner", null, 0, old);
    await assistant.respond("owner", "hello");
    await assistant.respond("owner", "follow up");
    assert.equal(await f.store.count("owner"), 64);
    const runs = (
      await f.db.query(
        "SELECT id,message_count,messages FROM runtime_runs ORDER BY started_at",
      )
    ).rows;
    for (const run of runs) {
      assert.deepEqual(run.messages, []);
      assert.ok(run.message_count <= 42);
    }
    const result = await tools.execute("owner", runs[0].id, {
      operation: "conversation_search",
      query: "giraffes",
    });
    const first = (result as any[])[0];
    assert.ok(first.id);
    const saved = await tools.execute("owner", runs[0].id, {
      operation: "conversation_read",
      id: first.id,
    });
    assert.match((saved as any).content, /giraffes/);
    await assert.rejects(() =>
      tools.execute("other", runs[0].id, {
        operation: "conversation_read",
        id: first.id,
      }),
    );
    await assert.rejects(() =>
      tools.execute("owner", runs[0].id, {
        operation: "conversation_search",
        query: "x",
        user: "other",
      }),
    );
    assert.ok(
      (
        await f.db.query("SELECT data FROM events WHERE type='history.loaded'")
      ).rows.every((r) => r.data.omitted > 0),
    );
  } finally {
    await f.pg.close();
  }
});

test("very large originals survive migration and appends; SQL paging preserves Unicode without transferring full payloads", async () => {
  const f = await fixture(true);
  try {
    const huge =
      "indexedanchor " +
      Array.from({ length: 110000 }, (_, i) => `word${i.toString(36)}`).join(
        " ",
      ) +
      " unindexedtailmarker";
    await f.db.query(
      "INSERT INTO conversations(user_id,history) VALUES($1,$2::jsonb)",
      ["owner", JSON.stringify([answer(huge)])],
    );
    await f.pg.exec(await migration());
    const hit = (await f.store.search("owner", "indexedanchor"))[0];
    assert.ok(hit.id);
    assert.deepEqual(await f.store.search("owner", "unindexedtailmarker"), []);
    const page = await f.store.read("owner", hit.id, 0);
    assert.equal([...page.content].length, 8000);
    assert.ok(page.totalCharacters > 850000);
    const end = await f.store.read("owner", hit.id, page.totalCharacters - 100);
    assert.match(end.content, /unindexedtailmarker/);
    assert.equal(end.nextOffset, null);
    await f.store.append("owner", null, 1, [
      answer(huge),
      answer("🙂".repeat(8001) + "boundary"),
    ]);
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM message_contents")).rows[0]
        .n,
      2,
    );
    const id = (
      await f.db.query(
        "SELECT id FROM conversation_messages WHERE user_id=$1 AND ordinal=2",
        ["owner"],
      )
    ).rows[0].id;
    let largestPayload = 0;
    const boundedDb: Database = {
      query: async (q, v) => {
        const result = await f.db.query(q, v);
        for (const r of result.rows)
          if (typeof r.content === "string")
            largestPayload = Math.max(largestPayload, [...r.content].length);
        return result;
      },
    };
    const reader = new HistoryStore(boundedDb);
    let content = "",
      offset = 0;
    while (true) {
      const part = await reader.read("owner", id, offset);
      content += part.content;
      if (part.nextOffset === null) break;
      offset = part.nextOffset;
    }
    assert.deepEqual(
      JSON.parse(content),
      answer("🙂".repeat(8001) + "boundary"),
    );
    assert.ok(largestPayload <= 8000);
  } finally {
    await f.pg.close();
  }
});
