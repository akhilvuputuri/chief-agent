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
    "owner",
    () => NOW,
    FAST,
    new MailIndexStore(db),
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
    "owner",
    () => NOW,
    FAST,
    new MailIndexStore(db),
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
    "owner",
    () => NOW,
    FAST,
    new MailIndexStore(db),
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
    "owner",
    () => NOW,
    FAST,
    new MailIndexStore(db),
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
    "owner",
    () => NOW,
    FAST,
    new MailIndexStore(db),
  ).start();
  await db.query("UPDATE mail_index_state SET model='older-model'");
  const reads = box.reads.length;
  const index = new MailIndex(
    box.gmail,
    words,
    "owner",
    () => NOW,
    FAST,
    new MailIndexStore(db),
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
    "owner",
    () => NOW,
    FAST,
    failing,
  );
  await first.start();
  assert.equal(first.state, "ready");
  assert.equal(first.messages, 3);
  const index = new MailIndex(
    box.gmail,
    words,
    "owner",
    () => NOW,
    FAST,
    new MailIndexStore(db),
  );
  await index.start();
  assert.equal(index.messages, 3);
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
    "owner",
    () => now,
    FAST,
    new MailIndexStore(db),
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
