import { WorkWorker } from "./work-worker.js";
import { DailyTools, DailyWorker, ScheduleParser } from "./daily.js";
import { CalendarTools } from "./calendar.js";
import { DailySheet } from "./daily-sheet.js";
import { SheetsTools } from "./sheets.js";
import { GmailTools } from "./gmail.js";
import { readConfig } from "./config.js";
import { connect } from "./db.js";
import { JobTools } from "./tools.js";
import { WebTools } from "./providers.js";
import { Assistant, Hermes } from "./agent.js";
import { server } from "./server.js";
import { telegram } from "./telegram.js";
const c = readConfig();
const db = connect(c.DATABASE_URL);
await db.query("SELECT 1");
const google = {
  owner: c.GMAIL_OWNER_USER_ID,
  email: c.GMAIL_EMAIL,
  clientId: c.GOOGLE_CLIENT_ID,
  clientSecret: c.GOOGLE_CLIENT_SECRET,
  refreshToken: c.GOOGLE_REFRESH_TOKEN,
};
const gmail = new GmailTools(google);
const calendar = new CalendarTools({
  ...google,
  refreshToken: c.CALENDAR_REFRESH_TOKEN,
});
const mirror = new DailySheet(db, {
  ...google,
  owner: c.SHEETS_OWNER_USER_ID,
  refreshToken: c.SHEETS_REFRESH_TOKEN,
  spreadsheetId: c.DAILY_SPREADSHEET_ID,
});
const parser = new ScheduleParser(c.HERMES_URL, c.INTERNAL_API_TOKEN);
const daily = new DailyTools(db, parser, calendar, mirror);
const assistant = new Assistant(
  db,
  new Hermes(c.HERMES_URL, c.INTERNAL_API_TOKEN),
  new JobTools(
    db,
    new WebTools(c.TAVILY_API_KEY, c.OPENROUTER_API_KEY, c.HERMES_MODEL),
    gmail,
    new SheetsTools(db, {
      owner: c.SHEETS_OWNER_USER_ID,
      clientId: c.GOOGLE_CLIENT_ID,
      clientSecret: c.GOOGLE_CLIENT_SECRET,
      refreshToken: c.SHEETS_REFRESH_TOKEN,
      spreadsheetId: c.SHEETS_SPREADSHEET_ID,
    }),
    daily,
  ),
  {
    web: !!(c.TAVILY_API_KEY || c.OPENROUTER_API_KEY),
    gmail: !!c.GOOGLE_REFRESH_TOKEN,
    calendar: !!c.CALENDAR_REFRESH_TOKEN,
    preparationSheet: !!(c.SHEETS_REFRESH_TOKEN && c.SHEETS_SPREADSHEET_ID),
    dailySheet: !!(c.SHEETS_REFRESH_TOKEN && c.DAILY_SPREADSHEET_ID),
  },
);
const app = server(assistant, c.INTERNAL_API_TOKEN);
const bot = telegram(c, assistant, db);
const allowed = new Set(c.TELEGRAM_ALLOWED_USER_IDS.split(","));
const worker = new DailyWorker(
  db,
  parser,
  async (user, text) => {
    if (!allowed.has(user)) throw new Error("Unauthorized delivery");
    // One bounded plain-text message, avoiding model-generated markup and partial multi-message sends.
    await bot.api.sendMessage(user, text.slice(0, 3900), {
      link_preview_options: { is_disabled: true },
    });
  },
  async (j) => {
    const lines = [
      `Daily brief — ${new Date().toLocaleDateString("en-SG", { timeZone: "Asia/Singapore" })}`,
    ];
    const tasks = (
      await db.query(
        `SELECT title,due_at FROM daily_items WHERE user_id=$1 AND kind='task' AND status='open' ORDER BY due_at NULLS LAST,created_at LIMIT 10`,
        [j.user_id],
      )
    ).rows;
    lines.push(
      "\nOpen tasks",
      ...tasks.map(
        (t) =>
          `• ${t.title}${t.due_at ? " — due " + new Date(t.due_at).toLocaleString("en-SG", { timeZone: "Asia/Singapore" }) : ""}`,
      ),
    );
    if (!tasks.length) lines.push("No open tasks.");
    if (j.include_calendar) {
      try {
        const r = await calendar.list(
          j.user_id,
          new Date().toISOString(),
          new Date(Date.now() + 86400000).toISOString(),
        );
        lines.push(
          "\nCalendar — next 24 hours",
          ...r.events
            .slice(0, 8)
            .map(
              (e: any) =>
                `• ${e.title} — ${e.start?.dateTime ?? e.start?.date}`,
            ),
        );
        if (!r.events.length) lines.push("No events.");
        if (r.truncated) lines.push("More events available in Calendar.");
      } catch {
        lines.push("\nCalendar unavailable; reconnect or enable Calendar API.");
      }
    }
    if (j.include_email) {
      try {
        const r: any = await gmail.call(
          j.user_id,
          "gmail_search",
          "in:inbox is:unread newer_than:1d",
        );
        lines.push("\nUnread inbox — past 24 hours (up to 5)");
        for (const m of r.messages.slice(0, 5)) {
          const mail: any = await gmail.call(j.user_id, "gmail_read", m.id);
          lines.push(
            "• " +
              (
                mail.headers?.find(
                  (h: any) => h.name.toLowerCase() === "subject",
                )?.value ?? "(No subject)"
              ).slice(0, 160),
          );
        }
        if (!r.messages.length) lines.push("No matching messages.");
      } catch {
        lines.push(
          "\nGmail unavailable; existing read-only authorization may need renewal.",
        );
      }
    }
    return lines.join("\n");
  },
  (user) => mirror.sync(user),
);
const workWorker = new WorkWorker(
  db,
  (user, id) => assistant.resume(user, id),
  async (user, text) => {
    if (!allowed.has(user)) throw new Error("Unauthorized delivery");
    await bot.api.sendMessage(user, text.slice(0, 3900), {
      link_preview_options: { is_disabled: true },
    });
  },
);
const workTimer = setInterval(() => {
  void workWorker
    .tick()
    .catch(() => console.error(JSON.stringify({ event: "work.tick_failed" })));
}, 15000);
workTimer.unref();
const scheduleTimer = setInterval(() => {
  void worker
    .tick()
    .catch(() =>
      console.error(JSON.stringify({ event: "schedule.tick_failed" })),
    );
}, 15000);
scheduleTimer.unref();
await app.listen({ host: "0.0.0.0", port: c.PORT });
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void (async () => {
      clearInterval(scheduleTimer);
      clearInterval(workTimer);
      if (bot.isRunning()) await bot.stop();
      await app.close();
      await db.end();
    })();
  });
await bot.start({
  allowed_updates: ["message"],
  onStart: () => console.log(JSON.stringify({ event: "gateway.started" })),
});
