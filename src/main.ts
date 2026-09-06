import { run as runTelegram } from "@grammyjs/runner";
import { CustomAgent } from "./custom-agent.js";
import { OpenRouter } from "./model.js";
import { recoverRuntime } from "./execution.js";
import { formatTelegram } from "./telegram-format.js";
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
import { Assistant } from "./agent.js";
import { server } from "./server.js";
import { telegram } from "./telegram.js";
const c = readConfig();
const db = connect(c.DATABASE_URL);
await db.query("SELECT 1");
await recoverRuntime(db);
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
const parser = new ScheduleParser();
const daily = new DailyTools(db, parser, calendar, mirror);
const assistant = new Assistant(
  db,
  new CustomAgent(
    new OpenRouter(
      c.OPENROUTER_API_KEY,
      c.AGENT_MODEL,
      c.OPENROUTER_MAX_INPUT_PRICE,
      c.OPENROUTER_MAX_OUTPUT_PRICE,
    ),
  ),
  new JobTools(
    db,
    new WebTools(c.TAVILY_API_KEY, c.OPENROUTER_API_KEY, c.SEARCH_MODEL),
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
  {
    ms: c.AGENT_BUDGET_MS,
    models: c.AGENT_BUDGET_MODEL_CALLS,
    tools: c.AGENT_BUDGET_TOOL_CALLS,
  },
);
const app = server();
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
async function sendWorkMessage(user: string, text: string) {
  if (!allowed.has(user)) throw new Error("Unauthorized delivery");
  for (const part of formatTelegram(text))
    await bot.api.sendMessage(user, part.text, {
      entities: part.entities,
      link_preview_options: { is_disabled: true },
    });
}
const workWorker = new WorkWorker(
  db,
  async (user, id) => {
    if (!allowed.has(user)) throw new Error("Unauthorized delivery");
    const typing = () => {
      void bot.api.sendChatAction(user, "typing").catch(() => {});
    };
    typing();
    const timer = setInterval(typing, 4500);
    timer.unref();
    try {
      return await assistant.resume(user, id, (text) =>
        sendWorkMessage(user, text),
      );
    } finally {
      clearInterval(timer);
    }
  },
  sendWorkMessage,
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
      assistant.shutdown();
      await runner.stop();
      await app.close();
      await db.end();
    })();
  });
await bot.init();
const runner = runTelegram(bot, {
  runner: { silent: true, fetch: { allowed_updates: ["message"] } },
  sink: { concurrency: 8 },
});
console.log(
  JSON.stringify({ event: "gateway.started", runtime: "personal-agent" }),
);
