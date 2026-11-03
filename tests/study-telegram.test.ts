import test from "node:test";
import assert from "node:assert/strict";
import { migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import { Study } from "../src/study.js";
import { readLinkRouting } from "../src/link-router.js";
import type { ReaderLink } from "../src/news.js";
import { Assistant } from "../src/agent.js";
import { JobTools } from "../src/tools.js";
import { telegram } from "../src/telegram.js";
import { readConfig } from "../src/config.js";

const config = readLinkRouting();
const page = `<html><head><title>A thread on agent architectures</title><meta property="og:site_name" content="x.com"></head><body></body></html>`;

const unsure = {
  config,
  model: "typesafe/jev-test",
  async classify() {
    return {
      ok: true,
      verdict: "unsure" as const,
      probabilities: { study: 0.4, reader: 0.38 },
      confidence: 0.4,
      model: "typesafe/jev-test",
      latencyMs: 1,
      costUsd: 0,
    };
  },
};

async function fixture() {
  const pg = await migratedPGlite();
  const db = pg as unknown as Database;
  const user = "123";
  await ensureUser(db, user);
  const saved: string[] = [];
  const reader: ReaderLink = {
    save: async (_user, _key, url) => {
      saved.push(url);
      return { state: "complete" };
    },
    savedArticles: async () => ({ articles: [], partial: false, skipped: 0 }),
  };
  const study = new Study(db, {
    classifier: unsure,
    fetcher: { get: async (url: string) => ({ body: page, finalUrl: url }) },
    reader: () => reader,
  });
  const tools = new JobTools(db, { call: async () => ({}) });
  tools.study = study;
  const assistant = new Assistant(
    db,
    {
      run: async () => ({
        reply: "I have asked where it should go.",
        history: [],
      }),
    },
    tools,
  );
  const c = readConfig({
    DATABASE_URL: "postgres://x:x@localhost/x",
    TELEGRAM_BOT_TOKEN: "123:long-test-token",
    TELEGRAM_ALLOWED_USER_IDS: user,
  });
  const bot = telegram(c, assistant, db);
  const sent: any[] = [];
  const answers: string[] = [];
  bot.api.config.use(async (_prev, method, payload: any) => {
    if (method === "getMe")
      return {
        ok: true,
        result: {
          id: 999,
          is_bot: true,
          first_name: "Test",
          username: "test_bot",
        },
      } as any;
    if (method === "sendMessage") sent.push(payload);
    if (method === "answerCallbackQuery") answers.push(payload.text ?? "");
    return {
      ok: true,
      result: {
        message_id: sent.length + 1,
        date: 0,
        chat: { id: user, type: "private" },
        text: "",
      },
    } as any;
  });
  await bot.init();
  return { pg, db, bot, study, saved, sent, answers };
}

const message = (id: number, text: string) =>
  ({
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: 123, type: "private" },
      from: { id: 123, is_bot: false, first_name: "Test" },
      text,
    },
  }) as any;

const tap = (id: number, data: string) =>
  ({
    update_id: id,
    callback_query: {
      id: String(id),
      from: { id: 123, is_bot: false, first_name: "Test" },
      chat_instance: "chat",
      data,
      message: {
        message_id: id,
        date: 0,
        chat: { id: 123, type: "private" },
        text: "Where should this go?",
      },
    },
  }) as any;

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "timed out waiting for the outcome");
};

test("an unsure link asks with three taps and the owner's choice is stored", async () => {
  const f = await fixture();
  try {
    const ask: any = await f.study.saveLink("123", {
      url: "https://x.com/someone/status/42",
      ownerMessage: "save this",
    });
    assert.equal(ask.needsChoice, true);
    await f.bot.handleUpdate(
      message(1, "save this https://x.com/someone/status/42"),
    );
    // The ask card lands after the reply, with one tap per destination.
    await until(() => f.sent.some((m) => m.reply_markup?.inline_keyboard));
    const card = f.sent.find((m) => m.reply_markup?.inline_keyboard)!;
    assert.match(card.text, /A thread on agent architectures/);
    assert.match(card.text, /Not saved yet/);
    const buttons = card.reply_markup.inline_keyboard[0];
    assert.deepEqual(
      card.reply_markup.inline_keyboard.flat().map((b: any) => b.text),
      ["Study list", "Reader", "Both"],
    );
    assert.equal(buttons[0].callback_data, `ls:st:${ask.promptId}`);
    assert.equal(
      card.reply_markup.inline_keyboard[0][1].callback_data,
      `ls:rd:${ask.promptId}`,
    );
    // A card is announced once, not on every following turn.
    f.sent.length = 0;
    await f.bot.handleUpdate(message(2, "thanks"));
    assert.equal(
      f.sent.filter((m) => m.reply_markup?.inline_keyboard).length,
      0,
    );

    await f.bot.handleUpdate(tap(3, `ls:st:${ask.promptId}`));
    await until(() =>
      f.sent.some((m) => /Saved to your study list/.test(m.text)),
    );
    assert.ok(f.answers.some((t) => /Saving/.test(t)));
    const row = (await f.db.query("SELECT * FROM study_resources")).rows[0]!;
    assert.equal(row.url, "https://x.com/someone/status/42");
    assert.equal(row.title, "A thread on agent architectures");
    assert.equal(row.source, "x.com");
    assert.equal(f.saved.length, 0);
    // Tapping again changes nothing.
    await f.bot.handleUpdate(tap(4, `ls:rd:${ask.promptId}`));
    await until(() => f.sent.some((m) => /already answered/.test(m.text)));
    assert.equal(f.saved.length, 0);
  } finally {
    await f.pg.close();
  }
});

test("a tap for Reader saves there and leaves the study list alone", async () => {
  const f = await fixture();
  try {
    const ask: any = await f.study.saveLink("123", {
      url: "https://example.com/essay",
    });
    await f.bot.handleUpdate(tap(1, `ls:rd:${ask.promptId}`));
    await until(() => f.sent.some((m) => /Saved to Reader/.test(m.text)));
    assert.deepEqual(f.saved, ["https://example.com/essay"]);
    assert.equal(
      (await f.db.query("SELECT * FROM study_resources")).rows.length,
      0,
    );
  } finally {
    await f.pg.close();
  }
});

test("a tap from another chat is ignored", async () => {
  const f = await fixture();
  try {
    const ask: any = await f.study.saveLink("123", {
      url: "https://example.com/essay",
    });
    const foreign = tap(1, `ls:st:${ask.promptId}`);
    foreign.callback_query.from.id = 456;
    foreign.callback_query.message.chat.id = 456;
    await f.bot.handleUpdate(foreign);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.answers.length, 0);
    assert.equal(
      (await f.db.query("SELECT * FROM study_resources")).rows.length,
      0,
    );
  } finally {
    await f.pg.close();
  }
});
