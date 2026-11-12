import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { closeAfter, migratedPGlite } from "./helpers/pglite.js";
import { CodingController } from "../src/coding/controller.js";
import { codingSettings } from "../src/coding/schema.js";
import { ensureUser, type Database } from "../src/db.js";
import { telegram } from "../src/telegram.js";
import { readConfig } from "../src/config.js";
import type { Assistant } from "../src/agent.js";

test("the Start button and a direct yes reply start the displayed request without slash commands", async (t) => {
  for (const transport of [
    "button",
    "reply",
    "button-ack-fails",
    "reply-ack-fails",
  ]) {
    const pg = await migratedPGlite();
    closeAfter(t, pg);
    const db = pg as unknown as Database;
    await ensureUser(db, "123");
    const run = randomUUID();
    await db.query(
      "INSERT INTO work_turns(run_id,user_id,request) VALUES($1,'123','Build the requested feature')",
      [run],
    );
    let starts = 0,
      terminal = false;
    const coding = new CodingController(
      db,
      codingSettings.parse(
        JSON.parse(
          await readFile(
            new URL("../config/coding.json", import.meta.url),
            "utf8",
          ),
        ),
      ),
      {
        create: async () => {
          starts++;
          terminal = false;
          return `fixture:${starts}`;
        },
        find: async () => undefined,
        inspect: async () => (terminal ? "terminal" : "running"),
        terminate: async () => {
          terminal = true;
        },
      },
      {
        resolve: async () => "a".repeat(40),
        publish: async () => {
          throw new Error("No publication in confirmation test");
        },
      },
      "c".repeat(64),
      "https://fixture.example",
      (u) => u === "123",
      () => ({
        generate: async () => {
          throw new Error("No paid model call");
        },
      }),
    );
    const job: any = await coding.call("123", run, {
      operation: "coding_start",
      requestKey: "request",
      objective: "Requested feature",
      context: "Synthetic acceptance",
    });
    // The job waits for Start: no box before the tap (journal 191).
    await coding.tick();
    assert.equal(starts, 0);
    let approval = "";
    await coding.deliver(async (_u, target, _text, id) => {
      assert.deepEqual(target, { kind: "topic", topic: "coding" });
      if (id) approval = id.id;
      return { message_id: 100 };
    });
    assert(approval);
    const bot = telegram(
      readConfig({
        DATABASE_URL: "postgres://fixture",
        TELEGRAM_BOT_TOKEN: "123:long-test-token",
        TELEGRAM_ALLOWED_USER_IDS: "123",
        TELEGRAM_TOPICS: "off",
      }),
      { tools: { coding } } as unknown as Assistant,
      db,
    );
    const replies: string[] = [];
    let failedAck = false;
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
        };
      if (method === "sendMessage") {
        if (transport.includes("ack-fails") && !failedAck) {
          failedAck = true;
          throw new Error("Synthetic acknowledgement failure");
        }
        replies.push((payload as any).text);
      }
      return { ok: true, result: true } as any;
    });
    await bot.init();
    const from = { id: 123, is_bot: false, first_name: "Owner" };
    const card = {
      message_id: 100,
      date: 0,
      chat: { id: 123, type: "private" },
      from: { id: 999, is_bot: true, first_name: "Fixture" },
      text: "Ready to start",
    };
    const update: any = transport.startsWith("button")
      ? {
          update_id: 1,
          callback_query: {
            id: "callback",
            from,
            chat_instance: "private",
            data: `cod:yes:${approval}`,
            message: card,
          },
        }
      : {
          update_id: 1,
          message: {
            message_id: 101,
            date: 0,
            chat: card.chat,
            from,
            text: "Yes!",
            reply_to_message: card,
          },
        };
    // The Change button is gone: an old cod:no tap changes nothing.
    await bot.handleUpdate({
      update_id: 0,
      callback_query: {
        id: "old-change",
        from,
        chat_instance: "private",
        data: `cod:no:${approval}`,
        message: card,
      },
    } as any);
    assert.equal(
      (await db.query("SELECT mode FROM coding_jobs WHERE id=$1", [job.id]))
        .rows[0].mode,
      "plan",
    );
    await bot.handleUpdate(update);
    if (transport.includes("ack-fails")) {
      assert(failedAck);
      assert.equal(replies.length, 0);
    } else assert(replies[0]?.startsWith("Started."), JSON.stringify(replies));
    assert.equal(
      (
        await db.query("SELECT mode,revision FROM coding_jobs WHERE id=$1", [
          job.id,
        ])
      ).rows[0].mode,
      "implement",
    );
    await bot.handleUpdate(update);
    assert.equal(
      (await db.query("SELECT revision FROM coding_jobs WHERE id=$1", [job.id]))
        .rows[0].revision,
      2,
    );
    if (transport.startsWith("reply"))
      assert.equal(replies.length, transport.includes("ack-fails") ? 0 : 1);
    assert.equal(starts, 0);
    await coding.tick();
    assert.equal(starts, 1);
  }
});
