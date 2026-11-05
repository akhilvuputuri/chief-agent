import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import { readConfig } from "../src/config.js";
import { telegram, sendLinkChoices } from "../src/telegram.js";
import { Study } from "../src/study.js";
import { LinkRouter } from "../src/link-router.js";
import { readDecisionConfig } from "../src/decision-config.js";
import type { Assistant } from "../src/agent.js";

const config = readDecisionConfig();
const jev = async () =>
  new Response(
    JSON.stringify({
      answers: {
        route: {
          choice: "study",
          probabilities: { study: 0.9, reader: 0.05, both: 0.05 },
        },
        topic: {
          choice: "agent-platforms",
          probabilities: { "agent-platforms": 0.9 },
        },
        unsure: { noul: 0.05 },
      },
      usage: { cost: 0.00001 },
      model: "typesafe/jev-1.13-20260917",
    }),
  );

async function fixture(
  readerImpl: {
    save: (
      user: string,
      key: string,
      url: string,
    ) => Promise<{ state: string; result?: { status: string } }>;
  } = {
    save: async () => ({ state: "complete", result: { status: "queued" } }),
  },
) {
  const pg = await migratedPGlite();
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  await ensureUser(db, "456");
  const run = randomUUID();
  await db.query("INSERT INTO runtime_runs(id,user_id) VALUES($1,$2)", [
    run,
    "123",
  ]);
  const study = new Study(db, {
    router: new LinkRouter("test-key", config, jev as any),
    reader: readerImpl,
    fetcher: {
      get: async (url: string) => ({
        body: "<html><head><title>Tap me</title></head></html>",
        finalUrl: url,
      }),
    } as any,
  });
  const prompt = randomUUID();
  await db.query(
    `INSERT INTO link_saves(id,user_id,canonical_url,page_url,title,site,topic,route,reason,confidence,run_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,'unsure',$8,$9,$10)`,
    [
      prompt,
      "123",
      "example.com/tap",
      "https://example.com/tap",
      "Tap me",
      "Example",
      "agent-platforms",
      "Jev was not confident enough (study 0.55, unsure 0.10).",
      0.55,
      run,
    ],
  );
  const sent: any[] = [];
  const edited: any[] = [];
  const assistant = {
    tools: { study },
    isCurrentRun: async () => true,
    isCurrentDelivery: async () => true,
  } as unknown as Assistant;
  const c = readConfig({
    DATABASE_URL: "postgres://x:x@localhost/x",
    TELEGRAM_BOT_TOKEN: "123:long-test-token",
    TELEGRAM_ALLOWED_USER_IDS: "123",
  });
  const bot = telegram(c, assistant, db);
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "getMe")
      return {
        ok: true,
        result: {
          id: 999,
          is_bot: true,
          first_name: "Test",
          username: "test_bot",
        },
      };
    if (method === "sendMessage") {
      sent.push(payload);
      return { ok: true, result: { message_id: 100 + sent.length } } as any;
    }
    if (method === "editMessageReplyMarkup") edited.push(payload);
    return { ok: true, result: true } as any;
  });
  await bot.init();
  return { pg, db, run, study, prompt, bot, sent, edited };
}

const press = (id: number, data: string, user = 123, messageId = 55) =>
  ({
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: user, is_bot: false, first_name: "Test" },
      chat_instance: "test",
      data,
      message: {
        message_id: messageId,
        date: 0,
        chat: { id: user, type: "private" },
        text: "Where should I save this?",
      },
    },
  }) as any;

test("an unsure link save shows three tap options and one tap writes once", async () => {
  const f = await fixture();
  try {
    await sendLinkChoices(f.bot, f.study, "123", undefined, undefined, f.run);
    assert.equal(f.sent.length, 1);
    const buttons = f.sent[0].reply_markup.inline_keyboard.flat();
    assert.deepEqual(
      buttons.map((b: any) => b.text),
      ["Study list", "Reader", "Both"],
    );
    assert.deepEqual(
      buttons.map((b: any) => b.callback_data),
      [
        `lnk:study:${f.prompt}`,
        `lnk:reader:${f.prompt}`,
        `lnk:both:${f.prompt}`,
      ],
    );
    // The prompt is bound to the delivered message before any tap can write.
    const bound = (
      await f.db.query(
        "SELECT telegram_message_id FROM link_saves WHERE id=$1",
        [f.prompt],
      )
    ).rows[0];
    assert.equal(Number(bound.telegram_message_id), 101);

    await f.bot.handleUpdate(press(1, `lnk:study:${f.prompt}`, 123, 101));
    assert.equal(
      (await f.db.query("SELECT 1 FROM study_resources")).rows.length,
      1,
    );
    assert.match(f.sent.at(-1).text, /Saved to your study list: Tap me/);
    assert.equal(f.edited.length, 1);

    // A second press of the same card writes nothing.
    await f.bot.handleUpdate(press(2, `lnk:reader:${f.prompt}`, 123, 101));
    assert.equal(
      (await f.db.query("SELECT 1 FROM study_resources")).rows.length,
      1,
    );
    assert.match(f.sent.at(-1).text, /already handled or no longer available/);
  } finally {
    await f.pg.close();
  }
});

test("a foreign user or a view callback cannot write the study list", async () => {
  const f = await fixture();
  try {
    await sendLinkChoices(f.bot, f.study, "123", undefined, undefined, f.run);
    await f.bot.handleUpdate(press(1, `lnk:study:${f.prompt}`, 456, 101));
    assert.equal(
      (await f.db.query("SELECT 1 FROM study_resources")).rows.length,
      0,
    );
    // A read-only view callback with the same message cannot authorize a write either.
    await f.bot.handleUpdate(press(2, `v:${"a".repeat(32)}:0:0`, 123, 101));
    assert.equal(
      (await f.db.query("SELECT 1 FROM study_resources")).rows.length,
      0,
    );
    const row = (
      await f.db.query("SELECT route,claimed_at FROM link_saves WHERE id=$1", [
        f.prompt,
      ])
    ).rows[0];
    assert.equal(row.route, "unsure");
    assert.equal(row.claimed_at, null);
  } finally {
    await f.pg.close();
  }
});

test("a failed Reader tap keeps the buttons and a retry finishes it", async () => {
  let fail = true;
  const f = await fixture({
    save: async () => {
      if (fail) throw new Error("Reader timed out");
      return { state: "complete", result: { status: "queued" } };
    },
  });
  try {
    await sendLinkChoices(f.bot, f.study, "123", undefined, undefined, f.run);
    await f.bot.handleUpdate(press(1, `lnk:reader:${f.prompt}`, 123, 101));
    assert.equal(f.edited.length, 0);
    assert.match(f.sent.at(-1).text, /Could not confirm/);
    const row = (
      await f.db.query("SELECT route,claimed_at FROM link_saves WHERE id=$1", [
        f.prompt,
      ])
    ).rows[0];
    assert.equal(row.route, "unsure");
    assert.equal(row.claimed_at, null);

    fail = false;
    await f.bot.handleUpdate(press(2, `lnk:reader:${f.prompt}`, 123, 101));
    assert.equal(f.edited.length, 1);
    assert.match(f.sent.at(-1).text, /Saved to Reader for offline reading/);
  } finally {
    await f.pg.close();
  }
});

test("two delivery paths send one card for the same unsure save", async () => {
  const f = await fixture();
  try {
    // The interactive turn and the background work delivery can both run for one save.
    await Promise.all([
      sendLinkChoices(f.bot, f.study, "123", undefined, undefined, f.run),
      sendLinkChoices(f.bot, f.study, "123", undefined, undefined, f.run),
    ]);
    assert.equal(f.sent.length, 1);
    const bound = (
      await f.db.query(
        "SELECT telegram_message_id FROM link_saves WHERE id=$1",
        [f.prompt],
      )
    ).rows[0];
    assert.equal(Number(bound.telegram_message_id), 101);
  } finally {
    await f.pg.close();
  }
});
