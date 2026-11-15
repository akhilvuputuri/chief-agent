// Telegram polling keeps listening for the life of the process (journal 196).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Bot, HttpError } from "grammy";
import type { Update } from "grammy/types";
import { setOpsSink } from "../src/ops-log.js";
import { startPolling, type Polling } from "../src/telegram-polling.js";
import { server } from "../src/server.js";
import { migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import { telegram } from "../src/telegram.js";
import { readConfig } from "../src/config.js";
import { Assistant } from "../src/agent.js";
import { JobTools } from "../src/tools.js";

const TOKEN = "123:secret-test-token";
const botInfo = {
  id: 999,
  is_bot: true,
  first_name: "T",
  username: "t_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as any;

type Answer =
  | { updates: Update[] }
  | { error: unknown }
  | { code: number }
  | { idle: true };

/** A fake Bot API. getUpdates answers from `respond`; an idle long poll waits 30 s
 * (or until aborted), as Telegram does. Installed before startPolling, so polling's
 * own transformer wraps it as it wraps the real client. */
function fakeTelegram(
  bot: Bot<any>,
  respond: (offset: number | undefined) => Answer,
) {
  const calls: { at: number; offset?: number }[] = [];
  const sent: string[] = [];
  bot.api.config.use(async (_prev, method, payload, signal) => {
    if (method === "sendMessage") {
      sent.push((payload as { text: string }).text);
      return { ok: true, result: { message_id: sent.length } } as any;
    }
    if (method !== "getUpdates") return { ok: true, result: true } as any;
    const offset = (payload as { offset?: number }).offset;
    calls.push({ at: Date.now(), offset });
    const answer = respond(offset);
    if ("error" in answer) throw answer.error;
    if ("code" in answer)
      return {
        ok: false,
        error_code: answer.code,
        description: `Telegram text that must not be logged ${TOKEN}`,
      } as any;
    if ("updates" in answer && answer.updates.length)
      return { ok: true, result: answer.updates } as any;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 30_000);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
    return { ok: true, result: [] } as any;
  });
  return { calls, sent };
}

function networkError() {
  // Shaped like grammY's HttpError around a node-fetch FetchError, whose message
  // carries the request URL and so the token.
  const inner = Object.assign(
    new Error(
      `request to https://api.telegram.org/bot${TOKEN}/getUpdates failed, reason: socket hang up`,
    ),
    { name: "FetchError", code: "ECONNRESET" },
  );
  return new HttpError("Network request for 'getUpdates' failed!", inner);
}

function message(id: number, text = `private words ${id}`): Update {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_700_000_000,
      chat: { id: 123, type: "private", first_name: "T" },
      from: { id: 123, is_bot: false, first_name: "T" },
      text,
    },
  } as Update;
}

function captureLogs(t: TestContext) {
  const lines: string[] = [];
  const previous = setOpsSink((line) => lines.push(line));
  t.after(() => setOpsSink(previous));
  const events = (name: string) =>
    lines.map((l) => JSON.parse(l)).filter((e) => e.event === name);
  return { lines, events };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};
async function advance(t: TestContext, ms: number, step = 1000) {
  for (let done = 0; done < ms; done += step) {
    t.mock.timers.tick(step);
    await flush();
  }
}
function fakeClock(t: TestContext) {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: Date.UTC(2026, 10, 15, 0, 0, 0),
  });
}
/** A stop waits for a retry sleep in progress, so the clock must run meanwhile. */
async function stop(t: TestContext, polling: Polling) {
  const stopped = polling.stop();
  await advance(t, 6_000);
  await stopped;
}

test("after an outage of any length polling resumes within the steady interval", async (t) => {
  const waits: number[] = [];
  for (const outage of [60_000, 3 * 3_600_000]) {
    fakeClock(t);
    const logs = captureLogs(t);
    const bot = new Bot(TOKEN, { botInfo });
    const end = Date.now() + outage;
    const { calls, sent } = fakeTelegram(bot, () =>
      Date.now() < end ? { error: networkError() } : { idle: true },
    );
    const polling = startPolling(bot, {
      notifyOwner: (text) => bot.api.sendMessage(123, text).then(() => {}),
      allowedUpdates: ["message"],
      concurrency: 8,
    });
    await advance(t, outage + 60_000);
    const first = calls.find((c) => c.at >= end)!;
    waits.push(first.at - end);
    // Failures are logged first and then at most every ten minutes, not per attempt.
    const failed = logs.events("telegram.poll_failed");
    assert.ok(failed.length <= 2 + outage / 600_000, `${failed.length} lines`);
    assert.equal(failed[0].attempt, 1);
    assert.equal(failed[0].kind, "network");
    assert.equal(failed[0].errorCategory, "HttpError");
    assert.equal(failed[0].causeCategory, "FetchError");
    assert.equal(failed[0].errorCode, "ECONNRESET");
    const [recovered] = logs.events("telegram.poll_recovered");
    assert.ok(Math.abs(recovered.outageS - outage / 1000) <= 6);
    assert.ok(recovered.attempt >= outage / 5_000 - 2);
    if (outage < 600_000) assert.deepEqual(sent, []);
    else {
      // One line while it lasted, one when it ended; none for a later short blip.
      assert.equal(sent.length, 2, sent.join("\n"));
      assert.match(
        sent[0]!,
        /not received any Telegram messages for 10 minutes/,
      );
      assert.match(sent[0]!, /every 5 seconds/);
      assert.match(sent[1]!, /not receiving messages for about 3 hours/);
      assert.match(sent[1]!, /more than 24 hours ago/);
      assert.ok(sent.every((s) => s.length < 300));
    }
    await stop(t, polling);
    t.mock.timers.reset();
  }
  // The wait does not grow with the outage (the library default doubled it each time).
  for (const wait of waits) assert.ok(wait <= 5_000, `waited ${wait} ms`);
});

test("status and heartbeat fields follow polling, and one late-delivery line per outage", async (t) => {
  fakeClock(t);
  captureLogs(t);
  const bot = new Bot(TOKEN, { botInfo });
  let failing = false;
  const { sent } = fakeTelegram(bot, () =>
    failing ? { error: networkError() } : { idle: true },
  );
  const polling = startPolling(bot, {
    notifyOwner: (text) => bot.api.sendMessage(123, text).then(() => {}),
    allowedUpdates: ["message"],
    concurrency: 8,
  });
  assert.equal(polling.status().state, "starting");
  assert.equal(polling.status().lastPollAgeS, undefined);
  await advance(t, 31_000);
  assert.deepEqual(polling.status(), {
    state: "polling",
    lastPollAgeS: 0,
    pollFailures: 0,
    handlersRunning: 0,
  });
  failing = true;
  // The idle long poll in flight still answers; failures start with the next call.
  await advance(t, 90_000);
  let status = polling.status();
  assert.equal(status.state, "failing");
  assert.ok(status.pollFailures >= 10);
  assert.ok(status.lastPollAgeS! >= 60);
  await advance(t, 10 * 60_000);
  assert.equal(polling.status().state, "stale");
  failing = false;
  // The next call is within 5 s; an idle long poll answers 30 s later.
  await advance(t, 40_000);
  status = polling.status();
  assert.equal(status.state, "polling");
  assert.equal(status.pollFailures, 0);
  assert.equal(sent.length, 2);
  // A second, short outage is logged but not sent to the owner.
  failing = true;
  await advance(t, 30_000);
  failing = false;
  await advance(t, 40_000);
  assert.equal(sent.length, 2);
  await stop(t, polling);
});

test("a 409 ends the runner's loop; polling restarts at the steady pace and says so", async (t) => {
  fakeClock(t);
  const logs = captureLogs(t);
  const bot = new Bot(TOKEN, { botInfo });
  const end = Date.now() + 20 * 60_000;
  const { calls, sent } = fakeTelegram(bot, () =>
    Date.now() < end ? { code: 409 } : { idle: true },
  );
  const polling = startPolling(bot, {
    notifyOwner: (text) => bot.api.sendMessage(123, text).then(() => {}),
    allowedUpdates: ["message"],
    concurrency: 8,
  });
  await advance(t, 60_000);
  assert.equal(polling.status().state, "conflict");
  const [stopped] = logs.events("telegram.polling_stopped");
  assert.equal(stopped.httpStatus, 409);
  assert.equal(stopped.kind, "conflict");
  assert.equal(logs.events("telegram.polling_restarted")[0].kind, "conflict");
  await advance(t, 20 * 60_000);
  // A restart every 5 seconds for 20 minutes: about 240 calls, not a few backed-off ones.
  const during = calls.filter((c) => c.at < end).length;
  assert.ok(during >= 200, `${during} calls`);
  // Restarts are logged at the same pace as failures, not once per restart.
  assert.ok(logs.events("telegram.polling_stopped").length <= 4);
  assert.equal(polling.status().state, "polling");
  assert.equal(sent.length, 2);
  assert.match(
    sent[0]!,
    /another program is fetching updates with my bot token/,
  );
  assert.match(sent[0]!, /every 5 seconds/);
  await stop(t, polling);
});

test("a 401 keeps polling, reports the token and fails /healthz", async (t) => {
  fakeClock(t);
  const logs = captureLogs(t);
  const bot = new Bot(TOKEN, { botInfo });
  const { sent } = fakeTelegram(bot, () => ({ code: 401 }));
  const polling = startPolling(bot, {
    notifyOwner: (text) => bot.api.sendMessage(123, text).then(() => {}),
    allowedUpdates: ["message"],
    concurrency: 8,
  });
  const app = server(undefined, undefined, () => polling.status());
  try {
    await advance(t, 11 * 60_000);
    assert.equal(polling.status().state, "unauthorized");
    assert.equal(logs.events("telegram.polling_stopped")[0].httpStatus, 401);
    assert.ok(logs.events("telegram.polling_restarted").length >= 1);
    const response = await app.inject({ url: "/healthz" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().telegram.state, "unauthorized");
    assert.match(sent[0]!, /Telegram rejected my bot token/);
  } finally {
    await stop(t, polling);
    await app.close();
  }
});

test("/healthz reports a stale poll without failing, so a Telegram outage cannot block a release", async (t) => {
  fakeClock(t);
  captureLogs(t);
  const bot = new Bot(TOKEN, { botInfo });
  fakeTelegram(bot, () => ({ error: networkError() }));
  const polling = startPolling(bot, {
    notifyOwner: async () => {},
    allowedUpdates: ["message"],
    concurrency: 8,
  });
  const app = server(undefined, undefined, () => polling.status());
  try {
    await advance(t, 11 * 60_000);
    const response = await app.inject({ url: "/healthz" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "ok");
    assert.equal(response.json().telegram.state, "stale");
    assert.ok(response.json().telegram.pollFailures > 100);
  } finally {
    await stop(t, polling);
    await app.close();
  }
});

test("a restarted loop keeps the offset: no update is skipped or fetched twice", async (t) => {
  fakeClock(t);
  captureLogs(t);
  const bot = new Bot(TOKEN, { botInfo });
  const handled: number[] = [];
  bot.on("message", (ctx) => {
    handled.push(ctx.update.update_id);
  });
  // Telegram's rule: updates below the offset are confirmed and never sent again.
  const pending = [message(1), message(2), message(3)];
  let conflicts = 1;
  const { calls } = fakeTelegram(bot, (offset) => {
    if (offset === 3 && conflicts-- > 0) return { code: 409 };
    const next = pending.filter((u) => u.update_id >= (offset ?? 0));
    if (offset === 0) return { updates: next.slice(0, 2) };
    return next.length ? { updates: next } : { idle: true };
  });
  const polling = startPolling(bot, {
    notifyOwner: async () => {},
    allowedUpdates: ["message"],
    concurrency: 8,
  });
  await advance(t, 40_000);
  assert.deepEqual(handled, [1, 2, 3]);
  assert.deepEqual(
    calls.slice(0, 4).map((c) => c.offset),
    [0, 3, 3, 4],
  );
  await stop(t, polling);
});

test("logged polling fields carry no token, URL, Telegram text or message content", async (t) => {
  fakeClock(t);
  const logs = captureLogs(t);
  const bot = new Bot(TOKEN, { botInfo });
  bot.on("message", () => {});
  let n = 0;
  fakeTelegram(bot, () => {
    n++;
    if (n === 1) return { updates: [message(1, "the owner's private words")] };
    if (n < 200) return n % 2 ? { error: networkError() } : { code: 409 };
    return { idle: true };
  });
  const polling = startPolling(bot, {
    notifyOwner: async () => {},
    allowedUpdates: ["message"],
    concurrency: 8,
  });
  await advance(t, 30 * 60_000);
  await stop(t, polling);
  assert.ok(logs.events("telegram.poll_failed").length > 0);
  assert.ok(logs.events("telegram.poll_stale").length > 0);
  for (const line of logs.lines) {
    assert.doesNotMatch(
      line,
      /secret-test-token|api\.telegram\.org|private words|must not be logged/,
    );
  }
  // The fixed fields survive the log's shape checks (stack frames outside dist/ do not).
  const [stopped] = logs.events("telegram.polling_stopped");
  assert.equal(stopped.kind, "conflict");
  assert.equal(stopped.httpStatus, 409);
  assert.equal(stopped.errorCategory, "GrammyError");
});

test("across a polling restart the inbound_updates claim still handles a redelivered message once, and records when it was sent", async (t) => {
  captureLogs(t);
  const pg = await migratedPGlite();
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  let turns = 0;
  const assistant = new Assistant(
    db,
    {
      run: async (req) => {
        turns++;
        return {
          reply: "ok",
          history: [...req.history, { role: "user", content: req.message }],
        };
      },
    },
    new JobTools(db, { call: async () => ({}) }),
  );
  const bot = telegram(
    readConfig({
      DATABASE_URL: "postgres://x:x@localhost/x",
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_ALLOWED_USER_IDS: "123",
    }),
    assistant,
    db,
  );
  bot.botInfo = botInfo;
  // Simulate Telegram sending update 1 again after the loop ended, as it would had the
  // confirming call never reached it.
  let n = 0;
  fakeTelegram(bot, () => {
    n++;
    if (n === 1) return { updates: [message(1)] };
    if (n === 2) return { code: 409 };
    if (n === 3) return { updates: [message(1), message(2)] };
    return { idle: true };
  });
  const polling = startPolling(bot, {
    notifyOwner: async () => {},
    allowedUpdates: ["message"],
    concurrency: 8,
    retryMs: 10,
  });
  try {
    for (let i = 0; i < 400 && turns < 2; i++)
      await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(turns, 2);
    const claims = await pg.query("SELECT update_id FROM inbound_updates");
    assert.equal(claims.rows.length, 2);
    const inputs = await pg.query<{ metadata: any }>(
      "SELECT metadata FROM conversation_inputs ORDER BY ordinal",
    );
    assert.equal(inputs.rows.length, 2);
    assert.equal(
      inputs.rows[0]!.metadata.sentAt,
      new Date(1_700_000_000_000).toISOString(),
    );
    assert.ok(inputs.rows[0]!.metadata.receivedAt);
  } finally {
    await polling.stop();
    await pg.close();
  }
});

test("failing for more than 15 hours never ends the loop and keeps the 5 s pace", async (t) => {
  fakeClock(t);
  const logs = captureLogs(t);
  const bot = new Bot(TOKEN, { botInfo });
  const { calls } = fakeTelegram(bot, () => ({ error: networkError() }));
  const polling = startPolling(bot, {
    notifyOwner: async () => {},
    allowedUpdates: ["message"],
    concurrency: 8,
  });
  // The library's default gave up after 15 hours; the restart path would hide that,
  // so the loop must never have ended at all.
  await advance(t, 16 * 3_600_000, 5_000);
  assert.deepEqual(logs.events("telegram.polling_stopped"), []);
  assert.deepEqual(logs.events("telegram.polling_restarted"), []);
  const [before, last] = calls.slice(-2);
  assert.equal(last!.at - before!.at, 5_000);
  assert.ok(calls.length >= (16 * 3_600_000) / 5_000 - 2, `${calls.length}`);
  await stop(t, polling);
});

test("stop() during a pending restart sends no further getUpdates", async (t) => {
  fakeClock(t);
  const logs = captureLogs(t);
  const bot = new Bot(TOKEN, { botInfo });
  const { calls } = fakeTelegram(bot, () => ({ code: 409 }));
  const polling = startPolling(bot, {
    notifyOwner: async () => {},
    allowedUpdates: ["message"],
    concurrency: 8,
  });
  await advance(t, 1_000);
  assert.equal(logs.events("telegram.polling_stopped").length, 1);
  const sent = calls.length;
  await polling.stop();
  await advance(t, 60_000);
  assert.equal(calls.length, sent);
  assert.deepEqual(logs.events("telegram.polling_restarted"), []);
  assert.equal(polling.status().state, "stopped");
});
