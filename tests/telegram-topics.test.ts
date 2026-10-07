import { Voice } from "../src/providers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { Bot, GrammyError } from "grammy";
import { ensureUser, type Database } from "../src/db.js";
import {
  TelegramTopics,
  inThread,
  threadOf,
  routeUnthreadedToMain,
} from "../src/telegram-topics.js";
import { TelegramViews } from "../src/telegram-views.js";
import {
  telegram,
  sendCalendarApprovals,
  sendSlowPointer,
} from "../src/telegram.js";
import { CalendarActions } from "../src/calendar-actions.js";
import { randomUUID, createHash } from "node:crypto";
import { readConfig } from "../src/config.js";
import { Assistant } from "../src/agent.js";
import { JobTools } from "../src/tools.js";

async function database() {
  const pg = new PGlite();
  for (const f of (await readdir(new URL("../db/", import.meta.url)))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + f, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  return { pg, db };
}

function fakeApi(enabled = true) {
  let next = 40;
  const created: string[] = [];
  return {
    created,
    api: {
      getMe: async () => ({ has_topics_enabled: enabled }) as any,
      createForumTopic: async (_chat: string | number, name: string) => {
        created.push(name);
        await new Promise((r) => setTimeout(r, 5));
        return {
          message_thread_id: next++,
          name,
        } as any;
      },
    },
  };
}

test("Updates is renamed in place without duplicate topics, and old queued feed targets go to General", async () => {
  const { pg, db } = await database();
  const { api, created } = fakeApi();
  const h = createHash("sha256")
    .update("telegram-topic:123:updates")
    .digest("hex");
  const run = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  await db.query(
    "INSERT INTO events(user_id,run_id,type,data) VALUES('123',$1,'telegram.topic',$2::jsonb)",
    [run, JSON.stringify({ key: "updates", threadId: 77 })],
  );
  const edits: unknown[] = [];
  let loseAck = true;
  const topics = new TelegramTopics(db, {
    ...api,
    editForumTopic: async (
      _user: unknown,
      thread: unknown,
      options: unknown,
    ) => {
      edits.push([thread, options]);
      if (loseAck) {
        loseAck = false;
        throw new Error("unknown rename acknowledgement");
      }
      return true;
    },
  } as any);
  try {
    await topics.ensure("123");
    assert.equal(await topics.keyFor("123", 77), "coding");
    await topics.ensure("123");
    await topics.ensure("123");
    assert.deepEqual(created, ["News", "Markets", "Main"]);
    assert.deepEqual(edits, [
      [77, { name: "Coding" }],
      [77, { name: "Coding" }],
    ]);
    const sent: unknown[] = [];
    await topics.deliver(
      "123",
      { kind: "topic", topic: "updates" },
      async (extra) => sent.push(extra),
    );
    await topics.deliver(
      "123",
      { kind: "topic", topic: "coding" },
      async (extra) => sent.push(extra),
    );
    assert.deepEqual(sent, [
      { message_thread_id: 42 },
      { message_thread_id: 77 },
    ]);
    assert.deepEqual(
      await topics.capture("123", { kind: "topic", topic: "updates" }),
      { kind: "thread", threadId: 42 },
    );
  } finally {
    await pg.close();
  }
});

test("thread helpers leave General and plain messages without a thread id", () => {
  assert.deepEqual(inThread(undefined), {});
  assert.deepEqual(inThread(1), {});
  assert.deepEqual(inThread(42), { message_thread_id: 42 });
  assert.equal(threadOf({ message_thread_id: 42 }), undefined);
  assert.equal(threadOf({ is_topic_message: true, message_thread_id: 42 }), 42);
  assert.equal(
    threadOf({ is_topic_message: true, message_thread_id: 1 }),
    undefined,
  );
});

test("a topic is created once, reused, and sends go into it", async () => {
  const { pg, db } = await database();
  const { api, created } = fakeApi();
  const topics = new TelegramTopics(db, api);
  try {
    const sends: any[] = [];
    const send = (extra: any) => (sends.push(extra), Promise.resolve(true));
    // Concurrent first sends share one creation.
    await Promise.all([
      topics.send("123", "news", send),
      topics.send("123", "news", send),
    ]);
    await topics.send("123", "news", send);
    await topics.send("123", "markets", send);
    assert.deepEqual(created, ["News", "Markets"]);
    assert.deepEqual(
      sends.slice(0, 3),
      Array(3).fill({ message_thread_id: 40 }),
    );
    assert.deepEqual(sends[3], { message_thread_id: 41 });
    // A restart reads the stored id instead of creating another topic.
    const again = new TelegramTopics(db, fakeApi().api);
    assert.equal(await again.thread("123", "news"), 40);
  } finally {
    await pg.close();
  }
});

test("without threaded mode, with the switch off, or if creation fails, sends go to General", async () => {
  const { pg, db } = await database();
  try {
    const off = fakeApi(false);
    const sends: any[] = [];
    const send = (extra: any) => (sends.push(extra), Promise.resolve(true));
    await new TelegramTopics(db, off.api).send("123", "news", send);
    const disabled = fakeApi();
    await new TelegramTopics(db, disabled.api, false).send("123", "news", send);
    const failing = new TelegramTopics(db, {
      getMe: async () => ({ has_topics_enabled: true }) as any,
      createForumTopic: async () => {
        throw new Error("Bad Request: the chat is not a forum");
      },
    });
    await failing.send("123", "news", send);
    assert.deepEqual(sends, [{}, {}, {}]);
    assert.deepEqual([...off.created, ...disabled.created], []);
  } finally {
    await pg.close();
  }
});

test("a topic the owner deleted is forgotten and recreated, and the send is retried once", async () => {
  const { pg, db } = await database();
  const { api, created } = fakeApi();
  const topics = new TelegramTopics(db, api);
  try {
    assert.equal(await topics.thread("123", "news"), 40);
    const sends: any[] = [];
    const result = await topics.send("123", "news", async (extra) => {
      sends.push(extra);
      if (extra.message_thread_id === 40)
        throw new GrammyError(
          "Call to 'sendMessage' failed!",
          {
            ok: false,
            error_code: 400,
            description: "Bad Request: message thread not found",
          },
          "sendMessage",
          {},
        );
      return "sent";
    });
    assert.equal(result, "sent");
    assert.deepEqual(sends, [
      { message_thread_id: 40 },
      { message_thread_id: 41 },
    ]);
    assert.deepEqual(created, ["News", "News"]);
    // Any other failure is not retried.
    await assert.rejects(
      topics.send("123", "news", async () => {
        throw new Error("Forbidden: bot was blocked by the user");
      }),
      /blocked/,
    );
  } finally {
    await pg.close();
  }
});

test("views deliver every part of an answer into the given topic", async () => {
  const { pg, db } = await database();
  const sent: any[] = [];
  const views = new TelegramViews(db, {
    sendMessage: async (chat: string, text: string, options: any) => {
      sent.push({ chat, text, ...options });
      return { message_id: sent.length } as any;
    },
    editMessageText: async () => true as any,
  });
  try {
    await views.deliver("123", { id: "123", thread: 77 }, "Short reply");
    await views.deliver(
      "123",
      { id: "123", thread: 77 },
      {
        reply: "Long ".repeat(1200),
      },
    );
    await views.deliver("123", "123", "In General");
    assert.equal(sent.length, 3);
    assert.equal(sent[0].message_thread_id, 77);
    assert.equal(sent[1].message_thread_id, 77);
    assert.ok(sent[1].reply_markup, "a long answer opens an interactive view");
    assert.equal(sent[2].message_thread_id, undefined);
  } finally {
    await pg.close();
  }
});

test("a message typed in a topic is answered in that topic; General stays plain", async () => {
  const { pg, db } = await database();
  const assistant = new Assistant(
    db,
    {
      run: async (req) => ({
        reply: `Understood: ${req.message}`,
        history: [...req.history, { role: "user", content: req.message }],
      }),
    },
    new JobTools(db, { call: async () => ({}) }),
  );
  const bot = telegram(
    readConfig({
      DATABASE_URL: "postgres://x:x@localhost/x",
      TELEGRAM_BOT_TOKEN: "123:long-test-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
    }),
    assistant,
    db,
  );
  const calls: { method: string; payload: any }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    if (method === "getMe")
      return {
        ok: true,
        result: { id: 999, is_bot: true, first_name: "T", username: "t_bot" },
      } as any;
    if (method === "sendMessage")
      return { ok: true, result: { message_id: calls.length } } as any;
    return { ok: true, result: true } as any;
  });
  await bot.init();
  const update = (id: number, topic?: number) =>
    ({
      update_id: id,
      message: {
        message_id: id,
        date: 0,
        chat: { id: 123, type: "private" },
        from: { id: 123, is_bot: false, first_name: "T" },
        text: `message ${id}`,
        ...(topic ? { is_topic_message: true, message_thread_id: topic } : {}),
      },
    }) as any;
  try {
    await bot.handleUpdate(update(1, 55));
    await bot.handleUpdate(update(2));
    const replies = calls.filter((c) => c.method === "sendMessage");
    assert.equal(replies.length, 2);
    assert.equal(replies[0]!.payload.message_thread_id, 55);
    assert.equal(replies[1]!.payload.message_thread_id, undefined);
    const typing = calls.find((c) => c.method === "sendChatAction");
    assert.equal(typing?.payload.message_thread_id, 55);
  } finally {
    await pg.close();
  }
});

test("a closed topic sends to General, and a topic is used even if recording it fails", async () => {
  const { pg, db } = await database();
  try {
    const { api } = fakeApi();
    const topics = new TelegramTopics(db, api);
    assert.equal(await topics.thread("123", "news"), 40);
    const sends: any[] = [];
    await topics.send("123", "news", async (extra) => {
      sends.push(extra);
      if (extra.message_thread_id)
        throw new GrammyError(
          "Call to 'sendMessage' failed!",
          {
            ok: false,
            error_code: 400,
            description: "Bad Request: TOPIC_CLOSED",
          },
          "sendMessage",
          {},
        );
      return true;
    });
    assert.deepEqual(sends, [{ message_thread_id: 40 }, {}]);
    // The stored topic is kept: a closed topic is not a deleted one.
    assert.equal(await topics.thread("123", "news"), 40);
    // Recording fails after Telegram created the topic: this send still uses it.
    const failing = new TelegramTopics(
      {
        query: async (sql: string) => {
          if (sql.startsWith("INSERT")) throw new Error("db down");
          return { rows: [] };
        },
      } as unknown as Database,
      fakeApi().api,
    );
    const used: any[] = [];
    await failing.send("123", "markets", async (extra) => used.push(extra));
    // The next send reuses it rather than creating a duplicate topic.
    await failing.send("123", "markets", async (extra) => used.push(extra));
    assert.deepEqual(used, [
      { message_thread_id: 40 },
      { message_thread_id: 40 },
    ]);
  } finally {
    await pg.close();
  }
});

test("two sends that find the topic deleted recreate it once", async () => {
  const { pg, db } = await database();
  const { api, created } = fakeApi();
  const topics = new TelegramTopics(db, api);
  try {
    await topics.thread("123", "news");
    const gone = () =>
      new GrammyError(
        "Call to 'sendMessage' failed!",
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: message thread not found",
        },
        "sendMessage",
        {},
      );
    const send = async (extra: any) => {
      if (extra.message_thread_id === 40) throw gone();
      return extra.message_thread_id;
    };
    // Concurrent, and one arriving after the first recovery finished.
    const [a, b] = await Promise.all([
      topics.send("123", "news", send),
      topics.send("123", "news", send),
    ]);
    const stale = new TelegramTopics(db, api);
    (stale as any).thread = async () => 40;
    const c = await stale.send("123", "news", send);
    assert.deepEqual([a, b, c], [41, 41, 41]);
    assert.deepEqual(created, ["News", "News"]);
  } finally {
    await pg.close();
  }
});

test("approval cards for a message typed in a topic go to that topic", async () => {
  const { pg, db } = await database();
  const actions = new CalendarActions(db, {} as any, "123");
  const bot = telegram(
    readConfig({
      DATABASE_URL: "postgres://x:x@localhost/x",
      TELEGRAM_BOT_TOKEN: "123:test-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
    }),
    {} as any,
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
    return { ok: true, result: { message_id: 11 } } as any;
  });
  await bot.init();
  try {
    const run = randomUUID();
    await actions.draft("123", run, {
      title: "Interview preparation",
      start: "2026-09-20T15:00:00+08:00",
      end: "2026-09-20T16:00:00+08:00",
    });
    const unrelated = randomUUID();
    await actions.draft("123", unrelated, {
      title: "Background decision",
      start: "2026-09-20T17:00:00+08:00",
      end: "2026-09-20T18:00:00+08:00",
    });
    const child = randomUUID();
    await db.query(
      "INSERT INTO events(user_id,run_id,type,data) VALUES('123',$1,'agent.started',$2::jsonb)",
      [run, JSON.stringify({ childRunId: child })],
    );
    await actions.draft("123", child, {
      title: "Child decision",
      start: "2026-09-20T19:00:00+08:00",
      end: "2026-09-20T20:00:00+08:00",
    });
    await Promise.all([
      sendCalendarApprovals(bot, db, "123", undefined, 55, run),
      sendCalendarApprovals(bot, db, "123", undefined, 55, run),
    ]);
    assert.equal(sent.length, 3);
    assert.deepEqual(
      sent.map((p) => p.message_thread_id),
      [55, undefined, 55],
    );
  } finally {
    await pg.close();
  }
});

test("threaded mode turned on later is picked up without a restart", async (t) => {
  const { pg, db } = await database();
  let enabled = false;
  let checks = 0;
  const topics = new TelegramTopics(db, {
    getMe: async () => (checks++, { has_topics_enabled: enabled }) as any,
    createForumTopic: async () => ({ message_thread_id: 40 }) as any,
  });
  try {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    assert.equal(await topics.thread("123", "news"), undefined);
    enabled = true;
    assert.equal(await topics.thread("123", "news"), undefined);
    t.mock.timers.tick(600_001);
    assert.equal(await topics.thread("123", "news"), 40);
    t.mock.timers.tick(600_001);
    assert.equal(await topics.thread("123", "news"), 40);
    assert.equal(checks, 2, "an 'on' answer is not checked again");
  } finally {
    t.mock.timers.reset();
    await pg.close();
  }
});

test("a failed topic lookup sends to General instead of creating a duplicate", async () => {
  const { api, created } = fakeApi();
  const topics = new TelegramTopics(
    {
      query: async () => {
        throw new Error("db down");
      },
    } as unknown as Database,
    api,
  );
  const sends: any[] = [];
  await topics.send("123", "news", async (extra) => sends.push(extra));
  assert.deepEqual(sends, [{}]);
  assert.deepEqual(created, []);
});

test("topics are created up front and a thread maps back to its topic", async () => {
  const { pg, db } = await database();
  const { api, created } = fakeApi();
  const topics = new TelegramTopics(db, api);
  try {
    await topics.ensure("123");
    await topics.ensure("123");
    assert.deepEqual(created, ["News", "Markets", "Coding", "Main"]);
    assert.equal(await topics.keyFor("123", 42), "coding");
    assert.equal(await topics.keyFor("123", 40), "news");
    assert.equal(await topics.keyFor("123", 99), undefined);
    assert.equal(await topics.keyFor("123", undefined), undefined);
  } finally {
    await pg.close();
  }
});

test("a message typed in Chief's Coding topic is recorded with its topic", async () => {
  const { pg, db } = await database();
  await new TelegramTopics(db, fakeApi().api).ensure("123");
  const assistant = new Assistant(
    db,
    {
      run: async (req) => ({
        reply: "ok",
        history: [...req.history, { role: "user", content: req.message }],
      }),
    },
    new JobTools(db, { call: async () => ({}) }),
  );
  const bot = telegram(
    readConfig({
      DATABASE_URL: "postgres://x:x@localhost/x",
      TELEGRAM_BOT_TOKEN: "123:long-test-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
    }),
    assistant,
    db,
  );
  bot.api.config.use(async (_prev, method) => {
    if (method === "getMe")
      return {
        ok: true,
        result: {
          id: 999,
          is_bot: true,
          first_name: "T",
          username: "t_bot",
          has_topics_enabled: true,
        },
      } as any;
    if (method === "sendMessage")
      return { ok: true, result: { message_id: 1 } } as any;
    return { ok: true, result: true } as any;
  });
  await bot.init();
  const update = (id: number, thread?: number, extra: object = {}) =>
    ({
      update_id: id,
      message: {
        message_id: id,
        date: 0,
        chat: { id: 123, type: "private" },
        from: { id: 123, is_bot: false, first_name: "T" },
        text: `message ${id}`,
        ...(thread
          ? { is_topic_message: true, message_thread_id: thread }
          : {}),
        ...extra,
      },
    }) as any;
  const replyTo = (topicRoot: boolean) => ({
    reply_to_message: {
      message_id: 7,
      date: 0,
      chat: { id: 123, type: "private" },
      ...(topicRoot
        ? { forum_topic_created: { name: "Coding", icon_color: 0xffd67e } }
        : { text: "an earlier answer" }),
    },
  });
  try {
    await bot.handleUpdate(update(1, 42, replyTo(true)));
    await bot.handleUpdate(update(2, 40));
    await bot.handleUpdate(update(3));
    // An explicit reply to an earlier message: only Chief's context carries its target.
    await bot.handleUpdate(update(4, 42, replyTo(false)));
    const topics = (
      await db.query(
        "SELECT metadata->>'topic' AS topic, metadata->>'threadId' AS thread FROM conversation_inputs ORDER BY ordinal",
      )
    ).rows;
    assert.deepEqual(
      topics.map((r) => r.topic),
      ["coding", "news", "main", "coding"],
    );
    assert.deepEqual(
      topics.map((r) => r.thread),
      ["42", "40", "43", "42"],
    );
  } finally {
    await pg.close();
  }
});

test("approval claims recheck supersession, retry definite rejections, and preserve unknown sends", async () => {
  const { pg, db } = await database();
  const actions = new CalendarActions(db, {} as any, "123");
  const run = randomUUID();
  const draft = await actions.draft("123", run, {
    title: "Decision",
    start: "2026-09-20T15:00:00+08:00",
    end: "2026-09-20T16:00:00+08:00",
  });
  let guard = true,
    attempts = 0,
    mode = "ok";
  const bot = telegram(
    readConfig({
      DATABASE_URL: "postgres://x:x@localhost/x",
      TELEGRAM_BOT_TOKEN: "123:test-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
    }),
    {} as any,
    db,
  );
  bot.api.config.use(async (_prev, method, payload) => {
    if (method !== "sendMessage")
      return {
        ok: true,
        result: { id: 999, is_bot: true, first_name: "T", username: "t_bot" },
      } as any;
    attempts++;
    if (mode === "fallback") {
      guard = false;
      throw new GrammyError(
        "gone",
        { ok: false, error_code: 400, description: "message thread not found" },
        method,
        payload,
      );
    }
    if (mode === "429")
      throw new GrammyError(
        "flood",
        {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 0 },
        },
        method,
        payload,
      );
    if (mode === "unknown") throw Error("Transport outcome unknown");
    return { ok: true, result: { message_id: attempts } } as any;
  });
  try {
    const wrapped: Database = {
      query: async (sql, v) => {
        const r = await db.query(sql, v);
        if (sql.includes("'telegramDeliveryState','sending'")) guard = false;
        return r;
      },
    };
    await sendCalendarApprovals(
      bot,
      wrapped,
      "123",
      async () => guard,
      42,
      run,
    );
    assert.equal(attempts, 0);
    assert.equal(
      (
        await db.query("SELECT payload FROM approvals WHERE id=$1", [
          draft.approvalId,
        ])
      ).rows[0].payload.telegramDeliveryState,
      undefined,
    );
    guard = true;
    mode = "fallback";
    await sendCalendarApprovals(bot, db, "123", async () => guard, 42, run);
    assert.equal(attempts, 1);
    assert.equal(
      (
        await db.query("SELECT payload FROM approvals WHERE id=$1", [
          draft.approvalId,
        ])
      ).rows[0].payload.telegramDeliveryState,
      undefined,
    );
    attempts = 0;
    guard = true;
    mode = "429";
    await assert.rejects(() =>
      sendCalendarApprovals(bot, db, "123", undefined, 42, run),
    );
    mode = "ok";
    await sendCalendarApprovals(bot, db, "123", undefined, 42, run);
    assert.equal(attempts, 2);
    await db.query(
      "UPDATE approvals SET payload=payload-'telegramMessageId'-'telegramDeliveryState'-'telegramRetryAt' WHERE id=$1",
      [draft.approvalId],
    );
    mode = "unknown";
    await assert.rejects(() =>
      sendCalendarApprovals(bot, db, "123", undefined, 42, run),
    );
    mode = "ok";
    await sendCalendarApprovals(bot, db, "123", undefined, 42, run);
    assert.equal(attempts, 3);
    assert.equal(
      (
        await db.query("SELECT payload FROM approvals WHERE id=$1", [
          draft.approvalId,
        ])
      ).rows[0].payload.telegramDeliveryState,
      "uncertain",
    );
  } finally {
    await pg.close();
  }
});

test("slow pointer needs an actually delivered answer, and is deduplicated", async () => {
  const { pg, db } = await database();
  const run = randomUUID();
  let sends = 0;
  try {
    await db.query(
      "INSERT INTO runtime_runs(id,user_id,state) VALUES($1,'123','stopped')",
      [run],
    );
    await db.query(
      "INSERT INTO conversation_inputs(id,user_id,run_id,message,state,received_at) VALUES($1,'123',$2,'question','completed',now()-interval '2 minutes')",
      [randomUUID(), run],
    );
    const bot = {
      api: { sendMessage: async () => ({ message_id: ++sends }) },
    } as any;
    await sendSlowPointer(bot, db, "123", run, 42);
    assert.equal(sends, 0);
    await db.query(
      "INSERT INTO events(user_id,run_id,type,data) VALUES('123',$1,'telegram.message_sent','{\"kind\":\"progress\",\"messageId\":10}')",
      [run],
    );
    await sendSlowPointer(bot, db, "123", run, 42);
    assert.equal(sends, 0);
    await db.query(
      "INSERT INTO events(user_id,run_id,type,data) VALUES('123',$1,'telegram.message_sent','{\"kind\":\"answer\",\"messageId\":11}')",
      [run],
    );
    await Promise.all([
      sendSlowPointer(bot, db, "123", run, 42),
      sendSlowPointer(bot, db, "123", run, 42),
    ]);
    assert.equal(sends, 1);
  } finally {
    await pg.close();
  }
});

test("unthreaded owner sends land in Main while explicit feed sends and other chats stay unchanged", async () => {
  const { pg, db } = await database();
  const bot = new Bot("123:test-token");
  const calls: { method: string; payload: any }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    if (method === "getMe")
      return { ok: true, result: { has_topics_enabled: true } } as any;
    if (method === "createForumTopic")
      return {
        ok: true,
        result: { message_thread_id: 900, name: "Main" },
      } as any;
    return { ok: true, result: { message_id: 901 } } as any;
  });
  const topics = new TelegramTopics(db, bot.api);
  routeUnthreadedToMain(bot.api, topics, new Set(["123"]));
  try {
    await bot.api.sendMessage("123", "Conversation");
    await bot.api.sendMessage("123", "Root helper", { message_thread_id: 1 });
    await bot.api.sendVoice("123", "voice-file");
    await bot.api.sendDocument("123", "document-file");
    await bot.api.sendChatAction("123", "typing");
    await bot.api.sendMessage("123", "News feed", { message_thread_id: 42 });
    await bot.api.sendMessage("999", "Other chat");
    const sends = calls.filter((c) => c.method.startsWith("send"));
    assert.deepEqual(
      sends.map((c) => c.payload.message_thread_id),
      [900, 900, 900, 900, 900, 42, undefined],
    );
    assert.equal(
      calls.filter((c) => c.method === "createForumTopic").length,
      1,
    );
    assert.deepEqual(await topics.capture("123", { kind: "general" }), {
      kind: "thread",
      threadId: 900,
    });
    assert.equal(await topics.keyFor("123", 900), "main");
  } finally {
    await pg.close();
  }
});

test("Main recovery retries only definite missing-thread errors and works with threaded mode off", async () => {
  for (const mode of ["missing", "unknown", "off"] as const) {
    const { pg, db } = await database();
    const bot = new Bot("123:test-token");
    let created = 0;
    const sends: number[] = [];
    bot.api.config.use(async (_prev, method, payload) => {
      if (method === "getMe")
        return {
          ok: true,
          result: { has_topics_enabled: mode !== "off" },
        } as any;
      if (method === "createForumTopic")
        return {
          ok: true,
          result: { message_thread_id: 900 + created++, name: "Main" },
        } as any;
      if (method === "sendMessage") {
        const thread = (payload as any).message_thread_id;
        sends.push(thread);
        if (mode === "missing" && thread === 900)
          return {
            ok: false,
            error_code: 400,
            description: "message thread not found",
          } as any;
        if (mode === "unknown")
          throw Error("Unknown transport acknowledgement");
      }
      return { ok: true, result: { message_id: 902 } } as any;
    });
    routeUnthreadedToMain(
      bot.api,
      new TelegramTopics(db, bot.api),
      new Set(["123"]),
    );
    try {
      if (mode === "unknown")
        await assert.rejects(() => bot.api.sendMessage("123", "Message"));
      else if (mode === "missing") {
        await assert.rejects(() => bot.api.sendMessage("123", "Message"));
        await bot.api.sendMessage("123", "Message");
      } else await bot.api.sendMessage("123", "Message");
      assert.deepEqual(
        sends,
        mode === "missing" ? [900, 901] : mode === "off" ? [undefined] : [900],
      );
    } finally {
      await pg.close();
    }
  }
});

test("Main conversation never receives a slow-reply pointer about itself", async () => {
  const { pg, db } = await database();
  let sent = 0;
  try {
    await sendSlowPointer(
      {
        api: {
          sendMessage: async () => {
            sent++;
            return { message_id: 1 };
          },
        },
      } as any,
      db,
      "123",
      randomUUID(),
      900,
      900,
    );
    assert.equal(sent, 0);
  } finally {
    await pg.close();
  }
});

test("root intake persists before slow Main creation and explicit topic input cannot overtake it", async () => {
  const { pg, db } = await database();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => (enter = r)),
    wait = new Promise<void>((r) => (release = r));
  const assistant = new Assistant(
    db,
    {
      run: async (req) => ({
        reply: "Answer",
        history: [
          ...req.history,
          { role: "user", content: req.message },
          { role: "assistant", content: "Answer" },
        ],
      }),
    },
    new JobTools(db, { call: async () => ({}) }),
  );
  const bot = telegram(
    readConfig({
      DATABASE_URL: "postgres://x:x@localhost/x",
      TELEGRAM_BOT_TOKEN: "123:test-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
    }),
    assistant,
    db,
  );
  let messages = 1000;
  bot.api.config.use(async (_prev, method) => {
    if (method === "getMe")
      return {
        ok: true,
        result: {
          id: 999,
          is_bot: true,
          first_name: "T",
          username: "t_bot",
          has_topics_enabled: true,
        },
      } as any;
    if (method === "createForumTopic") {
      enter();
      await wait;
      return {
        ok: true,
        result: { message_thread_id: 900, name: "Main" },
      } as any;
    }
    return { ok: true, result: { message_id: messages++ } } as any;
  });
  const update = (id: number, thread?: number) =>
    ({
      update_id: id,
      message: {
        message_id: id,
        date: 0,
        chat: { id: 123, type: "private" },
        from: { id: 123, is_bot: false, first_name: "T" },
        text: `Question ${id}`,
        ...(thread
          ? { is_topic_message: true, message_thread_id: thread }
          : {}),
      },
    }) as any;
  try {
    await bot.init();
    const first = bot.handleUpdate(update(1));
    await entered;
    const second = bot.handleUpdate(update(2, 55));
    while (
      (await db.query("SELECT count(*)::int AS n FROM conversation_inputs"))
        .rows[0].n < 2
    )
      await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(
      (
        await db.query(
          "SELECT metadata->>'updateId' AS id FROM conversation_inputs ORDER BY ordinal",
        )
      ).rows.map((r) => r.id),
      ["1", "2"],
    );
    release();
    await Promise.all([first, second]);
    assert.deepEqual(
      (
        await db.query(
          "SELECT metadata->>'threadId' AS thread,state FROM conversation_inputs ORDER BY ordinal",
        )
      ).rows,
      [
        { thread: "900", state: "completed" },
        { thread: "55", state: "completed" },
      ],
    );
  } finally {
    release();
    await pg.close();
  }
});

test("Main lookup and missing-thread repair do not send an approval after cancellation", async () => {
  for (const cancelAt of ["lookup", "rejection"] as const) {
    const { pg, db } = await database();
    const actions = new CalendarActions(db, {} as any, "123");
    const run = randomUUID();
    const draft = await actions.draft("123", run, {
      title: "Decision",
      start: "2026-10-08T15:00:00+08:00",
      end: "2026-10-08T16:00:00+08:00",
    });
    const bot = new Bot("123:test-token");
    let current = true,
      created = 0;
    const sends: unknown[] = [];
    bot.api.config.use(async (_p, method, payload) => {
      if (method === "getMe")
        return { ok: true, result: { has_topics_enabled: true } } as any;
      if (method === "createForumTopic") {
        if (cancelAt === "lookup") current = false;
        return {
          ok: true,
          result: { message_thread_id: 900 + created++, name: "Main" },
        } as any;
      }
      if (method === "sendMessage") {
        sends.push({ thread: (payload as any).message_thread_id, current });
        current = false;
        return {
          ok: false,
          error_code: 400,
          description: "message thread not found",
        } as any;
      }
      return { ok: true, result: true } as any;
    });
    routeUnthreadedToMain(
      bot.api,
      new TelegramTopics(db, bot.api),
      new Set(["123"]),
    );
    try {
      if (cancelAt === "rejection")
        await assert.rejects(() =>
          sendCalendarApprovals(bot, db, "123", async () => current),
        );
      else await sendCalendarApprovals(bot, db, "123", async () => current);
      assert.deepEqual(
        sends,
        cancelAt === "lookup" ? [] : [{ thread: 900, current: true }],
      );
      const payload = (
        await db.query("SELECT payload FROM approvals WHERE id=$1", [
          draft.approvalId,
        ])
      ).rows[0].payload;
      assert.equal(payload.telegramMessageId, undefined);
      assert.equal(payload.telegramDeliveryState, undefined);
    } finally {
      await pg.close();
    }
  }
});

test("message and feed receipts store Main's actual sent thread", async () => {
  const { pg, db } = await database();
  const bot = new Bot("123:test-token");
  let id = 1000;
  bot.api.config.use(async (_p, method) => {
    if (method === "getMe")
      return { ok: true, result: { has_topics_enabled: true } } as any;
    if (method === "createForumTopic")
      return {
        ok: true,
        result: { message_thread_id: 900, name: "Main" },
      } as any;
    return { ok: true, result: { message_id: id++ } } as any;
  });
  routeUnthreadedToMain(
    bot.api,
    new TelegramTopics(db, bot.api),
    new Set(["123"]),
  );
  try {
    const run = randomUUID();
    await new TelegramViews(db, bot.api).deliver(
      "123",
      "123",
      { reply: "Progress", runId: run },
      "progress",
    );
    assert.equal(
      (
        await db.query(
          "SELECT data FROM events WHERE type='telegram.message_sent' AND run_id=$1",
          [run],
        )
      ).rows[0].data.threadId,
      900,
    );
    const sent = await bot.api.sendMessage("123", "Feed fallback");
    const { recordFeedSent } = await import("../src/telegram-feeds.js");
    await recordFeedSent(db, "123", run, "updates", sent, undefined);
    assert.equal(
      (
        await db.query(
          "SELECT data FROM events WHERE type='telegram.feed_sent' AND run_id=$1",
          [run],
        )
      ).rows[0].data.threadId,
      900,
    );
  } finally {
    await pg.close();
  }
});

test("closed Main falls back to actual root without being re-added and records root receipts", async () => {
  const { pg, db } = await database();
  const bot = new Bot("123:test-token");
  const sends: (number | undefined)[] = [];
  bot.api.config.use(async (_p, method, payload) => {
    if (method === "getMe")
      return { ok: true, result: { has_topics_enabled: true } } as any;
    if (method === "createForumTopic")
      return {
        ok: true,
        result: { message_thread_id: 900, name: "Main" },
      } as any;
    if (method === "sendMessage") {
      const thread = (payload as any).message_thread_id;
      sends.push(thread);
      if (thread === 900)
        return {
          ok: false,
          error_code: 400,
          description: "TOPIC_CLOSED",
        } as any;
    }
    return { ok: true, result: { message_id: 1000 + sends.length } } as any;
  });
  const topics = new TelegramTopics(db, bot.api);
  routeUnthreadedToMain(bot.api, topics, new Set(["123"]));
  try {
    const run = randomUUID();
    await topics.deliver("123", { kind: "general" }, (extra) =>
      new TelegramViews(db, bot.api).deliver(
        "123",
        { id: "123", thread: extra.message_thread_id },
        { reply: "Answer", runId: run },
      ),
    );
    assert.deepEqual(sends, [900, undefined]);
    assert.equal(
      (
        await db.query(
          "SELECT data FROM events WHERE type='telegram.message_sent' AND run_id=$1",
          [run],
        )
      ).rows[0].data.threadId,
      null,
    );
    const a = new CalendarActions(db, {} as any, "123");
    const draft = await a.draft("123", randomUUID(), {
      title: "Decision",
      start: "2026-10-08T15:00:00+08:00",
      end: "2026-10-08T16:00:00+08:00",
    });
    await sendCalendarApprovals(bot, db, "123", async () => true);
    assert.deepEqual(sends, [900, undefined, 900, undefined]);
    assert.equal(
      (
        await db.query("SELECT payload FROM approvals WHERE id=$1", [
          draft.approvalId,
        ])
      ).rows[0].payload.telegramThreadId,
      null,
    );
  } finally {
    await pg.close();
  }
});

test("closed Main root retry still checks an approval's cancellation guard", async () => {
  const { pg, db } = await database();
  const a = new CalendarActions(db, {} as any, "123");
  const draft = await a.draft("123", randomUUID(), {
    title: "Decision",
    start: "2026-10-08T15:00:00+08:00",
    end: "2026-10-08T16:00:00+08:00",
  });
  const bot = new Bot("123:test-token");
  let current = true;
  const sends: unknown[] = [];
  bot.api.config.use(async (_p, method, payload) => {
    if (method === "getMe")
      return { ok: true, result: { has_topics_enabled: true } } as any;
    if (method === "createForumTopic")
      return {
        ok: true,
        result: { message_thread_id: 900, name: "Main" },
      } as any;
    if (method === "sendMessage") {
      sends.push((payload as any).message_thread_id);
      current = false;
      return { ok: false, error_code: 400, description: "TOPIC_CLOSED" } as any;
    }
    return { ok: true, result: true } as any;
  });
  routeUnthreadedToMain(
    bot.api,
    new TelegramTopics(db, bot.api),
    new Set(["123"]),
  );
  try {
    await sendCalendarApprovals(bot, db, "123", async () => current);
    assert.deepEqual(sends, [900]);
    assert.equal(
      (
        await db.query("SELECT payload FROM approvals WHERE id=$1", [
          draft.approvalId,
        ])
      ).rows[0].payload.telegramDeliveryState,
      undefined,
    );
  } finally {
    await pg.close();
  }
});

test("foreground voice root fallback respects cancellation after closed Main rejection", async (t) => {
  const { pg, db } = await database();
  let current = true;
  const voiceSends: unknown[] = [];
  t.mock.method(Voice.prototype, "speak", async () => ({
    bytes: new Uint8Array([1, 2, 3]),
    filename: "reply.ogg",
  }));
  const assistant = {
    tools: {},
    recordInput: async () => randomUUID(),
    prepareInput: async () => {},
    failInput: async () => {},
    respondDetailed: async () => ({
      reply: "Answer",
      runId: randomUUID(),
      voiceReply: true,
      threadId: 900,
    }),
    isCurrentDelivery: async () => current,
    isCurrentRun: async () => current,
    finishDelivery: async () => {},
  } as unknown as Assistant;
  const bot = telegram(
    readConfig({
      DATABASE_URL: "postgres://x:x@localhost/x",
      TELEGRAM_BOT_TOKEN: "123:test-token",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      VOICE_REPLIES: "true",
    }),
    assistant,
    db,
  );
  bot.api.config.use(async (_p, method, payload) => {
    if (method === "getMe")
      return {
        ok: true,
        result: {
          id: 999,
          is_bot: true,
          first_name: "T",
          username: "t_bot",
          has_topics_enabled: true,
        },
      } as any;
    if (method === "createForumTopic")
      return {
        ok: true,
        result: { message_thread_id: 900, name: "Main" },
      } as any;
    const thread = (payload as any).message_thread_id;
    if (method === "sendMessage" && thread === 900)
      return { ok: false, error_code: 400, description: "TOPIC_CLOSED" } as any;
    if (method === "sendVoice") {
      voiceSends.push({ thread, current });
      current = false;
      if (thread === 900)
        return {
          ok: false,
          error_code: 400,
          description: "TOPIC_CLOSED",
        } as any;
    }
    return { ok: true, result: { message_id: 1000 } } as any;
  });
  routeUnthreadedToMain(bot.api, bot.topics, new Set(["123"]));
  try {
    await bot.init();
    await bot.handleUpdate({
      update_id: 501,
      message: {
        message_id: 501,
        date: 0,
        chat: { id: 123, type: "private" },
        from: { id: 123, is_bot: false, first_name: "T" },
        text: "Please answer aloud",
      },
    } as any);
    assert.deepEqual(voiceSends, [{ thread: 900, current: true }]);
    assert.equal(
      (await db.query("SELECT status FROM inbound_updates WHERE update_id=501"))
        .rows[0].status,
      "completed",
    );
  } finally {
    await pg.close();
  }
});
