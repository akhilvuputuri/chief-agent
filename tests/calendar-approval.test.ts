import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { CalendarActions } from "../src/calendar-actions.js";
import { CalendarNotSentError, CalendarTools } from "../src/calendar.js";
import { ToolValidationError, toolError } from "../src/tool-errors.js";
import { dayAfter, dayBefore, validateDraft } from "../src/calendar-draft.js";
import { JobTools } from "../src/tools.js";
import { telegram, sendCalendarApprovals } from "../src/telegram.js";
import { readConfig } from "../src/config.js";
const draft = {
  title: "Interview preparation",
  start: "2026-09-20T15:00:00+08:00",
  end: "2026-09-20T16:00:00+08:00",
};
test("monitoring Calendar reads expand instances and paginate without changing ordinary result projections", async () => {
  let calls: URL[] = [];
  const request = (async (input: unknown) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "test" });
    if (url.pathname.endsWith("/userinfo"))
      return Response.json({ email: "owner@example.com" });
    const second = !!url.searchParams.get("pageToken");
    return Response.json({
      items: [
        {
          id: second ? "two" : "one",
          summary: "Meeting",
          start: { dateTime: draft.start },
          end: { dateTime: draft.end },
          attendees: [{ email: "external@example.net" }],
          recurringEventId: "series",
          originalStartTime: { dateTime: draft.start },
        },
      ],
      ...(second ? {} : { nextPageToken: "page-two" }),
    });
  }) as typeof fetch;
  const calendar = new CalendarTools(
    {
      owner: "a",
      email: "owner@example.com",
      clientId: "x",
      clientSecret: "x",
      refreshToken: "x",
    },
    request,
  );
  const normal = await calendar.list("a", draft.start, draft.end);
  assert.equal(normal.truncated, true);
  assert.ok(!("attendees" in normal.events[0]));
  calls = [];
  const monitor = await calendar.list("a", draft.start, draft.end, true);
  assert.equal(monitor.events.length, 2);
  assert.equal(monitor.truncated, false);
  assert.equal(monitor.events[0].recurringEventId, "series");
  const lists = calls.filter((u) => u.pathname.endsWith("/events"));
  assert.equal(lists.length, 2);
  assert.equal(lists[0].searchParams.get("singleEvents"), "true");
  assert.equal(lists[1].searchParams.get("pageToken"), "page-two");
  assert.ok(!lists[0].searchParams.has("syncToken"));
});
test("monitoring normalizes timezone-qualified local times and rejects missing or invalid zones", async () => {
  let timeZone: string | undefined = "Asia/Singapore";
  let offset = false;
  const calendar = new CalendarTools(
    {
      owner: "a",
      email: "owner@example.com",
      clientId: "fixture",
      clientSecret: "fixture",
      refreshToken: "fixture",
    },
    (async (input: unknown) => {
      const url = String(input);
      return Response.json(
        url.includes("oauth2.googleapis.com")
          ? { access_token: "fixture" }
          : url.includes("/userinfo")
            ? { email: "owner@example.com" }
            : {
                items: [
                  {
                    id: "local",
                    start: {
                      dateTime:
                        "2026-10-05T09:00:00" + (offset ? "+08:00" : ""),
                      timeZone,
                    },
                    end: {
                      dateTime:
                        "2026-10-05T10:00:00" + (offset ? "+08:00" : ""),
                      timeZone,
                    },
                    recurringEventId: "series",
                    originalStartTime: {
                      dateTime:
                        "2026-10-05T09:00:00" + (offset ? "+08:00" : ""),
                      timeZone,
                    },
                  },
                ],
              },
      );
    }) as typeof fetch,
  );
  const result = await calendar.list(
    "a",
    "2026-10-05T00:00:00Z",
    "2026-10-05T04:00:00Z",
    true,
  );
  assert.equal(result.events[0].start.dateTime, "2026-10-05T01:00:00.000Z");
  assert.equal(
    result.events[0].originalStartTime.dateTime,
    "2026-10-05T01:00:00.000Z",
  );
  offset = true;
  const equivalent = await calendar.list(
    "a",
    "2026-10-05T00:00:00Z",
    "2026-10-05T04:00:00Z",
    true,
  );
  assert.equal(
    equivalent.events[0].start.dateTime,
    result.events[0].start.dateTime,
  );
  assert.equal(
    equivalent.events[0].originalStartTime.dateTime,
    result.events[0].originalStartTime.dateTime,
  );
  offset = false;
  timeZone = undefined;
  await assert.rejects(() =>
    calendar.list("a", "2026-10-05T00:00:00Z", "2026-10-05T04:00:00Z", true),
  );
  timeZone = "Invalid/Zone";
  await assert.rejects(() =>
    calendar.list("a", "2026-10-05T00:00:00Z", "2026-10-05T04:00:00Z", true),
  );
});
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
test("drafts of any length save; invalid shapes are definite validation failures", async () => {
  const { pg, db } = await fixture();
  const calendar = {
    create: async () => assert.fail("no insert"),
    findCreated: async () => null,
  };
  try {
    const actions = new CalendarActions(db, calendar, "123");
    const long = await actions.draft("123", randomUUID(), {
      ...draft,
      end: "2026-10-05T16:00:00+08:00", // fifteen days
    });
    assert.equal(long.status, "awaiting_approval");
    const allDay = await actions.draft("123", randomUUID(), {
      title: "Away",
      start: "2026-11-02",
      end: "2026-11-17",
      allDay: true,
    });
    assert.match(allDay.preview, /All day, 16 days/);
    assert.match(allDay.preview, /First day: Monday, 2 November 2026/);
    assert.match(allDay.preview, /Last day: Tuesday, 17 November 2026/);
    const single = await actions.draft("123", randomUUID(), {
      title: "Away",
      start: "2026-11-09",
      end: "2026-11-09",
      allDay: true,
    });
    assert.match(single.preview, /All day, 1 day\n/);
    for (const [bad, message] of [
      [{ ...draft, end: draft.start }, /end after it starts/],
      [{ ...draft, end: "2026-09-19T16:00:00+08:00" }, /end after it starts/],
      [{ ...draft, start: "2026-09-20", end: "2026-09-21" }, /set allDay/],
      [{ ...draft, allDay: true }, /YYYY-MM-DD/],
      [{ ...draft, end: "2026-09-20T16:00:00+99:99" }, /end after it starts/],
      [
        { title: "x", start: "2026-11-09", end: "9999-12-31", allDay: true },
        /before 9999-12-31/,
      ],
      [
        { title: "x", start: "2027-02-28", end: "2027-02-29", allDay: true },
        /YYYY-MM-DD/,
      ],
      [
        { title: "x", start: "2026-11-09", end: "2026-11-08", allDay: true },
        /on or after its first day/,
      ],
    ] as const)
      await assert.rejects(
        () => actions.draft("123", randomUUID(), bad),
        (error) =>
          error instanceof ToolValidationError &&
          toolError(error).code === "VALIDATION_FAILED" &&
          message.test(error.message),
      );
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM approvals")).rows[0].n,
      3,
    );
  } finally {
    await pg.close();
  }
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
    await assert.rejects(
      () => restarted.draft("123", randomUUID(), draft),
      (error) =>
        error instanceof ToolValidationError &&
        toolError(error).code === "VALIDATION_FAILED" &&
        /No new draft was saved/.test(error.message),
    );
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM approvals")).rows[0].n,
      1,
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
  // All-day: Google's end date is exclusive, so the inclusive last day moves forward one day.
  await c.create("123", id, {
    title: "Away",
    start: "2026-12-31",
    end: "2027-01-01",
    allDay: true,
  });
  const allDay = JSON.parse(calls.at(-1).init.body);
  assert.deepEqual(allDay.start, { date: "2026-12-31" });
  assert.deepEqual(allDay.end, { date: "2027-01-02" });
  assert.equal(dayAfter("2028-02-28"), "2028-02-29");
  assert.equal(dayBefore("2028-03-01"), "2028-02-29");
});
test("calendar_list gives an all-day event's inclusive last day", async () => {
  const c = new CalendarTools(
    {
      owner: "123",
      email: "owner@example.com",
      clientId: "x",
      clientSecret: "x",
      refreshToken: "x",
    },
    async (url) => {
      if (String(url).includes("oauth2.googleapis.com"))
        return Response.json({ access_token: "test" });
      if (String(url).includes("userinfo"))
        return Response.json({ email: "owner@example.com" });
      return Response.json({
        items: [
          {
            id: "a",
            start: { date: "2026-11-02" },
            end: { date: "2026-11-18" },
          },
          {
            id: "b",
            start: { dateTime: "2026-11-03T09:00:00+08:00" },
            end: { dateTime: "2026-11-03T10:00:00+08:00" },
          },
        ],
      });
    },
  );
  const { events } = await c.list(
    "123",
    "2026-11-01T00:00:00+08:00",
    "2026-11-30T00:00:00+08:00",
  );
  assert.equal(events[0].lastDay, "2026-11-17");
  assert.equal(events[1].lastDay, undefined);
});
test("Google credential failures stop before the insert and name the right recovery", async () => {
  const client = (respond: (url: string) => Response, calls: string[] = []) =>
    new CalendarTools(
      {
        owner: "123",
        email: "owner@example.com",
        clientId: "x",
        clientSecret: "x",
        refreshToken: "x",
      },
      async (url) => {
        calls.push(String(url));
        return respond(String(url));
      },
    );
  const rejects = async (c: CalendarTools, reason: string, code: string) => {
    await assert.rejects(
      () => c.create("123", randomUUID(), draft),
      (e) => e instanceof CalendarNotSentError && e.reason === reason,
    );
    const listed = await c
      .list("123", draft.start, draft.end)
      .then(() => assert.fail("list should reject"), toolError);
    assert.equal(listed.code, code);
  };
  const calls: string[] = [];
  const expired = client(
    () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    calls,
  );
  await rejects(expired, "authorization", "AUTHORIZATION_REQUIRED");
  assert.deepEqual(calls, [
    "https://oauth2.googleapis.com/token",
    "https://oauth2.googleapis.com/token",
  ]);
  // A bad client secret is not fixed by reconnecting the account.
  await rejects(
    client(() => Response.json({ error: "invalid_client" }, { status: 401 })),
    "configuration",
    "NOT_CONFIGURED",
  );
  await rejects(
    client(() => new Response("not json", { status: 400 })),
    "configuration",
    "NOT_CONFIGURED",
  );
  await rejects(
    client((url) =>
      url.includes("oauth2.googleapis.com")
        ? Response.json({ access_token: "test" })
        : new Response("", { status: 403 }),
    ),
    "authorization",
    "AUTHORIZATION_REQUIRED",
  );
  await rejects(
    client((url) =>
      url.includes("oauth2.googleapis.com")
        ? Response.json({ access_token: "test" })
        : Response.json({ email: "someone@example.com" }),
    ),
    "authorization",
    "AUTHORIZATION_REQUIRED",
  );
});
test("a failure before sending is a definite non-creation that never retries or blocks new drafts", async () => {
  const { pg, db } = await fixture();
  let attempts = 0,
    checks = 0;
  const calendar = {
    create: async () => {
      attempts++;
      throw new CalendarNotSentError(
        "Google authorization expired or was revoked (invalid_grant); reconnect required",
        "authorization",
      );
    },
    findCreated: async () => {
      checks++;
      return null;
    },
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
          result: { id: 999, is_bot: true, first_name: "T", username: "t" },
        };
      if (method === "sendMessage") sent.push(payload);
      return { ok: true, result: { message_id: 11 } } as any;
    });
    await bot.init();
    await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "q",
        chat_instance: "x",
        from: { id: 123, is_bot: false, first_name: "T" },
        data: `cal:yes:${saved.approvalId}`,
        message: {
          message_id: 11,
          date: 0,
          chat: { id: 123, type: "private" },
        },
      },
    } as any);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /No event was created/);
    assert.match(sent[0].text, /Reconnect Calendar/);
    assert.deepEqual(sent[0].reply_markup.inline_keyboard, []);
    const row = (
      await db.query("SELECT status,payload FROM approvals WHERE id=$1", [
        saved.approvalId,
      ])
    ).rows[0];
    assert.equal(row.status, "approved");
    assert.equal(row.payload.execution, "failed");
    assert.equal(row.payload.failure.code, "authorization");
    assert.deepEqual(await actions.decide("123", saved.approvalId, true), {
      status: "failed",
      reason: "authorization",
    });
    assert.equal(attempts, 1);
    assert.equal(checks, 0);
    // Unlike an uncertain write, a definite non-creation must not block the next draft.
    assert.equal(
      (await actions.draft("123", randomUUID(), draft)).status,
      "awaiting_approval",
    );
  } finally {
    await pg.close();
  }
});
test("failures once the insert request is sent stay uncertain, never a definite non-creation", async () => {
  const { pg, db } = await fixture();
  let inserts = 0;
  const outcomes = [
    () => Promise.reject(new Error("socket hang up")),
    () => Promise.resolve(new Response("", { status: 500 })),
  ];
  try {
    for (const outcome of outcomes) {
      const c = new CalendarTools(
        {
          owner: "123",
          email: "owner@example.com",
          clientId: "x",
          clientSecret: "x",
          refreshToken: "x",
        },
        async (url) => {
          if (String(url).includes("oauth2.googleapis.com"))
            return Response.json({ access_token: "test" });
          if (String(url).includes("userinfo"))
            return Response.json({ email: "owner@example.com" });
          inserts++;
          return outcome();
        },
      );
      await assert.rejects(
        () => c.create("123", randomUUID(), draft),
        (e) => !(e instanceof CalendarNotSentError),
      );
      const actions = new CalendarActions(db, c, "123");
      const saved = await actions.draft("123", randomUUID(), draft);
      assert.equal(
        (await actions.decide("123", saved.approvalId, true)).status,
        "uncertain",
      );
      await db.query("DELETE FROM approvals WHERE id=$1", [saved.approvalId]);
    }
    assert.equal(inserts, 4);
    // The cause is recorded as a category and HTTP status, never provider text.
    assert.deepEqual(
      (
        await db.query(
          "SELECT data FROM events WHERE type='calendar.uncertain' ORDER BY id",
        )
      ).rows.map((r) => [r.data.cause, r.data.httpStatus]),
      [
        ["error", undefined],
        ["http", 500],
      ],
    );
  } finally {
    await pg.close();
  }
});
test("an uncertain write with no event is settled once no attempt can be in flight, unblocking new drafts", async () => {
  const { pg, db } = await fixture();
  let writes = 0,
    checks = 0,
    found = false,
    checkFails = false;
  const calendar = {
    create: async () => {
      writes++;
      throw new Error("connection lost");
    },
    findCreated: async (_u: string, id: string) => {
      checks++;
      if (checkFails) throw new Error("Google request failed (503)");
      return found ? { id: id.replaceAll("-", "") } : null;
    },
  };
  const age = (id: string) =>
    db.query(
      "UPDATE approvals SET expires_at=now()-interval '6 minutes' WHERE id=$1",
      [id],
    );
  const blocked = (actions: CalendarActions, pattern: RegExp) =>
    assert.rejects(
      () => actions.draft("123", randomUUID(), draft),
      (error) =>
        error instanceof ToolValidationError &&
        /No new draft was saved/.test(error.message) &&
        pattern.test(error.message),
    );
  try {
    const actions = new CalendarActions(db, calendar, "123");
    const first = await actions.draft("123", randomUUID(), draft);
    assert.equal(
      (await actions.decide("123", first.approvalId, true)).status,
      "uncertain",
    );
    // While the attempt could still be in flight, absence proves nothing.
    await blocked(actions, /checked again automatically/);
    assert.equal(
      (await actions.decide("123", first.approvalId, true)).status,
      "uncertain",
    );
    await age(first.approvalId);
    checkFails = true;
    await blocked(actions, /checking Google Calendar for it failed/);
    checkFails = false;
    // Check status after the window confirms it was never created.
    assert.deepEqual(await actions.decide("123", first.approvalId, true), {
      status: "failed",
      reason: "not_found",
    });
    const row = (
      await db.query("SELECT status,payload FROM approvals WHERE id=$1", [
        first.approvalId,
      ])
    ).rows[0];
    assert.equal(row.status, "approved");
    assert.equal(row.payload.execution, "failed");
    assert.equal(row.payload.failure.code, "not_found");
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM events WHERE type='calendar.reconciled' AND data->>'id'=$1",
          [first.approvalId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (await actions.draft("123", randomUUID(), draft)).status,
      "awaiting_approval",
    );

    // An old stuck approval is settled by the next draft itself.
    await db.query("DELETE FROM approvals");
    const stuck = await actions.draft("123", randomUUID(), draft);
    await actions.decide("123", stuck.approvalId, true);
    await age(stuck.approvalId);
    const next = await actions.draft("123", randomUUID(), draft);
    assert.equal(next.status, "awaiting_approval");
    assert.equal(
      (
        await db.query("SELECT payload FROM approvals WHERE id=$1", [
          stuck.approvalId,
        ])
      ).rows[0].payload.failure.code,
      "not_found",
    );

    // If the event did land, it is recorded as created and the owner confirms first.
    await db.query("DELETE FROM approvals");
    const landed = await actions.draft("123", randomUUID(), draft);
    await actions.decide("123", landed.approvalId, true);
    await age(landed.approvalId);
    found = true;
    await blocked(actions, /recorded as created/);
    assert.equal(
      (await actions.decide("123", landed.approvalId, true)).status,
      "created",
    );
    assert.equal(
      (await actions.draft("123", randomUUID(), draft)).status,
      "awaiting_approval",
    );
    // Settlement only ever reads: one insert per approved draft.
    assert.equal(writes, 3);
    assert.ok(checks > 0);
  } finally {
    await pg.close();
  }
});
test("the insert is only sent within a bounded window after the approval is claimed", async () => {
  const { pg, db } = await fixture();
  let posts = 0;
  const c = new CalendarTools(
    {
      owner: "123",
      email: "owner@example.com",
      clientId: "x",
      clientSecret: "x",
      refreshToken: "x",
    },
    async (url, init) => {
      if (String(url).includes("oauth2.googleapis.com"))
        return Response.json({ access_token: "test" });
      if (String(url).includes("userinfo"))
        return Response.json({ email: "owner@example.com" });
      if (init?.method === "POST") posts++;
      return new Response("", { status: 404 });
    },
  );
  try {
    // A stalled claim-to-send path is a definite non-creation, never a late POST.
    await assert.rejects(
      () => c.create("123", randomUUID(), draft, performance.now() - 1),
      (e) => e instanceof CalendarNotSentError && e.reason === "not_sent",
    );
    assert.equal(posts, 0);
    // A real 404 reads as absent.
    assert.equal(await c.findCreated("123", randomUUID()), null);
    let sendBy = 0;
    const actions = new CalendarActions(
      db,
      {
        create: async (_u, id, _d, deadline) => {
          sendBy = deadline!;
          return { id: id.replaceAll("-", "") };
        },
        findCreated: async () => null,
      },
      "123",
    );
    const saved = await actions.draft("123", randomUUID(), draft);
    const before = performance.now();
    await actions.decide("123", saved.approvalId, true);
    assert.ok(sendBy > before && sendBy <= performance.now() + 60_000);
  } finally {
    await pg.close();
  }
});
test("settlement covers interrupted, concurrent and deleted attempts and logs failed checks", async () => {
  const { pg, db } = await fixture();
  let remote: any = null,
    checkFails = false;
  const actions = new CalendarActions(
    db,
    {
      create: async () => {
        throw new Error("connection lost");
      },
      findCreated: async () => {
        if (checkFails) throw new Error("socket hang up");
        return remote;
      },
    },
    "123",
  );
  const stuck = async (execution: string, minutes: number) => {
    const saved = await actions.draft("123", randomUUID(), draft);
    await actions.decide("123", saved.approvalId, true);
    await db.query(
      `UPDATE approvals SET payload=jsonb_set(payload,'{execution}',$2::jsonb),expires_at=now()-make_interval(mins=>$3) WHERE id=$1`,
      [saved.approvalId, JSON.stringify(execution), minutes],
    );
    return saved.approvalId;
  };
  const execution = async (id: string) =>
    (await db.query("SELECT payload FROM approvals WHERE id=$1", [id])).rows[0]
      .payload.execution;
  try {
    // Four minutes after expiry is still inside the margin.
    const recent = await stuck("uncertain", 4);
    assert.equal(
      (await actions.decide("123", recent, true)).status,
      "uncertain",
    );
    await db.query("DELETE FROM approvals");
    // A process that died mid-insert leaves "creating"; it settles the same way.
    const interrupted = await stuck("creating", 6);
    assert.equal(
      (await actions.draft("123", randomUUID(), draft)).status,
      "awaiting_approval",
    );
    assert.equal(await execution(interrupted), "failed");
    await db.query("DELETE FROM approvals");
    await db.query("DELETE FROM events");
    // Two checks at once agree, and only one records the settlement.
    const raced = await stuck("uncertain", 6);
    const results = await Promise.all([
      actions.decide("123", raced, true),
      actions.decide("123", raced, true),
    ]);
    for (const r of results)
      assert.deepEqual(r, { status: "failed", reason: "not_found" });
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM events WHERE type='calendar.reconciled'",
        )
      ).rows[0].n,
      1,
    );
    await db.query("DELETE FROM approvals");
    // Created then deleted by the owner: settled without recreating, drafts continue.
    const deleted = await stuck("uncertain", 1);
    remote = { id: deleted.replaceAll("-", ""), status: "cancelled" };
    assert.deepEqual(await actions.decide("123", deleted, true), {
      status: "deleted",
    });
    assert.equal(await execution(deleted), "deleted");
    assert.equal(
      (await actions.draft("123", randomUUID(), draft)).status,
      "awaiting_approval",
    );
    await db.query("DELETE FROM approvals");
    remote = null;
    // A failed check keeps the block and records a bounded category.
    const unchecked = await stuck("uncertain", 6);
    checkFails = true;
    await assert.rejects(
      () => actions.draft("123", randomUUID(), draft),
      /checking Google Calendar for it failed/,
    );
    assert.equal(await execution(unchecked), "uncertain");
    assert.equal(
      (
        await db.query(
          "SELECT data FROM events WHERE type='calendar.check_failed'",
        )
      ).rows[0].data.cause,
      "error",
    );
  } finally {
    await pg.close();
  }
});
test("late callbacks never reopen or overwrite a settled approval, and a delayed claim cannot send", async () => {
  const { pg, db } = await fixture();
  const settleNow = (id: string, payload: object) =>
    db.query("UPDATE approvals SET payload=payload || $2::jsonb WHERE id=$1", [
      id,
      JSON.stringify(payload),
    ]);
  const notFound = { execution: "failed", failure: { code: "not_found" } };
  const row = async (id: string) =>
    (await db.query("SELECT payload FROM approvals WHERE id=$1", [id])).rows[0]
      .payload;
  const count = async (type: string) =>
    (await db.query("SELECT count(*)::int n FROM events WHERE type=$1", [type]))
      .rows[0].n;
  try {
    // An insert error handled after settlement leaves the settled outcome alone.
    let fail = new CalendarActions(
      db,
      {
        create: async (_u, id) => {
          await settleNow(id, notFound);
          throw new Error("connection lost");
        },
        findCreated: async () => null,
      },
      "123",
    );
    let saved = await fail.draft("123", randomUUID(), draft);
    assert.deepEqual(await fail.decide("123", saved.approvalId, true), {
      status: "failed",
      reason: "not_found",
    });
    assert.equal((await row(saved.approvalId)).execution, "failed");
    assert.equal((await row(saved.approvalId)).failure.code, "not_found");
    assert.equal(await count("calendar.uncertain"), 0);
    assert.equal(
      (await fail.draft("123", randomUUID(), draft)).status,
      "awaiting_approval",
    );
    await db.query("DELETE FROM approvals");
    // A late success does not overwrite a recorded deletion or add a receipt.
    fail = new CalendarActions(
      db,
      {
        create: async (_u, id) => {
          await settleNow(id, { execution: "deleted" });
          return { id: id.replaceAll("-", "") };
        },
        findCreated: async () => null,
      },
      "123",
    );
    saved = await fail.draft("123", randomUUID(), draft);
    assert.deepEqual(await fail.decide("123", saved.approvalId, true), {
      status: "deleted",
    });
    assert.equal((await row(saved.approvalId)).execution, "deleted");
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM tool_receipts")).rows[0].n,
      0,
    );
    await db.query("DELETE FROM approvals");
    // The claim commits, but its response arrives after settlement: the send
    // deadline was fixed before the claim, so the insert is never sent.
    let clock = 0,
      posts = 0,
      deadline = 0;
    const slow = new Proxy(db, {
      get: (target, key) =>
        key === "query"
          ? async (text: string, values?: unknown[]) => {
              const result = await target.query(text, values);
              if (text.startsWith("UPDATE approvals SET status=$3")) {
                clock += 7 * 60_000;
                await settleNow(result.rows[0].id, notFound);
              }
              return result;
            }
          : (target as any)[key],
    });
    const delayed = new CalendarActions(
      slow,
      {
        create: async (_u, _id, _d, sendBy) => {
          deadline = sendBy!;
          if (clock > sendBy!)
            throw new CalendarNotSentError("window passed", "not_sent");
          posts++;
          return {};
        },
        findCreated: async () => null,
      },
      "123",
      () => clock,
    );
    saved = await delayed.draft("123", randomUUID(), draft);
    assert.deepEqual(await delayed.decide("123", saved.approvalId, true), {
      status: "failed",
      reason: "not_found",
    });
    assert.equal(deadline, 60_000);
    assert.equal(posts, 0);
    assert.equal((await row(saved.approvalId)).failure.code, "not_found");
  } finally {
    await pg.close();
  }
});
