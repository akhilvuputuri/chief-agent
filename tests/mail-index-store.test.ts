import test from "node:test";
import assert from "node:assert/strict";
import { closeAfter, migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import { MailIndex, type Embedder } from "../src/mail-recall.js";
import {
  decodeVector,
  encodeVector,
  MailIndexStore,
} from "../src/mail-index-store.js";

const DAY = 86_400_000;
const CONFIG = { model: "m", dimensions: 512, windowDays: 365 };
const NOW = Date.UTC(2026, 9, 29);
const FAST = { readMs: 0, quotaPauseMs: 0, topUpMs: 10_000 };

const words: Embedder = {
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(512);
      for (const w of t.toLowerCase().match(/[a-z]{3,}/g) ?? []) {
        let h = 0;
        for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 512;
        v[h] += 1;
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  },
};

type Mail = { id: string; at: number; subject: string; text: string };
function mailbox(initial: Mail[]) {
  const mail = [...initial];
  const reads: string[] = [];
  const gmail = {
    async indexPage(_user: string, query: string) {
      const after = Number(query.match(/after:(\d+)/)?.[1] ?? 0) * 1000;
      return {
        messages: mail
          .filter((m) => m.at >= after)
          .map((m) => ({ id: m.id, threadId: "t" + m.id })),
      };
    },
    async indexMessage(_user: string, id: string) {
      reads.push(id);
      const m = mail.find((x) => x.id === id)!;
      return {
        id,
        threadId: "t" + id,
        at: m.at,
        from: "sender@example.com",
        to: "owner@example.com",
        subject: m.subject,
        date: new Date(m.at).toUTCString(),
        text: m.text,
        snippet: "snippet of " + m.subject,
      };
    },
  };
  return { gmail, mail, reads };
}

async function database(t: { after(fn: () => Promise<void>): void }) {
  const pg = await migratedPGlite();
  closeAfter(t, pg);
  const db = pg as unknown as Database;
  await ensureUser(db, "owner");
  await ensureUser(db, "other");
  return db;
}

const mails = (): Mail[] => [
  {
    id: "a1",
    at: NOW - 2 * DAY,
    subject: "Sofa",
    text: "we apologise for the late sofa delivery",
  },
  {
    id: "b2",
    at: NOW - 3 * DAY,
    subject: "Lease",
    text: "the deposit is two months of rent",
  },
  {
    id: "c3",
    at: NOW - 4 * DAY,
    subject: "Statement",
    text: "your card statement is ready",
  },
];

test("vectors round-trip as little-endian float32", () => {
  const v = Float32Array.from([0.5, -1.25, 3e-7]);
  assert.deepEqual([...decodeVector(encodeVector(v), 3)], [...v]);
  assert.throws(() => decodeVector(encodeVector(v), 4), /wrong length/);
});

test("a restarted index loads from Postgres without reading mail again", async (t) => {
  const db = await database(t);
  const box = mailbox(mails());
  const first = new MailIndex(
    box.gmail,
    words,
    new MailIndexStore(db),
    "owner",
    () => NOW,
    FAST,
  );
  await first.start();
  assert.equal(first.messages, 3);
  const rows = (
    await db.query("SELECT count(*)::int AS n FROM mail_index_messages")
  ).rows[0].n;
  assert.equal(rows, 3);
  // Nothing but headers, Gmail's snippet and vectors is stored.
  const columns = (
    await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name IN ('mail_index_messages','mail_index_chunks') ORDER BY column_name",
    )
  ).rows.map((r) => r.column_name);
  assert.ok(!columns.includes("text") && !columns.includes("body"));

  const reads = box.reads.length;
  const second = new MailIndex(
    box.gmail,
    words,
    new MailIndexStore(db),
    "owner",
    () => NOW,
    FAST,
  );
  await second.start();
  assert.equal(second.state, "ready");
  assert.equal(second.messages, 3);
  assert.equal(box.reads.length, reads, "no message was read again");
  const found = await second.recall("owner", "late sofa delivery apology");
  assert.equal(found.results[0]!.messageId, "a1");
  // Body text is not persisted, so a loaded result shows Gmail's snippet.
  assert.equal(found.results[0]!.excerpt, "snippet of Sofa");
});

test("on start, mail that left the mailbox is removed and new mail is indexed", async (t) => {
  const db = await database(t);
  const box = mailbox(mails());
  await new MailIndex(
    box.gmail,
    words,
    new MailIndexStore(db),
    "owner",
    () => NOW,
    FAST,
  ).start();
  box.mail.splice(
    box.mail.findIndex((m) => m.id === "b2"),
    1,
  );
  box.mail.push({
    id: "d4",
    at: NOW - DAY,
    subject: "Court",
    text: "badminton court booking confirmed",
  });
  const reads = box.reads.length;
  const index = new MailIndex(
    box.gmail,
    words,
    new MailIndexStore(db),
    "owner",
    () => NOW,
    FAST,
  );
  await index.start();
  assert.equal(index.messages, 3);
  assert.deepEqual(box.reads.slice(reads), ["d4"]);
  const ids = (
    await db.query(
      "SELECT message_id FROM mail_index_messages ORDER BY message_id",
    )
  ).rows.map((r) => r.message_id);
  assert.deepEqual(ids, ["a1", "c3", "d4"]);
  const chunks = (
    await db.query(
      "SELECT count(*)::int AS n FROM mail_index_chunks WHERE message_id='b2'",
    )
  ).rows[0].n;
  assert.equal(chunks, 0);
});

test("an index stored under another configuration is rebuilt", async (t) => {
  const db = await database(t);
  const box = mailbox(mails());
  await new MailIndex(
    box.gmail,
    words,
    new MailIndexStore(db),
    "owner",
    () => NOW,
    FAST,
  ).start();
  await db.query("UPDATE mail_index_state SET model='older-model'");
  const reads = box.reads.length;
  const index = new MailIndex(
    box.gmail,
    words,
    new MailIndexStore(db),
    "owner",
    () => NOW,
    FAST,
  );
  await index.start();
  assert.equal(index.messages, 3);
  assert.equal(box.reads.length - reads, 3, "every message re-embedded");
  const state = (await db.query("SELECT model FROM mail_index_state")).rows[0]
    .model;
  assert.match(state, /^openai\/text-embedding-3-small#chunks=/);
});

test("a failed save does not stop recall, and the next start repairs it", async (t) => {
  const db = await database(t);
  const box = mailbox(mails());
  const failing = new MailIndexStore(db);
  failing.save = async () => {
    throw new Error("connection lost");
  };
  const first = new MailIndex(
    box.gmail,
    words,
    failing,
    "owner",
    () => NOW,
    FAST,
  );
  await first.start();
  assert.equal(first.state, "failed");
  assert.equal(first.messages, 0);
  const reads = box.reads.length;
  const index = new MailIndex(
    box.gmail,
    words,
    new MailIndexStore(db),
    "owner",
    () => NOW,
    FAST,
  );
  await index.start();
  assert.equal(index.state, "ready");
  assert.equal(index.messages, 3);
  assert.ok(box.reads.length > reads, "unsaved messages are read again");
  const rows = (
    await db.query("SELECT count(*)::int AS n FROM mail_index_messages")
  ).rows[0].n;
  assert.equal(rows, 3);
});

test("pruned mail leaves Postgres too, and another user's index stays separate", async (t) => {
  const db = await database(t);
  let now = NOW;
  const box = mailbox([
    { id: "old", at: NOW - 364 * DAY, subject: "Old", text: "dentist checkup" },
    ...mails(),
  ]);
  const index = new MailIndex(
    box.gmail,
    words,
    new MailIndexStore(db),
    "owner",
    () => now,
    FAST,
  );
  await index.start();
  now = NOW + 2 * DAY;
  await index.recall("owner", "dentist");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const ids = (
    await db.query(
      "SELECT message_id FROM mail_index_messages WHERE user_id='owner'",
    )
  ).rows.map((r) => r.message_id);
  assert.ok(!ids.includes("old"));
  assert.equal(
    await new MailIndexStore(db).load("other", {
      model: "x",
      dimensions: 512,
      windowDays: 365,
    }),
    null,
  );
});

/** A seeded unit vector, so a failure can be reproduced. */
function randomUnit(seed: number) {
  let state = seed;
  const v = Float32Array.from({ length: 512 }, () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  });
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

const cosine = (a: Float32Array, b: Float32Array) =>
  a.reduce((sum, x, i) => sum + x * b[i]!, 0);

test("search matches an exact cosine scan, scoring each message by its best chunk", async (t) => {
  const db = await database(t);
  const store = new MailIndexStore(db);
  await store.begin("owner", CONFIG);
  const messages = Array.from({ length: 60 }, (_, i) => ({
    messageId: `m${i}`,
    threadId: `t${i}`,
    at: NOW - i * DAY,
    from: "a@example.com",
    subject: "s",
    date: "d",
    snippet: "n",
    vectors: Array.from({ length: 1 + (i % 4) }, (_, c) =>
      randomUnit(1000 * i + c + 1),
    ),
  }));
  await store.save("owner", messages);
  for (const seed of [7, 8, 9]) {
    const query = randomUnit(seed);
    const expected = messages
      .map((m) => ({
        id: m.messageId,
        score: Math.max(...m.vectors.map((v) => cosine(v, query))),
      }))
      .sort((a, b) => b.score - a.score);
    const found = await store.search("owner", query, 0);
    assert.deepEqual(
      found.map((m) => m.messageId),
      expected.map((m) => m.id),
    );
    found.forEach((m, i) =>
      assert.ok(Math.abs(m.score - expected[i]!.score) < 1e-5),
    );
  }
  // The window is applied by the query, whether or not old rows were deleted.
  const recent = await store.search("owner", randomUnit(7), NOW - 9.5 * DAY);
  assert.equal(recent.length, 10);
  assert.ok(recent.every((m) => Number(m.messageId.slice(1)) < 10));
});

test("start fills the vector column from the stored bytes without embedding again", async (t) => {
  const db = await database(t);
  const box = mailbox(mails());
  await new MailIndex(
    box.gmail,
    words,
    new MailIndexStore(db),
    "owner",
    () => NOW,
    FAST,
  ).start();
  // The state migration 035 finds, and what a rolled-back gateway writes.
  await db.query("UPDATE mail_index_chunks SET embedding=NULL");
  let embedded = 0;
  const counting: Embedder = {
    async embed(texts, signal) {
      embedded += texts.length;
      return words.embed(texts, signal);
    },
  };
  const index = new MailIndex(
    box.gmail,
    counting,
    new MailIndexStore(db),
    "owner",
    () => NOW,
    FAST,
  );
  await index.start();
  assert.equal(embedded, 0);
  assert.equal(index.messages, 3);
  const rows = (
    await db.query(
      "SELECT vector,embedding::text AS text FROM mail_index_chunks",
    )
  ).rows;
  assert.equal(rows.length, 3);
  // Every value survives the conversion exactly.
  for (const row of rows)
    assert.deepEqual(
      Float32Array.from(JSON.parse(row.text) as number[]),
      decodeVector(row.vector, 512),
    );
  const found = await index.recall("owner", "late sofa delivery apology");
  assert.equal(found.results[0]!.messageId, "a1");
});

test("new chunks keep the bytes the previous gateway reads, so a rollback works", async (t) => {
  const db = await database(t);
  const store = new MailIndexStore(db);
  const vector = randomUnit(3);
  await store.begin("owner", CONFIG);
  await store.save("owner", [
    {
      messageId: "m",
      threadId: "t",
      at: NOW,
      from: "f",
      subject: "s",
      date: "d",
      snippet: "n",
      vectors: [vector],
    },
  ]);
  const row = (await db.query("SELECT vector FROM mail_index_chunks")).rows[0];
  assert.deepEqual(decodeVector(row.vector, 512), vector);
  assert.deepEqual(await store.load("owner", CONFIG), ["m"]);
});

test("a changed configuration deletes the stored index", async (t) => {
  const db = await database(t);
  const store = new MailIndexStore(db);
  await store.begin("owner", CONFIG);
  await store.save("owner", [
    {
      messageId: "m",
      threadId: "t",
      at: NOW,
      from: "f",
      subject: "s",
      date: "d",
      snippet: "n",
      vectors: [randomUnit(4)],
    },
  ]);
  assert.equal(await store.load("owner", { ...CONFIG, model: "new" }), null);
  assert.deepEqual(await store.search("owner", randomUnit(4), 0), []);
});

test("a NUL in an email's headers is removed, not a reason to refuse the message", async (t) => {
  const db = await database(t);
  const box = mailbox(mails());
  const reader = box.gmail.indexMessage;
  box.gmail.indexMessage = async (user, id) => {
    const message = await reader(user, id);
    return id === "b2"
      ? { ...message, subject: "Le\u0000ase", snippet: "sn\u0000ip" }
      : message;
  };
  const index = new MailIndex(
    box.gmail,
    words,
    new MailIndexStore(db),
    "owner",
    () => NOW,
    FAST,
  );
  await index.start();
  assert.equal(index.state, "ready");
  assert.equal(index.messages, 3);
  const stored = (await new MailIndexStore(db).headers("owner", ["b2"])).get(
    "b2",
  )!;
  assert.equal(stored.subject, "Lease");
  assert.equal(stored.snippet, "snip");
});

test("a row Postgres refuses is left out without blocking the mail behind it", async (t) => {
  const db = await database(t);
  const box = mailbox(mails());
  const refusing = new MailIndexStore(db);
  const save = refusing.save.bind(refusing);
  refusing.save = async (user, messages) => {
    if (messages.some((m) => m.messageId === "b2"))
      throw Object.assign(new Error("bad row"), { code: "22021" });
    return save(user, messages);
  };
  const index = new MailIndex(
    box.gmail,
    words,
    refusing,
    "owner",
    () => NOW,
    FAST,
  );
  await index.start();
  assert.equal(index.state, "ready");
  assert.equal(index.messages, 2);
  const ids = (await refusing.headers("owner")).keys();
  assert.deepEqual([...ids].sort(), ["a1", "c3"]);
  // Once it is outside the top-up's hour of overlap, calls no longer read it.
  const reads = box.reads.length;
  await index.recall("owner", "sofa");
  assert.equal(box.reads.length, reads);
});
