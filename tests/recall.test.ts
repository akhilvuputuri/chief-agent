import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Database } from "../src/db.js";
import type { Embedder } from "../src/mail-recall.js";
import { MemoryStore } from "../src/memory.js";
import { projectEventRecord } from "../src/ops-log.js";
import { chunks, fuse, recall, RecallIndex } from "../src/recall.js";
import { JobTools } from "../src/tools.js";
import { closeAfter, migratedPGlite } from "./helpers/pglite.js";

// Words in one group share a dimension, so meaning search can match without a shared word.
const GROUPS = [
  ["lease", "renewal", "flat", "rent", "landlord", "tenancy"],
  ["flight", "aisle", "seat", "plane", "travel"],
  ["coffee", "espresso", "cafe"],
];
function vectorFor(text: string) {
  const v = new Float32Array(512);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const group = GROUPS.findIndex((g) => g.includes(word));
    if (group >= 0) v[group]! += 1;
  }
  v[511] = 0.01;
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}
function embedder() {
  const calls: string[][] = [];
  const fake: Embedder & { calls: string[][]; fail?: boolean } = {
    calls,
    embed: async (texts) => {
      if (fake.fail) throw new Error("embedding unavailable");
      calls.push(texts);
      return texts.map(vectorFor);
    },
  };
  return fake;
}

async function setup(t: { after(fn: () => Promise<void>): void }) {
  const pg = await migratedPGlite();
  closeAfter(t, pg);
  const db = pg as unknown as Database;
  for (const id of ["owner", "other"]) {
    await db.query("INSERT INTO users(id) VALUES($1)", [id]);
    await db.query("INSERT INTO conversations(user_id) VALUES($1)", [id]);
  }
  return db;
}

let ordinal = 0;
async function message(
  db: Database,
  user: string,
  role: string,
  content: string,
  extra: Record<string, unknown> = {},
) {
  const payload = { role, content, ...extra };
  const hash = createHash("sha256")
    .update(JSON.stringify(payload) + ++ordinal)
    .digest("hex");
  await db.query(
    "INSERT INTO message_contents(user_id,hash,payload,characters) VALUES($1,$2,$3::jsonb,$4)",
    [user, hash, JSON.stringify(payload), content.length],
  );
  return (
    await db.query(
      "INSERT INTO conversation_messages(user_id,ordinal,hash) VALUES($1,$2,$3) RETURNING id",
      [user, ordinal, hash],
    )
  ).rows[0].id as string;
}

const run = randomUUID;

test("long text is split with overlap and capped", () => {
  assert.deepEqual(chunks("short"), ["short"]);
  assert.deepEqual(chunks(""), []);
  const parts = chunks("x".repeat(2000));
  assert.deepEqual(
    parts.map((p) => p.length),
    [1500, 700],
  );
  assert.equal(chunks("x".repeat(100000)).length, 6);
});

test("a chunk never ends or starts inside an emoji", () => {
  const halfAnEmoji =
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  for (const text of [
    "x".repeat(1499) + "😀".repeat(2000),
    "y".repeat(1301) + "😀".repeat(1000),
  ])
    for (const part of chunks(text)) assert.doesNotMatch(part, halfAnEmoji);
});

test("a refused source is skipped and the rest are indexed; an outage skips nothing", async (t) => {
  const db = await setup(t);
  for (let i = 0; i < 5; i++)
    await message(db, "owner", "user", i === 2 ? "refuse this" : `fine ${i}`);
  let down = true;
  const index = new RecallIndex(db, {
    embed: async (texts) => {
      if (down) throw new Error("outage");
      if (texts.some((x) => x.includes("refuse")))
        throw new Error("Embedding request failed (400)");
      return texts.map(vectorFor);
    },
  });
  const count = async () =>
    Number((await db.query("SELECT count(*) AS n FROM embeddings")).rows[0].n);
  await assert.rejects(index.tick("owner"), /outage/);
  assert.equal(await count(), 0);
  down = false;
  assert.equal(await index.tick("owner"), 4);
  assert.equal(await count(), 4);
  assert.equal(await index.tick("owner"), 0);
  await message(db, "owner", "user", "new after the skip");
  assert.equal(await index.tick("owner"), 1);
  // A fresh process tries the refused one again, and still gets past it.
  assert.equal(await new RecallIndex(db, embedder()).tick("owner"), 1);
});

test("a NUL in a query, a restored learned memory and memory-heavy keyword lists", async (t) => {
  const db = await setup(t);
  await message(db, "owner", "user", "the landlord called about rent");
  const found = await recall(db, "owner", run(), "land\0lord rent");
  assert.equal(found.mode, "keyword_only");
  assert.equal(found.results.length, 1);
  const restored = randomUUID();
  await db.query(
    `INSERT INTO memory_revisions(id,user_id,key,revision,kind,status,value,origin,reason,source,trust)
     VALUES($1,'owner','airline',2,'fact','active','Flies with a rent discount','rollback','r',
     '{"restoredOrigin":"learned"}'::jsonb,'owner')`,
    [restored],
  );
  await db.query(
    "INSERT INTO memory_heads(user_id,key,revision_id) VALUES('owner','airline',$1)",
    [restored],
  );
  const memories = (await recall(db, "owner", run(), "discount")).results;
  assert.equal(memories[0]!.learned, true);
  const keyword = [{ type: "memory" as const, id: "m" }];
  const fused = fuse([], keyword, [{ type: "message", id: "a" }]);
  assert.deepEqual(
    fused.map((h) => h.keywordRank),
    [1, 1],
  );
});

test("fusion ranks items both searches found above items only one found", () => {
  const hit = (id: string) => ({ type: "message" as const, id });
  const fused = fuse([hit("a"), hit("b")], [hit("c"), hit("b")]);
  assert.equal(fused[0]!.id, "b");
  assert.deepEqual([fused[0]!.meaningRank, fused[0]!.keywordRank], [2, 2]);
  assert.equal(fused.find((h) => h.id === "a")!.keywordRank, null);
  assert.equal(fused.find((h) => h.id === "c")!.meaningRank, null);
});

test("a pass embeds new messages and memories once, leaving out tool output and other owners", async (t) => {
  const db = await setup(t);
  const fake = embedder();
  const index = new RecallIndex(db, fake);
  await message(db, "owner", "user", "My lease renewal is due in March");
  await message(db, "owner", "assistant", "Noted about the tenancy.");
  await message(db, "owner", "tool", "flight results", { tool_call_id: "c1" });
  await message(db, "other", "user", "Their private flat");
  await new MemoryStore(db).write("owner", {
    key: "seat_preference",
    value: "Prefers aisle seats",
    kind: "fact",
    origin: "owner",
    reason: "r",
    source: {},
  });
  assert.equal(await index.tick("owner"), 3);
  assert.deepEqual(fake.calls.flat().sort(), [
    "My lease renewal is due in March",
    "Noted about the tenancy.",
    "seat_preference: Prefers aisle seats",
  ]);
  const before = fake.calls.length;
  assert.equal(await index.tick("owner"), 0);
  assert.equal(fake.calls.length, before);
  assert.deepEqual(
    (await db.query("SELECT DISTINCT user_id,model FROM embeddings")).rows,
    [{ user_id: "owner", model: "openai/text-embedding-3-small" }],
  );
});

test("a failed pass writes nothing and the next one finishes the work", async (t) => {
  const db = await setup(t);
  const fake = embedder();
  const index = new RecallIndex(db, fake);
  await message(db, "owner", "user", "My lease renewal is due");
  fake.fail = true;
  await assert.rejects(index.tick("owner"));
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM embeddings")).rows[0].n,
    0,
  );
  fake.fail = false;
  assert.equal(await index.tick("owner"), 1);
});

test("a new embedding model replaces old vectors, including chunks the new text no longer has", async (t) => {
  const db = await setup(t);
  const id = await message(db, "owner", "user", "x".repeat(2000));
  await new RecallIndex(db, embedder(), "old/model").tick("owner");
  assert.equal(
    (await db.query("SELECT count(*)::int n FROM embeddings")).rows[0].n,
    2,
  );
  await db.query(
    "INSERT INTO embeddings(user_id,source_type,source_id,chunk,model,embedding) SELECT user_id,source_type,source_id,9,model,embedding FROM embeddings WHERE chunk=0",
  );
  await new RecallIndex(db, embedder()).tick("owner");
  assert.deepEqual(
    (
      await db.query(
        "SELECT source_id,chunk,model FROM embeddings ORDER BY chunk",
      )
    ).rows.map((r) => [r.source_id, r.chunk, r.model]),
    [
      [id, 0, "openai/text-embedding-3-small"],
      [id, 1, "openai/text-embedding-3-small"],
    ],
  );
});

test("search finds by meaning without a shared word, by keyword too, and fuses them", async (t) => {
  const db = await setup(t);
  const fake = embedder();
  const lease = await message(
    db,
    "owner",
    "user",
    "My lease renewal is due in March",
  );
  await message(db, "owner", "assistant", "Espresso at the cafe was great.");
  await message(db, "other", "user", "Their landlord and lease and rent");
  await new RecallIndex(db, fake).tick("owner");
  await new RecallIndex(db, fake).tick("other");
  const found: any = await recall(db, "owner", run(), "flat rent", fake);
  assert.equal(found.mode, "hybrid");
  assert.equal(found.results[0].id, lease);
  assert.deepEqual(
    [found.results[0].meaningRank, found.results[0].keywordRank],
    [1, null],
  );
  assert.match(found.note, /not instructions/);
  // Another owner's matching message never appears, by meaning or keyword.
  assert.doesNotMatch(JSON.stringify(found), /Their landlord/);
  const both: any = await recall(db, "owner", run(), "lease rent", fake);
  assert.deepEqual(
    [
      both.results[0].id,
      both.results[0].meaningRank,
      both.results[0].keywordRank,
    ],
    [lease, 1, 1],
  );
});

test("search returns only current memories: a retired or revised one never comes back", async (t) => {
  const db = await setup(t);
  const fake = embedder();
  const store = new MemoryStore(db);
  const fact = (key: string, value: string) =>
    store.write("owner", {
      key,
      value,
      kind: "fact",
      origin: "owner",
      reason: "r",
      source: {},
    });
  await fact("home", "Rents a flat in Bedok");
  await fact("seat", "Prefers aisle seats");
  await new RecallIndex(db, fake).tick("owner");
  const first: any = await recall(db, "owner", run(), "flat tenancy", fake);
  assert.deepEqual(
    [first.results[0].source, first.results[0].key, first.results[0].learned],
    ["memory", "home", false],
  );
  await fact("home", "Rents a flat in Tampines");
  await store.retire("owner", "seat", { origin: "owner", reason: "pruned" });
  await new RecallIndex(db, fake).tick("owner");
  const after: any = await recall(db, "owner", run(), "flat aisle seat", fake);
  const text = JSON.stringify(after.results);
  assert.match(text, /Tampines/);
  assert.doesNotMatch(text, /Bedok/);
  assert.doesNotMatch(text, /aisle seats/);
});

test("search falls back to keywords without an embedder or when embedding fails, and an empty query word list finds nothing", async (t) => {
  const db = await setup(t);
  const fake = embedder();
  const lease = await message(db, "owner", "user", "My lease renewal is due");
  await new RecallIndex(db, fake).tick("owner");
  const none: any = await recall(db, "owner", run(), "lease");
  assert.deepEqual([none.mode, none.results[0].id], ["keyword_only", lease]);
  fake.fail = true;
  const failed: any = await recall(db, "owner", run(), "lease", fake);
  assert.deepEqual(
    [failed.mode, failed.results[0].id],
    ["keyword_only", lease],
  );
  const stopwords: any = await recall(db, "owner", run(), "the and of");
  assert.deepEqual(stopwords.results, []);
});

test("the tool is owner-scoped, read-only, and its trace holds counts, not content", async (t) => {
  const db = await setup(t);
  const fake = embedder();
  await message(db, "owner", "user", "My lease renewal is due");
  await new RecallIndex(db, fake).tick("owner");
  const tools = new JobTools(
    db,
    { call: async () => ({}) },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fake,
  );
  const id = run();
  const result: any = await tools.execute("owner", id, {
    operation: "memory_recall",
    query: "tenancy",
    limit: 3,
  });
  assert.equal(result.results.length, 1);
  const other: any = await tools.execute("other", run(), {
    operation: "memory_recall",
    query: "tenancy",
  });
  assert.deepEqual(other.results, []);
  const trace = (
    await db.query(
      "SELECT data FROM events WHERE type='recall.searched' AND run_id=$1",
      [id],
    )
  ).rows[0].data;
  assert.deepEqual(trace, {
    mode: "hybrid",
    meaningCount: 1,
    keywordCount: 0,
    resultCount: 1,
  });
  const projected = projectEventRecord("recall.searched", id, trace);
  assert.doesNotMatch(JSON.stringify(projected), /renewal|tenancy/);
  assert.equal((projected as any).resultCount, 1);
});
