import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { CalendarActions } from "../src/calendar-actions.js";
import { CalendarTools } from "../src/calendar.js";
import { validateDraft } from "../src/calendar-draft.js";
import { JobTools } from "../src/tools.js";
import { telegram, sendCalendarApprovals } from "../src/telegram.js";
import { readConfig } from "../src/config.js";
const draft = {
  title: "Interview preparation",
  start: "2026-09-20T15:00:00+08:00",
  end: "2026-09-20T16:00:00+08:00",
};
async function fixture() {
  const pg = new PGlite();
  for (const f of [
    "001_initial",
    "002_preparation",
    "003_skills",
    "004_daily",
    "005_work",
    "006_runtime",
    "009_calendar_approval",
  ])
    await pg.exec(
      await readFile(new URL(`../db/${f}.sql`, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  await ensureUser(db, "456");
  return { pg, db };
}
test("calendar drafts validate exact dates and reject extra authority", () => {
  assert.throws(() => validateDraft({ ...draft, end: draft.start }));
  assert.throws(() => validateDraft({ ...draft, start: "tomorrow" }));
  assert.throws(() =>
    validateDraft({ ...draft, attendees: ["someone@example.com"] }),
  );
  assert.throws(() => validateDraft({ ...draft, user: "456" }));
});
test("only authenticated Telegram buttons create; expiry, denial, restart and duplicate delivery remain safe", async () => {
  const { pg, db } = await fixture();
  let writes = 0;
  const calendar = {
    create: async (_u: string, id: string, input: unknown) => {
      writes++;
      assert.deepEqual(input, draft);
      return { id: id.replaceAll("-", "") };
    },
    findCreated: async () => null,
  };
  const actions = new CalendarActions(db, calendar, "123");
  const tools = new JobTools(
    db,
    { call: async () => ({}) },
    undefined,
    undefined,
    undefined,
    actions,
  );
  try {
    const saved = await actions.draft("123", randomUUID(), draft);
    assert.equal(writes, 0);
    await assert.rejects(() => actions.draft("456", randomUUID(), draft));
    await assert.rejects(() => actions.decide("456", saved.approvalId, true));
    await assert.rejects(() => tools.decide("123", saved.approvalId, true));
    await assert.rejects(() => tools.decide("123", saved.approvalId, false));
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
          result: {
            id: 999,
            is_bot: true,
            first_name: "Test",
            username: "test_bot",
          },
        };
      if (method === "sendMessage") sent.push(payload);
      return { ok: true, result: { message_id: 11 } } as any;
    });
    await bot.init();
    await sendCalendarApprovals(bot, db, "123");
    await sendCalendarApprovals(bot, db, "123");
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Interview preparation/);
    assert.match(sent[0].text, /Asia\/Singapore/);
    assert.equal(
      sent[0].reply_markup.inline_keyboard[0][0].callback_data,
      `cal:yes:${saved.approvalId}`,
    );
    const update = (user: number, type = "private") =>
      ({
        update_id: 1,
        callback_query: {
          id: "q",
          chat_instance: "x",
          from: { id: user, is_bot: false, first_name: "Test" },
          data: `cal:yes:${saved.approvalId}`,
          message: { message_id: 11, date: 0, chat: { id: user, type } },
        },
      }) as any;
    await bot.handleUpdate(update(456));
    await bot.handleUpdate(update(123, "group"));
    assert.equal(writes, 0);
    await bot.handleUpdate(update(123));
    await bot.handleUpdate(update(123));
    assert.equal(writes, 1);
    const restarted = new CalendarActions(db, calendar, "123");
    assert.equal(
      (await restarted.decide("123", saved.approvalId, true)).status,
      "created",
    );
    assert.equal(writes, 1);
    const declined = await actions.draft("123", randomUUID(), draft);
    await actions.decide("123", declined.approvalId, false);
    await assert.rejects(() =>
      actions.decide("123", declined.approvalId, true),
    );
    const expired = await actions.draft("123", randomUUID(), draft);
    await db.query(
      "UPDATE approvals SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [expired.approvalId],
    );
    await assert.rejects(() => actions.decide("123", expired.approvalId, true));
    assert.equal(writes, 1);
    // Rerunnable older migrations must preserve new approval records.
    for (const f of ["003_skills", "009_calendar_approval"])
      await pg.exec(
        await readFile(new URL(`../db/${f}.sql`, import.meta.url), "utf8"),
      );
  } finally {
    await pg.close();
  }
});
test("uncertain Calendar writes reconcile by GET after restart, never a second POST", async () => {
  const { pg, db } = await fixture();
  let writes = 0,
    found = false;
  const calendar = {
    create: async () => {
      writes++;
      throw new Error("connection lost");
    },
    findCreated: async (_u: string, id: string) =>
      found ? { id: id.replaceAll("-", "") } : null,
  };
  try {
    const actions = new CalendarActions(db, calendar, "123");
    const saved = await actions.draft("123", randomUUID(), draft);
    assert.equal(
      (await actions.decide("123", saved.approvalId, true)).status,
      "uncertain",
    );
    const restarted = new CalendarActions(db, calendar, "123");
    assert.equal(
      (await restarted.decide("123", saved.approvalId, true)).status,
      "uncertain",
    );
    found = true;
    assert.equal(
      (await restarted.decide("123", saved.approvalId, true)).status,
      "created",
    );
    assert.equal(writes, 1);
  } finally {
    await pg.close();
  }
});
test("Google creation uses primary calendar, approved fields and no guests", async () => {
  const calls: any[] = [];
  const id = randomUUID();
  const c = new CalendarTools(
    {
      owner: "123",
      email: "owner@example.com",
      clientId: "x",
      clientSecret: "x",
      refreshToken: "x",
    },
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("oauth2.googleapis.com"))
        return Response.json({ access_token: "test" });
      if (String(url).includes("userinfo"))
        return Response.json({ email: "owner@example.com" });
      return Response.json({ id: id.replaceAll("-", "") });
    },
  );
  await assert.rejects(() => c.create("456", id, draft));
  assert.equal(calls.length, 0);
  await c.create("123", id, draft);
  const last = calls.at(-1);
  assert.match(last.url, /primary\/events\?sendUpdates=none/);
  const body = JSON.parse(last.init.body);
  assert.equal(body.id, id.replaceAll("-", ""));
  assert.equal(body.start.dateTime, draft.start);
  assert.equal(body.summary, draft.title);
  assert.equal(body.attendees, undefined);
  assert.equal(body.extendedProperties.private.companionApproval, id);
});
