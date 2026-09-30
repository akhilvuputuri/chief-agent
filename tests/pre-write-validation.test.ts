import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { DailyTools } from "../src/daily.js";
import { ScheduleParser } from "../src/schedule.js";
import { ensureUser, type Database } from "../src/db.js";
import { ToolValidationError, toolError } from "../src/tool-errors.js";

// A write whose error classifies as TOOL_FAILED is recorded as uncertain, and one
// uncertain write blocks every later write for the owner (journal 45). Modules on
// model-facing write paths must reject before-write input with ToolValidationError
// or a recognised message. Each exception below states why it is not pre-write.
const WRITE_PATH_MODULES = [
  "calendar-draft.ts",
  "daily.ts",
  "daily-sheet.ts",
  "library-actions.ts",
  "news.ts",
  "parcels.ts",
  "routines.ts",
  "sheets.ts",
  "stocks.ts",
  "watch-window.ts",
  "work.ts",
];
const NOT_PRE_WRITE: Record<string, string> = {
  // An empty result can follow a partial multi-statement revision; stays uncertain.
  "work.ts:Task is running, leased, or its scope changed; inspect it before revising":
    "may follow a write",
  // Thrown inside a try whose catch rethrows it as ToolValidationError.
  "routines.ts:Choose a future time for this routine": "rewrapped",
  // Raised per source while building an edition and caught by the gatherer.
  "news.ts:the feed address returned a web page, not a feed": "caught",
  "news.ts:Unauthorized delivery": "background",
};
test("write-path modules never raise a generic error that would be recorded as uncertain", async () => {
  const found: string[] = [];
  for (const file of WRITE_PATH_MODULES) {
    const src = await readFile(
      new URL(`../src/${file}`, import.meta.url),
      "utf8",
    );
    for (const m of src.matchAll(
      /throw new Error\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g,
    )) {
      const message = m[1]!.slice(1, -1).replace(/\$\{[^}]*\}/g, "x");
      if (
        toolError(new Error(message)).code === "TOOL_FAILED" &&
        !NOT_PRE_WRITE[`${file}:${message}`]
      )
        found.push(`${file}: ${message}`);
    }
  }
  assert.deepEqual(found, []);
});

test("rejected reminder schedules are validation failures and save nothing", async () => {
  const pg = new PGlite();
  try {
    for (const f of ["001_initial.sql", "004_daily.sql"])
      await pg.exec(
        await readFile(new URL("../db/" + f, import.meta.url), "utf8"),
      );
    const db = pg as unknown as Database;
    await ensureUser(db, "a");
    const tools = new DailyTools(
      db,
      new ScheduleParser(() => new Date("2026-10-01T01:00:00Z")),
      { list: async () => ({ events: [] }) },
      { sync: async () => ({ synced: true }) },
    );
    const create = (schedule: string) =>
      tools.call("a", {
        operation: "schedule_create",
        kind: "reminder",
        content: "Test",
        schedule,
        includeEmail: false,
        includeCalendar: false,
      });
    for (const schedule of [
      "every 30 minutes",
      "every day at 13pm",
      "0 25 * * *",
      "*/30 * * * *",
    ])
      await assert.rejects(
        () => create(schedule),
        (error) =>
          error instanceof ToolValidationError &&
          toolError(error).code === "VALIDATION_FAILED",
        schedule,
      );
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM daily_schedules")).rows[0]
        .n,
      0,
    );
    // A schedule with no future run (a past one-off time) is refused the same way.
    const past = new DailyTools(
      db,
      { next: async () => ({ parsed: { kind: "once" }, next: null }) },
      { list: async () => ({ events: [] }) },
      { sync: async () => ({ synced: true }) },
    );
    await assert.rejects(
      () =>
        past.call("a", {
          operation: "schedule_create",
          kind: "reminder",
          content: "Test",
          schedule: "yesterday",
          includeEmail: false,
          includeCalendar: false,
        }),
      (error) => toolError(error).code === "VALIDATION_FAILED",
    );
  } finally {
    await pg.close();
  }
});
