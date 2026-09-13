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
    if (legacy && Number.parseInt(f, 10) >= 12) continue;
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

test("conversation search retrieves original exchanges instead of repeated observation copies", async () => {
  const f = await fixture();
  try {
    const earlier = [
      user("Elena and Rowan's wedding is 3 October 2026, starting at 11am."),
      answer("The earlier wedding starts at 11am."),
    ];
    const copies: Message[] = Array.from({ length: 24 }, (_, i) => [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: `search-${i}`,
            type: "function" as const,
            function: {
              name: "conversation_search",
              arguments: '{"query":"11am"}',
            },
          },
        ],
      },
      {
        role: "tool" as const,
        tool_call_id: `search-${i}`,
        content: JSON.stringify({
          excerpt: earlier[0]!.content,
          nested: "11am ".repeat(30),
        }),
      },
    ]).flat();
    const latest = [
      user("Please add the invitation I just sent to my calendar."),
      answer(
        "Nila and Arun's wedding is 18 March 2027. What time should I use?",
      ),
      user("Use 8am to 11am."),
    ];
    const orphan: Message = {
      role: "tool",
      tool_call_id: "missing-call",
      content: '{"copied":"11am orphan observation"}',
    };
    await f.store.append("owner", null, 0, [
      ...earlier,
      ...copies,
      ...latest,
      orphan,
    ]);
    const count = await f.store.count("owner");
    const results = await f.store.search("owner", "11am");
    assert.equal(results.length, 3);
    assert.ok(
      results.every((r) => r.role === "user" || r.role === "assistant"),
    );
    const current = results.find((r) => r.excerpt === "Use 8am to 11am.")!;
    assert.ok(current);
    assert.ok(
      current.neighborhood.some((n: any) => /Nila and Arun/.test(n.excerpt)),
    );
    assert.deepEqual(
      current.neighborhood.map((n: any) => n.ordinal),
      current.neighborhood
        .map((n: any) => n.ordinal)
        .sort((a: number, b: number) => a - b),
    );
    for (const result of results)
      for (const entry of [result, ...result.neighborhood]) {
        const original = await f.store.read("owner", entry.id, 0);
        assert.equal(original.role, entry.role);
        assert.match(original.content, new RegExp(entry.excerpt.slice(0, 12)));
      }
    assert.deepEqual(await f.store.search("other", "11am"), []);
    await assert.rejects(
      () => f.store.read("other", current.id, 0),
      /not found/,
    );
    assert.equal(await f.store.count("owner"), count);
    const orphanId = (
      await f.db.query(
        "SELECT id FROM conversation_messages WHERE user_id='owner' ORDER BY ordinal DESC LIMIT 1",
      )
    ).rows[0].id;
    const originalOrphan = await f.store.read("owner", orphanId, 0);
    assert.deepEqual(JSON.parse(originalOrphan.content), orphan);
    // Feeding the result back into history as a tool observation cannot add another hit.
    await f.store.append("owner", null, count, [
      {
        role: "tool",
        tool_call_id: "replay",
        content: JSON.stringify(results),
      },
    ]);
    assert.deepEqual(
      (await f.store.search("owner", "11am")).map((r) => r.id),
      results.map((r) => r.id),
    );
  } finally {
    await f.pg.close();
  }
});

test("conversation commits retry concurrent appends, preserve exact retries and reject changed suffixes", async () => {
  const f = await fixture();
  const runs = [randomUUID(), randomUUID(), randomUUID()];
  try {
    for (const run of runs)
      await f.db.query(
        "INSERT INTO runtime_runs(id,user_id) VALUES($1,'owner')",
        [run],
      );
    const first = [user("First inquiry"), answer("First answer")];
    const second = [user("Second inquiry"), answer("Second answer")];
    await Promise.all([
      f.store.appendConversation("owner", runs[0]!, first),
      f.store.appendConversation("owner", runs[1]!, second),
      f.store.appendDelivery("owner", runs[2]!, "Background result delivered"),
    ]);
    assert.equal(await f.store.count("owner"), 5);
    const refs = (
      await f.db.query(
        "SELECT id,ordinal FROM conversation_messages ORDER BY ordinal",
      )
    ).rows;
    assert.deepEqual(
      refs.map((r) => r.ordinal),
      [0, 1, 2, 3, 4],
    );
    await Promise.all([
      f.store.appendConversation(
        "owner",
        runs[0]!,
        first.map((m) => ({ content: m.content, role: m.role })),
      ),
      f.store.appendDelivery("owner", runs[2]!, "Background result delivered"),
    ]);
    assert.deepEqual(
      (
        await f.db.query(
          "SELECT id,ordinal FROM conversation_messages ORDER BY ordinal",
        )
      ).rows,
      refs,
    );
    assert.equal(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM events WHERE type='conversation.delivery'",
        )
      ).rows[0].n,
      1,
    );
    await assert.rejects(
      () =>
        f.store.appendConversation("owner", runs[0]!, [
          ...first,
          answer("Unmatched extra suffix"),
        ]),
      /different suffix/,
    );
    await assert.rejects(
      () =>
        f.store.appendDelivery("owner", runs[2]!, "Different delivered reply"),
      /different suffix/,
    );
    await assert.rejects(
      () => f.store.appendConversation("other", runs[0]!, first),
      /not found/,
    );
    assert.equal(await f.store.count("owner"), 5);
    assert.equal(await f.store.count("other"), 0);
    assert.equal(
      (await f.db.query("SELECT count(*)::int n FROM message_contents")).rows[0]
        .n,
      5,
    );
  } finally {
    await f.pg.close();
  }
});

test("search excludes internal worker and specialist messages but retains delivered reply provenance", async () => {
  const f = await fixture();
  try {
    const task = randomUUID(),
      worker = randomUUID(),
      child = randomUUID(),
      delivery = randomUUID();
    await f.db.query(
      "INSERT INTO work_tasks(id,user_id,objective,request,status) VALUES($1,'owner','Research','Original request','paused')",
      [task],
    );
    for (const run of [worker, child, delivery])
      await f.db.query(
        "INSERT INTO runtime_runs(id,user_id,task_id) VALUES($1,'owner',$2)",
        [run, task],
      );
    for (const run of [worker, delivery])
      await f.db.query(
        "INSERT INTO work_turns(run_id,user_id,request,background,task_id) VALUES($1,'owner','Continue recorded task',true,$2)",
        [run, task],
      );
    await f.db.query(
      "INSERT INTO events(user_id,run_id,type,data) VALUES('owner',$1,'research.child_started','{}')",
      [child],
    );
    await f.store.append(
      "owner",
      null,
      0,
      [user("Internal worker zebras"), answer("Worker-only zebras checkpoint")],
      worker,
    );
    await f.store.append(
      "owner",
      null,
      2,
      [
        user("Specialist zebras assignment"),
        answer("Specialist-only zebras result"),
      ],
      child,
    );
    await f.store.appendDelivery("owner", delivery, "Delivered zebras finding");
    const hits = await f.store.search("owner", "zebras");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].excerpt, "Delivered zebras finding");
    assert.equal(hits[0].task_id, task);
    assert.equal(hits[0].run_id, delivery);
    assert.deepEqual(hits[0].neighborhood, []);
    const read = await f.store.read("owner", hits[0].id, 0);
    assert.equal(read.source, "background_delivery");
    assert.equal(read.taskId, task);
    assert.equal(read.runId, delivery);
    assert.equal(read.role, "assistant");
    assert.equal(await f.store.count("owner"), 5);
  } finally {
    await f.pg.close();
  }
});

test("many long matching exchanges retain bounded structured search results", async () => {
  const f = await fixture();
  try {
    const messages = Array.from({ length: 20 }, (_, i) => [
      user(`Appointment ${i}: ${"a".repeat(600)}`),
      answer(`Appointment details ${i}: ${"b".repeat(600)}`),
    ]).flat();
    await f.store.append("owner", null, 0, messages);
    const hits = await f.store.search("owner", "appointment");
    assert.equal(hits.length, 10);
    assert.ok(JSON.stringify(hits).length <= 11000);
    assert.ok(
      hits.every(
        (h) => h.neighborhood.length > 0 && h.neighborhood.length <= 4,
      ),
    );
    assert.ok(hits.some((h) => h.neighborhoodTruncated));
  } finally {
    await f.pg.close();
  }
});
