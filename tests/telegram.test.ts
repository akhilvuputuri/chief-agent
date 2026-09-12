import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { telegram } from "../src/telegram.js";
import { readConfig } from "../src/config.js";
import { Assistant } from "../src/agent.js";
import { JobTools } from "../src/tools.js";
import type { Database } from "../src/db.js";
test("Telegram handles natural text once and ignores unauthorized users and groups", async () => {
  const pg = new PGlite();
  await pg.exec(
    await readFile(new URL("../db/001_initial.sql", import.meta.url), "utf8"),
  );
  await pg.exec(
    await readFile(
      new URL("../db/002_preparation.sql", import.meta.url),
      "utf8",
    ),
  );
  await pg.exec(
    await readFile(new URL("../db/005_work.sql", import.meta.url), "utf8"),
  );
  await pg.exec(
    await readFile(new URL("../db/003_skills.sql", import.meta.url), "utf8"),
  );
  await pg.exec(
    await readFile(new URL("../db/006_runtime.sql", import.meta.url), "utf8"),
  );
  await pg.exec(
    await readFile(new URL("../db/010_memory.sql", import.meta.url), "utf8"),
  );
  const db = pg as unknown as Database;
  let turns = 0;
  const replies: string[] = [];
  const assistant = new Assistant(
    db,
    {
      run: async (req) => {
        turns++;
        return {
          reply: `Understood: ${req.message}`,
          history: [{ role: "user", content: req.message }],
        };
      },
    },
    new JobTools(db, { call: async () => ({}) }),
  );
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
    if (method === "sendMessage") replies.push((payload as any).text);
    return { ok: true, result: true } as any;
  });
  await bot.init();
  const update = (id: number, user = 123, type = "private") =>
    ({
      update_id: id,
      message: {
        message_id: id,
        date: 0,
        chat: { id: user, type },
        from: { id: user, is_bot: false, first_name: "Test" },
        text: "Compare these roles with my background",
      },
    }) as any;
  try {
    await bot.handleUpdate(update(1));
    await bot.handleUpdate(update(1));
    await bot.handleUpdate(update(2, 456));
    await bot.handleUpdate(update(3, 123, "group"));
    assert.equal(turns, 1);
    assert.equal(replies.length, 1);
    assert.match(replies[0]!, /Compare these roles/);
    assert.equal(
      (await pg.query("SELECT * FROM inbound_updates")).rows.length,
      1,
    );
  } finally {
    await pg.close();
  }
});

test("status responds while a conversation is still running", async () => {
  const pg = new PGlite();
  for (const f of [
    "001_initial",
    "002_preparation",
    "003_skills",
    "005_work",
    "006_runtime",
    "008_costs",
  ])
    await pg.exec(
      await readFile(new URL("../db/" + f + ".sql", import.meta.url), "utf8"),
    );
  await pg.exec(
    await readFile(new URL("../db/010_memory.sql", import.meta.url), "utf8"),
  );
  const db = pg as unknown as Database;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    held = new Promise<void>((r) => (release = r));
  const assistant = new Assistant(
    db,
    {
      run: async (req) => {
        entered();
        await held;
        return { reply: "Finished", history: [], stopReason: "answer" };
      },
    },
    new JobTools(db, { call: async () => ({}) }),
  );
  const c = readConfig({
    DATABASE_URL: "postgres://x:x@localhost/x",
    TELEGRAM_BOT_TOKEN: "123:long-test-token",
    TELEGRAM_ALLOWED_USER_IDS: "123",
  });
  const bot = telegram(c, assistant, db);
  const replies: string[] = [];
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
    if (method === "sendMessage") replies.push((payload as any).text);
    return { ok: true, result: true } as any;
  });
  await bot.init();
  const update = (id: number, text: string) =>
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
  const running = bot.handleUpdate(update(1, "Research this"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await started;
    await Promise.race([
      bot.handleUpdate(update(2, "/status")),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Status waited behind conversation")),
          2000,
        );
      }),
    ]);
    assert.deepEqual(replies, ["No active tracked task."]);
  } finally {
    if (timer) clearTimeout(timer);
    release();
    await running;
    await pg.close();
  }
});
