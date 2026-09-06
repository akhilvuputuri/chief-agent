import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { DailyTools, DailyWorker } from "../src/daily.js";
import { CalendarTools } from "../src/calendar.js";
import { ensureUser, type Database } from "../src/db.js";
import { action } from "../src/protocol.js";
test("daily items and schedules are owner-scoped; due delivery survives worker recreation, cancellation and errors", async () => {
  const pg = new PGlite();
  try {
    for (const f of ["001_initial.sql", "004_daily.sql"])
      await pg.exec(
        await readFile(new URL("../db/" + f, import.meta.url), "utf8"),
      );
    const db = pg as unknown as Database;
    await ensureUser(db, "a");
    await ensureUser(db, "b");
    const parser = {
      next: async (schedule: string, parsed?: any) => ({
        parsed: parsed ?? { kind: schedule === "daily" ? "cron" : "once" },
        next: new Date(Date.now() + 3600000).toISOString(),
      }),
    };
    const tools = new DailyTools(
      db,
      parser,
      { list: async () => ({ events: [] }) },
      { sync: async () => ({ synced: true }) },
    );
    const a: any = await tools.call("a", {
      operation: "item_save",
      kind: "task",
      title: "Renew passport",
      content: "",
    });
    await assert.rejects(() =>
      tools.call("b", { operation: "item_update", id: a.id, status: "done" }),
    );
    await tools.call("a", {
      operation: "item_update",
      id: a.id,
      status: "done",
    });
    assert.equal(
      (
        (await tools.call("a", { operation: "item_list", kind: "task" })) as any
      )[0].status,
      "done",
    );
    assert.deepEqual(await tools.call("b", { operation: "item_list" }), []);
    const create = async (schedule = "once") =>
      (await tools.call("a", {
        operation: "schedule_create",
        kind: "reminder",
        content: "Test",
        schedule,
        includeEmail: false,
        includeCalendar: false,
      })) as any;
    const one = await create(),
      cancelled = await create(),
      recurring = await create("daily");
    await assert.rejects(() =>
      tools.call("b", {
        operation: "schedule_update",
        id: one.id,
        status: "cancelled",
      }),
    );
    await tools.call("a", {
      operation: "schedule_update",
      id: cancelled.id,
      status: "cancelled",
    });
    await db.query(
      "UPDATE daily_schedules SET next_run=now()-interval '1 minute'",
    );
    const sent: string[] = [];
    const factory = () =>
      new DailyWorker(
        db,
        parser,
        async (_u, t) => {
          sent.push(t);
        },
        async () => "",
        async () => {},
      );
    await factory().tick();
    await factory().tick();
    assert.equal(sent.length, 2);
    const rows: any = await tools.call("a", { operation: "schedule_list" });
    assert.equal(rows.find((x: any) => x.id === one.id).status, "completed");
    assert.equal(
      rows.find((x: any) => x.id === recurring.id).status,
      "scheduled",
    );
    const fail = await create();
    await db.query(
      "UPDATE daily_schedules SET next_run=now()-interval '1 minute' WHERE id=$1",
      [fail.id],
    );
    await new DailyWorker(
      db,
      parser,
      async () => {
        throw Error("ambiguous send");
      },
      async () => "",
      async () => {},
    ).tick();
    assert.equal(
      (
        await db.query("SELECT status FROM daily_schedules WHERE id=$1", [
          fail.id,
        ])
      ).rows[0].status,
      "failed",
    );
    const crash = await create();
    await db.query(
      "UPDATE daily_schedules SET status='processing',started_at=now()-interval '11 minutes',lease=$2 WHERE id=$1",
      [crash.id, randomUUID()],
    );
    await factory().tick();
    assert.equal(sent.length, 2);
    assert.equal(
      (
        await db.query("SELECT status FROM daily_schedules WHERE id=$1", [
          crash.id,
        ])
      ).rows[0].status,
      "failed",
    );
    assert.throws(() =>
      action.parse({
        operation: "schedule_create",
        kind: "reminder",
        schedule: "in 1h",
        content: "x",
        user: "b",
      }),
    );
  } finally {
    await pg.close();
  }
});
test("calendar is read-only, bounded and verifies owner/account before event reads", async () => {
  const calls: { url: string; method: string }[] = [];
  const request = (async (input: any, init: any) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    return Response.json(
      url.includes("/token")
        ? { access_token: "test" }
        : url.includes("userinfo")
          ? { email: "a@example.com" }
          : {
              items: [
                { id: "1", summary: "Lunch", start: { date: "2026-09-07" } },
              ],
            },
    );
  }) as typeof fetch;
  const c = new CalendarTools(
    {
      owner: "a",
      email: "a@example.com",
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "test",
    },
    request,
  );
  await assert.rejects(() =>
    c.list("b", "2026-09-06T00:00:00Z", "2026-09-07T00:00:00Z"),
  );
  assert.equal(calls.length, 0);
  await assert.rejects(() =>
    c.list("a", "2026-09-06T00:00:00Z", "2027-09-07T00:00:00Z"),
  );
  assert.equal(calls.length, 0);
  const r = await c.list("a", "2026-09-06T00:00:00Z", "2026-09-07T00:00:00Z");
  assert.equal(r.events[0].title, "Lunch");
  assert.equal(calls[2].method, "GET");
  assert.match(calls[2].url, /calendars\/primary\/events/);
  const wrong = new CalendarTools(
    {
      owner: "a",
      email: "wrong@example.com",
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "test",
    },
    request,
  );
  await assert.rejects(
    () => wrong.list("a", "2026-09-06T00:00:00Z", "2026-09-07T00:00:00Z"),
    /Wrong/,
  );
});
