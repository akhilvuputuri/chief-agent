import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { secretKey } from "../src/secret-box.js";
import { LibraryClient } from "../src/library-client.js";
import { PostgresPacing } from "../src/library-pacing.js";
import { LibraryIdentity } from "../src/library-identity.js";
import { LinkCeremony } from "../src/library-link.js";
import { LibraryActions } from "../src/library-actions.js";
import { LibraryTools } from "../src/library.js";
import { JobTools } from "../src/tools.js";
import { telegram, sendLibraryApprovals } from "../src/telegram.js";
import { readConfig } from "../src/config.js";

const KEY = secretKey("cd".repeat(32));
const TOKEN =
  "eyJhbGciOiJIUzI1NiJ9.eyJjaGlwIjoiYXBwcm92YWx0ZXN0In0.YXBwcm92YWxzaWduYXR1cmVzaWc";

async function fixture() {
  const pg = new PGlite();
  for (const name of (await readdir(new URL("../db/", import.meta.url)))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL(`../db/${name}`, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  await ensureUser(db, "456");
  let now = Date.UTC(2026, 8, 20, 4, 0, 0);
  const calls: string[] = [];
  const client = new LibraryClient({
    pacing: new PostgresPacing(db, () => now),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    request: (async (input: any, init: any) => {
      const url = new URL(input);
      calls.push(`${init.method} ${url.pathname}`);
      if (url.pathname === "/chip")
        return Response.json({
          identity: TOKEN,
          expiry: Math.floor(now / 1000) + 604800,
        });
      if (url.pathname === "/chip/clone/code")
        return Response.json({ result: "fulfilled" });
      if (url.pathname === "/chip/sync")
        return Response.json({
          cards: [{ cardId: "c9", advantageKey: "nlb" }],
          loans: [],
          holds: [],
        });
      return Response.json({});
    }) as typeof fetch,
  });
  const identity = new LibraryIdentity(db, client, KEY, () => now);
  const edits: string[] = [];
  let actions: LibraryActions;
  const link = new LinkCeremony(
    db,
    client,
    identity,
    {
      editMessageText: async (_c: string, _m: number, text: string) => {
        edits.push(text);
      },
    },
    (u, a, o) => actions.linkFinished(u, a, o),
    () => now,
    async (ms) => {
      now += ms;
    },
  );
  actions = new LibraryActions(db, { identity, link, client }, "123");
  const tools = new JobTools(
    db,
    { call: async () => ({}) },
    undefined,
    undefined,
    undefined,
    undefined,
    new LibraryTools(client, () => now, identity),
    actions,
  );
  const bot = telegram(
    readConfig({
      DATABASE_URL: "postgres://x:x@localhost/x",
      TELEGRAM_BOT_TOKEN: "123:test-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
    }),
    { tools } as any,
    db,
  );
  const sent: any[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "getMe")
      return {
        ok: true,
        result: { id: 999, is_bot: true, first_name: "T", username: "t_bot" },
      } as any;
    if (method === "sendMessage") sent.push(payload);
    if (method === "editMessageText") edits.push((payload as any).text);
    return { ok: true, result: { message_id: 11 + sent.length } } as any;
  });
  await bot.init();
  return { pg, db, bot, sent, edits, calls, actions, tools, identity };
}
const callback = (user: number, data: string, type = "private") =>
  ({
    update_id: Math.floor(Math.random() * 1e9),
    callback_query: {
      id: "q",
      chat_instance: "x",
      from: { id: user, is_bot: false, first_name: "T" },
      data,
      message: { message_id: 12, date: 0, chat: { id: user, type } },
    },
  }) as any;
const message = (user: number, text: string) =>
  ({
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: 5,
      date: 0,
      text,
      chat: { id: user, type: "private" },
      from: { id: user, is_bot: false, first_name: "T" },
    },
  }) as any;
async function settled(db: Database, id: string) {
  for (let i = 0; i < 200; i++) {
    const e = (
      await db.query(
        "SELECT payload->>'execution' e FROM approvals WHERE id=$1",
        [id],
      )
    ).rows[0]?.e;
    if (e && e !== "executing") return e;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("did not settle");
}

test("/library commands are host-only, claim the update, send one card, and only the owner's tap starts linking", async () => {
  const f = await fixture();
  try {
    await f.bot.handleUpdate(message(123, "/library"));
    assert.match(f.sent.at(-1).text, /No library card is linked/);
    await f.bot.handleUpdate(message(123, "/library link"));
    assert.match(f.sent.at(-2).text, /Sent you a card/);
    const card = f.sent.at(-1);
    assert.match(card.text, /Link your NLB Libby card/);
    assert.match(card.text, /Approve by \d\d:\d\d SGT/);
    const id =
      card.reply_markup.inline_keyboard[0][0].callback_data.split(":")[2];
    assert.equal(card.reply_markup.inline_keyboard[0][0].text, "Start linking");
    // Idempotent sender and redelivered updates: nothing extra is sent.
    await sendLibraryApprovals(f.bot, f.db, "123");
    const before = f.sent.length;
    const dup = message(123, "/library link");
    await f.bot.handleUpdate(dup);
    await f.bot.handleUpdate(dup);
    assert.equal(f.sent.length, before + 1);
    assert.match(f.sent.at(-1).text, /already waiting/);
    // Strangers and group chats never reach decide; /approve text cannot approve a library card.
    await f.bot.handleUpdate(callback(456, `lib:yes:${id}`));
    await f.bot.handleUpdate(callback(123, `lib:yes:${id}`, "group"));
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.tools.decide("123", id, true));
    await f.bot.handleUpdate(callback(123, `lib:yes:${id}`));
    assert.equal(await settled(f.db, id), "created");
    assert.equal((await f.identity.row("123"))?.state, "linked");
    assert.ok(f.calls.includes("POST /chip/clone"));
    // A second tap on the used card is refused without any request.
    const n = f.calls.length;
    await f.bot.handleUpdate(callback(123, `lib:yes:${id}`));
    assert.equal(f.calls.length, n);
    await f.bot.handleUpdate(message(123, "/library"));
    assert.match(f.sent.at(-1).text, /Card: linked/);
    assert.ok(!JSON.stringify(f.sent).includes(TOKEN));
    assert.ok(!JSON.stringify(f.sent).includes("c9"));
  } finally {
    await f.pg.close();
  }
});

test("revoke needs its own card, denies pending library cards, and the abort callback never queues", async () => {
  const f = await fixture();
  try {
    await f.bot.handleUpdate(message(123, "/library revoke"));
    assert.match(f.sent.at(-1).text, /No Libby link/);
    await f.db.query(
      "INSERT INTO library_identities(user_id,state,card_id,token_box,token_expires_at) VALUES('123','linked','c9',$1,now()+interval '6 days')",
      [Buffer.from([1, 2, 3])],
    );
    await f.bot.handleUpdate(message(123, "/library revoke"));
    const card = f.sent.at(-1);
    assert.match(card.text, /Disconnect Libby/);
    const id =
      card.reply_markup.inline_keyboard[0][0].callback_data.split(":")[2];
    await f.bot.handleUpdate(callback(123, `lib:no:${id}`));
    assert.match(f.sent.at(-1).text, /Still linked/);
    assert.equal((await f.identity.row("123"))?.state, "linked");
    await f.bot.handleUpdate(message(123, "/library revoke"));
    const second = f.sent
      .at(-1)
      .reply_markup.inline_keyboard[0][0].callback_data.split(":")[2];
    await f.bot.handleUpdate(callback(123, `lib:yes:${second}`));
    // The stored box was not sealed by us, so decryption fails: local wipe still happens, remote is not confirmed.
    assert.match(
      f.sent.at(-1).text,
      /Local access removed|Disconnected|unavailable/,
    );
    const attempt = randomUUID();
    await f.db.query(
      "INSERT INTO library_link_attempts(id,user_id,approval_id,direction,state,deadline_at) VALUES($1,'123',$2,'display','displaying',now()+interval '5 minutes')",
      [attempt, randomUUID()],
    );
    await f.bot.handleUpdate(callback(456, `lib:abort:${attempt}`));
    assert.equal(
      (
        await f.db.query(
          "SELECT abort_requested a FROM library_link_attempts WHERE id=$1",
          [attempt],
        )
      ).rows[0].a,
      false,
    );
    await f.bot.handleUpdate(callback(123, `lib:abort:${attempt}`));
    assert.equal(
      (
        await f.db.query(
          "SELECT abort_requested a FROM library_link_attempts WHERE id=$1",
          [attempt],
        )
      ).rows[0].a,
      true,
    );
    // Expired pending cards are retired before a new draft, so the unique index never blocks re-offers.
    const stale = randomUUID();
    await f.db.query(
      "INSERT INTO approvals(id,user_id,run_id,operation,payload,expires_at) VALUES($1,'123',$2,'library_link','{\"draft\":{},\"execution\":\"not_started\"}',now()-interval '1 minute')",
      [stale, randomUUID()],
    );
    await f.actions.draft(
      "123",
      randomUUID(),
      "library_link",
      {},
      { source: "command" },
    );
    assert.equal(
      (await f.db.query("SELECT status FROM approvals WHERE id=$1", [stale]))
        .rows[0].status,
      "denied",
    );
    // Historical migrations re-run with library rows present.
    for (const name of ["003_skills", "009_calendar_approval", "016_library"])
      await f.pg.exec(
        await readFile(new URL(`../db/${name}.sql`, import.meta.url), "utf8"),
      );
    assert.ok(
      (
        await f.db.query(
          "SELECT count(*)::int n FROM approvals WHERE operation LIKE 'library\\_%'",
        )
      ).rows[0].n >= 3,
    );
  } finally {
    await f.pg.close();
  }
});
