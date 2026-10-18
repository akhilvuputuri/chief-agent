import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { ensureUser, type Database } from "../src/db.js";
import { buildBriefing } from "../src/daily-briefing.js";
async function fixture() {
  const pg = new PGlite();
  for (const f of ["001_initial", "002_preparation", "003_skills", "004_daily"])
    await pg.exec(
      await readFile(new URL(`../db/${f}.sql`, import.meta.url), "utf8"),
    );
  const db = pg as unknown as Database;
  await ensureUser(db, "123");
  await ensureUser(db, "456");
  const task = (title: string, status = "open", user = "123", kind = "task") =>
    db.query(
      "INSERT INTO daily_items(id,user_id,kind,title,content,status) VALUES($1,$2,$3,$4,'',$5)",
      [randomUUID(), user, kind, title, status],
    );
  const job = (over: Partial<Parameters<typeof buildBriefing>[0]> = {}) => ({
    id: randomUUID(),
    user_id: "123",
    content: "Review and update my to-do list",
    include_calendar: false,
    include_email: false,
    ...over,
  });
  const calls: string[] = [];
  const deps = {
    db,
    now: () => new Date("2026-10-18T11:00:00Z"),
    calendar: {
      list: async () => {
        calls.push("calendar");
        return { events: [{ title: "Dentist", start: { dateTime: "x" } }] };
      },
    },
    gmail: {
      call: async () => {
        calls.push("gmail");
        throw new Error("no auth");
      },
    },
  };
  return { db, task, job, deps, calls };
}
test("a to-do briefing leads with the owner's words and lists the live open tasks inline", async () => {
  // 7 October: "Review and update my to-do list" arrived as text alone, and the owner asked what it was.
  const f = await fixture();
  await f.task("Send wedding messages");
  await f.task("Book the dentist");
  await f.task("Already done", "done");
  await f.task("A note, not a task", "open", "123", "note");
  await f.task("Someone else's task", "open", "456");
  const brief = await buildBriefing(f.job(), f.deps);
  const lines = brief.reply.split("\n");
  assert.equal(lines[0], "Review and update my to-do list — 18/10/2026");
  assert.match(
    brief.reply,
    /Open tasks:\n• Send wedding messages\n• Book the dentist/,
  );
  assert.doesNotMatch(brief.reply, /Already done|A note|Someone else/);
  assert.doesNotMatch(brief.reply, /Open Sections/);
  assert.deepEqual(f.calls, []);
});
test("with no open tasks the briefing says so; calendar and email stay optional sections", async () => {
  const f = await fixture();
  const brief = await buildBriefing(
    f.job({
      content: "Morning brief",
      include_calendar: true,
      include_email: true,
    }),
    f.deps,
  );
  assert.match(
    brief.reply,
    /^Morning brief — 18\/10\/2026\n\nOpen tasks:\nNo open tasks\./,
  );
  assert.match(
    brief.reply,
    /Open Sections for Calendar — next 24 hours \(up to 8\), Gmail\.$/,
  );
  assert.deepEqual(
    brief.sections!.map((s) => s.title),
    ["Open tasks (up to 10)", "Calendar — next 24 hours (up to 8)", "Gmail"],
  );
  assert.deepEqual(f.calls, ["calendar", "gmail"]);
});
test("a long lead is cut by code point with an ellipsis, and unread email appears as a section", async () => {
  const f = await fixture();
  const brief = await buildBriefing(
    f.job({ content: "a" + "😀".repeat(400), include_email: true }),
    {
      ...f.deps,
      gmail: {
        call: async () => ({
          messages: [{ from: "Bank", subject: "Statement ready", snippet: "" }],
        }),
      },
    },
  );
  const lead = brief.reply.split(" — ")[0];
  assert.equal(Array.from(lead).length, 300);
  assert.ok(lead.endsWith("…"));
  assert.doesNotMatch(lead, /[\ud800-\udbff](?![\udc00-\udfff])/);
  assert.equal(
    brief.sections![1].title,
    "Unread inbox — past 24 hours (up to 5)",
  );
});
