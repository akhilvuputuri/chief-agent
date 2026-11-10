import test from "node:test";
import assert from "node:assert/strict";
import { closeAfter, migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import { studyLinkChoiceAsk, telegram } from "../src/telegram.js";
import { readConfig } from "../src/config.js";
import type { Assistant } from "../src/agent.js";
import { StudyLinks, linkChoiceButtons } from "../src/study-links.js";
import { readLinkClassifierConfig } from "../src/jev.js";
import type { LinkJudge } from "../src/jev.js";
import type { FeedFetcher } from "../src/news-feed.js";
import { mcpReaderLink, type ReaderLink } from "../src/news.js";
import { readerServer } from "./helpers/reader-mock.js";

const config = readLinkClassifierConfig();

const PAGE =
  "<html><head><title>Building agent architectures that hold up</title>" +
  '<meta property="og:description" content="Tool-using agent architectures.">' +
  "</head><body><article>text</article></body></html>";

/** The handler answers the callback first and finishes outside it, so wait for the reply. */
const waitFor = async (done: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > ms) throw new Error("The handler never replied");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

async function harness(
  t: any,
  options: {
    reader?: "accepted" | "uncertain";
    /** The real McpTools over a fake Reader server, exactly as src/mcp.ts behaves. */
    mcpReader?: boolean;
    readerFails?: "invalid";
    editFails?: boolean;
    links?: (links: StudyLinks) => any;
  } = {},
) {
  const pg = await migratedPGlite();
  closeAfter(t, pg);
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  await ensureUser(db, "456");
  const asked: { text: string; buttons: { text: string; data: string }[] }[] =
    [];
  const readerCalls: string[] = [];
  const mcpReader = readerServer();
  if (options.readerFails) mcpReader.fail(options.readerFails);
  let reader = options.reader ?? "accepted";
  const readerStub = {
    save: async (_user: string, key: string) => {
      readerCalls.push(key);
      return reader === "accepted"
        ? { state: "complete", result: { status: "prepared" } }
        : { state: "pending", category: "capacity", retryAfterSeconds: 30 };
    },
    savedArticles: async () => ({ articles: [], partial: false, skipped: 0 }),
  } as unknown as ReaderLink;
  const judge: LinkJudge = {
    judge: async () => ({
      ok: true,
      route: "unsure",
      confidence: 0.3,
      topic: null,
      kind: "other",
      model: null,
    }),
  };
  const fetcher: FeedFetcher = {
    get: async (url) => ({ body: PAGE, finalUrl: url }),
  };
  const links = new StudyLinks({
    db,
    judge,
    config,
    fetcher,
    memory: { active: async () => [] } as any,
    reader: () =>
      options.mcpReader ? mcpReaderLink(mcpReader.make(db)) : readerStub,
    ask: async (_user, message) => {
      asked.push(message);
      return { messageId: 400 };
    },
  });
  const saved: any = await links.save("123", {
    url: "https://example.org/agents",
    ownerMessage: "save this",
  });
  assert.equal(saved.outcome, "needs_choice");
  const tools = { studyLinks: options.links ? options.links(links) : links };
  const bot = telegram(
    readConfig({
      DATABASE_URL: "postgres://fixture",
      TELEGRAM_BOT_TOKEN: "123:long-test-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      TELEGRAM_TOPICS: "off",
    }),
    { tools } as unknown as Assistant,
    db,
  );
  const replies: string[] = [];
  const keyboards: any[] = [];
  const answers: string[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "getMe")
      return {
        ok: true,
        result: {
          id: 999,
          is_bot: true,
          first_name: "Fixture",
          username: "fixture_bot",
        },
      } as any;
    if (method === "sendMessage") replies.push((payload as any).text);
    if (method === "answerCallbackQuery") answers.push((payload as any).text);
    if (method === "editMessageReplyMarkup") {
      if (options.editFails) throw new Error("message can no longer be edited");
      keyboards.push((payload as any).reply_markup);
    }
    return { ok: true, result: true } as any;
  });
  await bot.init();
  const tap = (choice: string, decisionId: string, fromUser = 123) => ({
    update_id: 1,
    callback_query: {
      id: "callback",
      from: { id: fromUser, is_bot: false, first_name: "Owner" },
      chat_instance: "private",
      data: `lnk:${choice}:${decisionId}`,
      message: {
        message_id: 400,
        date: 0,
        chat: { id: 123, type: "private" },
        from: { id: 999, is_bot: true, first_name: "Fixture" },
        text: "Where should it go?",
      },
    },
  });
  return {
    db,
    bot,
    links,
    saved,
    asked,
    replies,
    keyboards,
    answers,
    readerCalls,
    mcpReader,
    setReader: (next: "accepted" | "uncertain") => {
      reader = next;
    },
    tap,
  };
}

test("the choice card goes through topic delivery and records the thread it reached", async (t) => {
  const pg = await migratedPGlite();
  closeAfter(t, pg);
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  const bot = telegram(
    readConfig({
      DATABASE_URL: "postgres://fixture",
      TELEGRAM_BOT_TOKEN: "123:long-test-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      TELEGRAM_TOPICS: "auto",
    }),
    { tools: {} } as unknown as Assistant,
    db,
  );
  const sent: any[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "getMe")
      return {
        ok: true,
        result: {
          id: 999,
          is_bot: true,
          first_name: "Fixture",
          username: "fixture_bot",
          has_topics_enabled: true,
        },
      } as any;
    if (method === "createForumTopic")
      return {
        ok: true,
        result: { message_thread_id: 77, name: "Main" },
      } as any;
    if (method === "sendMessage") {
      sent.push(payload);
      return {
        ok: true,
        result: {
          message_id: 501,
          date: 0,
          chat: { id: 123, type: "private" },
          message_thread_id: (payload as any).message_thread_id,
        },
      } as any;
    }
    return { ok: true, result: true } as any;
  });
  await bot.init();
  const ask = studyLinkChoiceAsk(bot as any);
  const id = "11111111-1111-4111-8111-111111111111";
  const out = await ask("123", {
    id,
    text: "Building agent architectures\n\nWhere should it go?",
    buttons: linkChoiceButtons(id),
  });
  // Main, like every other host card, and the thread it really reached is returned.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_thread_id, 77);
  assert.equal(out.messageId, 501);
  assert.equal(out.threadId, 77);
  assert.deepEqual(
    sent[0].reply_markup.inline_keyboard[0].map((b: any) => b.text),
    ["Study list", "Reader", "Both"],
  );
});

test("a tap whose Reader result is uncertain says so and keeps its buttons", async (t) => {
  const h = await harness(t, { reader: "uncertain" });
  await h.bot.handleUpdate(h.tap("reader", h.saved.decisionId) as any);
  await waitFor(() => h.replies.length > 0);
  assert.match(h.replies[0]!, /result is uncertain/i);
  assert.match(h.replies[0]!, /Reader may already have it/);
  assert.doesNotMatch(h.replies[0]!, /Nothing was written/);
  // The buttons stay, so the same tap can resume the unfinished request.
  assert.equal(h.keyboards.length, 1);
  assert.deepEqual(
    h.keyboards[0].inline_keyboard[0].map((b: any) => b.text),
    ["Study list", "Reader", "Both"],
  );
  // A second tap settles it and removes the keyboard.
  h.setReader("accepted");
  await h.bot.handleUpdate(h.tap("reader", h.saved.decisionId) as any);
  await waitFor(() => h.replies.length > 1);
  assert.match(h.replies[1]!, /Saved to Reader/);
  assert.deepEqual(h.keyboards.at(-1), { inline_keyboard: [] });
  assert.equal(h.readerCalls.length, 2);
  assert.equal(h.readerCalls[1], h.readerCalls[0]);
});

test("a failed message edit still reports the outcome and keeps the buttons working", async (t) => {
  const h = await harness(t, { reader: "uncertain", editFails: true });
  await h.bot.handleUpdate(h.tap("reader", h.saved.decisionId) as any);
  await waitFor(() => h.replies.length > 0);
  assert.match(h.replies[0]!, /result is uncertain/i);
  assert.equal(h.keyboards.length, 0);
  // The decision row is the state, so the same callback data still resumes.
  h.setReader("accepted");
  await h.bot.handleUpdate(h.tap("reader", h.saved.decisionId) as any);
  await waitFor(() => h.replies.length > 1);
  assert.match(h.replies[1]!, /Saved to Reader/);
});

test("an expired card that holds a partial write still settles and never says nothing was written", async (t) => {
  const h = await harness(t, { reader: "uncertain" });
  await h.bot.handleUpdate(h.tap("both", h.saved.decisionId) as any);
  await waitFor(() => h.replies.length > 0);
  assert.match(h.replies[0]!, /result is uncertain/i);
  // The study entry was written and the Reader request is still open, so the card keeps
  // its buttons for a later tap.
  assert.equal(h.keyboards.length, 1);
  // Two days pass without an answer.
  await h.db.query(
    "UPDATE link_decisions SET expires_at=now()-interval '1 hour' WHERE id=$1",
    [h.saved.decisionId],
  );
  h.setReader("accepted");
  await h.bot.handleUpdate(h.tap("both", h.saved.decisionId) as any);
  await waitFor(() => h.replies.length > 1);
  // Expiry applied only to a card that holds nothing: this one is resumed and reported
  // from its record, and its buttons settle the Reader request instead of being cleared.
  assert.doesNotMatch(h.replies[1]!, /expired/i);
  assert.doesNotMatch(h.replies[1]!, /nothing was written/i);
  assert.match(h.replies[1]!, /Reader/);
  const entries = (
    await h.db.query(
      "SELECT count(*)::int AS n FROM study_resources WHERE user_id='123'",
    )
  ).rows[0];
  assert.equal(entries.n, 1);
  const row = (
    await h.db.query(
      "SELECT state,reader_state FROM link_decisions WHERE id=$1",
      [h.saved.decisionId],
    )
  ).rows[0];
  assert.equal(row.state, "confirmed");
  assert.equal(row.reader_state, "accepted");
  assert.deepEqual(h.keyboards.at(-1), { inline_keyboard: [] });
});

test("a handler failure after a partial write never says nothing was written", async (t) => {
  const h = await harness(t, {
    links: (links) =>
      Object.assign(Object.create(links), {
        confirm: async () => {
          throw new Error("gateway restarted mid-call");
        },
      }),
  });
  await h.bot.handleUpdate(h.tap("both", h.saved.decisionId) as any);
  await waitFor(() => h.replies.length > 0);
  assert.match(h.replies[0]!, /result is uncertain/i);
  assert.match(h.replies[0]!, /check your study list and Reader/);
  assert.doesNotMatch(h.replies[0]!, /nothing was written/i);
});

test("a tap from someone else writes nothing, and a missing study list says so", async (t) => {
  const h = await harness(t);
  await h.bot.handleUpdate(h.tap("study", h.saved.decisionId, 456) as any);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(h.replies.length, 0);
  assert.equal(h.answers.length, 0);
  const row = (
    await h.db.query("SELECT state FROM link_decisions WHERE id=$1", [
      h.saved.decisionId,
    ])
  ).rows[0];
  assert.equal(row.state, "pending");
  const count = async () =>
    Number(
      (
        await h.db.query(
          "SELECT count(*)::int AS n FROM study_resources WHERE user_id='123'",
        )
      ).rows[0].n,
    );
  assert.equal(await count(), 0);

  const bare = telegram(
    readConfig({
      DATABASE_URL: "postgres://fixture",
      TELEGRAM_BOT_TOKEN: "123:long-test-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      TELEGRAM_TOPICS: "off",
    }),
    { tools: {} } as unknown as Assistant,
    h.db,
  );
  const answers: string[] = [];
  bare.api.config.use(async (_prev, method, payload) => {
    if (method === "getMe")
      return {
        ok: true,
        result: {
          id: 999,
          is_bot: true,
          first_name: "Fixture",
          username: "fixture_bot",
        },
      } as any;
    if (method === "answerCallbackQuery") answers.push((payload as any).text);
    return { ok: true, result: true } as any;
  });
  await bare.init();
  await bare.handleUpdate(h.tap("study", h.saved.decisionId) as any);
  assert.match(answers[0]!, /study list isn't available/);
  assert.equal(await count(), 0);
});

test("a Both tap writes both through the real Reader mock and clears the buttons", async (t) => {
  const h = await harness(t, { mcpReader: true });
  await h.bot.handleUpdate(h.tap("both", h.saved.decisionId) as any);
  await waitFor(() => h.replies.length > 0);
  assert.match(h.replies[0]!, /Saved to your study list and Reader/);
  assert.doesNotMatch(h.replies[0]!, /Nothing was written/);
  const entries = (
    await h.db.query(
      "SELECT url,reader_saved FROM study_resources WHERE user_id='123'",
    )
  ).rows;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, "https://example.org/agents");
  assert.equal(entries[0].reader_saved, true);
  // Reader got the one normalised URL, once, and the operation is complete.
  assert.equal(h.mcpReader.calls.length, 1);
  assert.equal(h.mcpReader.calls[0]!.url, "https://example.org/agents");
  const operations = (
    await h.db.query(
      "SELECT state,payload FROM mcp_operations WHERE user_id='123' AND tool='save_link'",
    )
  ).rows;
  assert.equal(operations.length, 1);
  assert.equal(operations[0].state, "complete");
  assert.equal(operations[0].payload.url, "https://example.org/agents");
  // The finished card loses its buttons.
  assert.deepEqual(h.keyboards.at(-1), { inline_keyboard: [] });
});

test("a Both tap whose Reader write is refused names the study entry and keeps the buttons", async (t) => {
  const h = await harness(t, { mcpReader: true, readerFails: "invalid" });
  await h.bot.handleUpdate(h.tap("both", h.saved.decisionId) as any);
  await waitFor(() => h.replies.length > 0);
  assert.match(h.replies[0]!, /Saved to your study list/);
  assert.match(h.replies[0]!, /Reader refused/);
  assert.doesNotMatch(h.replies[0]!, /Nothing was written/);
  assert.match(h.replies[0]!, /tap again/i);
  // The entry is saved, the Reader half is recorded as refused, and the card stays tappable.
  const entries = (
    await h.db.query(
      "SELECT reader_saved FROM study_resources WHERE user_id='123'",
    )
  ).rows;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reader_saved, false);
  const row = (
    await h.db.query(
      "SELECT reader_state,study_state FROM link_decisions WHERE id=$1",
      [h.saved.decisionId],
    )
  ).rows[0];
  assert.equal(row.study_state, "done");
  assert.equal(row.reader_state, "rejected");
  assert.deepEqual(
    h.keyboards.at(-1).inline_keyboard[0].map((b: any) => b.text),
    ["Study list", "Reader", "Both"],
  );
  // A second tap retries only the Reader half, under a new key, and finishes the card.
  h.mcpReader.fail(null);
  await h.bot.handleUpdate(h.tap("both", h.saved.decisionId) as any);
  await waitFor(() => h.replies.length > 1);
  assert.match(h.replies[1]!, /Saved to your study list and Reader/);
  assert.notEqual(h.mcpReader.calls[1]!.key, h.mcpReader.calls[0]!.key);
  assert.deepEqual(h.keyboards.at(-1), { inline_keyboard: [] });
});
