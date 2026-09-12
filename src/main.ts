import { run as runTelegram } from "@grammyjs/runner";
import { CustomAgent } from "./custom-agent.js";
import { OpenRouter } from "./model.js";
import { recoverRuntime } from "./execution.js";
import { TelegramViews } from "./telegram-views.js";
import type { Delivery } from "./answer.js";
import { WorkWorker } from "./work-worker.js";
import { DailyTools, DailyWorker, ScheduleParser } from "./daily.js";
import { CalendarActions } from "./calendar-actions.js";
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
import { telegram, sendCalendarApprovals } from "./telegram.js";
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
    // Optional task-specific vision/document model; the main model is used when unset.
    c.MEDIA_MODEL
      ? {
          media: new OpenRouter(
            c.OPENROUTER_API_KEY,
            c.MEDIA_MODEL,
            c.OPENROUTER_MAX_INPUT_PRICE,
            c.OPENROUTER_MAX_OUTPUT_PRICE,
          ),
        }
      : {},
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
    new CalendarActions(db, calendar, c.GMAIL_OWNER_USER_ID),
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
const views = new TelegramViews(db, bot.api);
const allowed = new Set(c.TELEGRAM_ALLOWED_USER_IDS.split(","));
const worker = new DailyWorker<Delivery>(
  db,
  parser,
  async (user, text) => {
    if (!allowed.has(user)) throw new Error("Unauthorized delivery");
    await views.deliver(user, user, text, "schedule");
  },
  async (j) => {
    const title = `Daily brief — ${new Date().toLocaleDateString("en-SG", { timeZone: "Asia/Singapore" })}`;
    const sections: NonNullable<Delivery["sections"]> = [];
    const tasks = (
      await db.query(
        `SELECT title,due_at FROM daily_items WHERE user_id=$1 AND kind='task' AND status='open' ORDER BY due_at NULLS LAST,created_at LIMIT 10`,
        [j.user_id],
      )
    ).rows;
    sections.push({
      title: "Open tasks (up to 10)",
      body: tasks.length
        ? tasks
            .map(
              (t) =>
                `• ${t.title}${t.due_at ? " — due " + new Date(t.due_at).toLocaleString("en-SG", { timeZone: "Asia/Singapore" }) : ""}`,
            )
            .join("\n")
        : "No open tasks.",
    });
    if (j.include_calendar) {
      try {
        const r = await calendar.list(
          j.user_id,
          new Date().toISOString(),
          new Date(Date.now() + 86400000).toISOString(),
        );
        sections.push({
          title: "Calendar — next 24 hours (up to 8)",
          body: r.events.length
            ? r.events
                .slice(0, 8)
                .map(
                  (e: any) =>
                    `• ${e.title} — ${e.start?.dateTime ?? e.start?.date}`,
                )
                .join("\n") +
              (r.truncated || r.events.length > 8
                ? "\nMore events available in Calendar."
                : "")
            : "No events.",
        });
      } catch {
        sections.push({
          title: "Calendar",
          body: "Calendar unavailable; reconnect or enable Calendar API.",
        });
      }
    }
    if (j.include_email) {
      try {
        const r: any = await gmail.call(
          j.user_id,
          "gmail_search",
          "in:inbox is:unread newer_than:1d",
        );
        const lines: string[] = [];
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
        sections.push({
          title: "Unread inbox — past 24 hours (up to 5)",
          body: lines.join("\n") || "No matching messages.",
        });
      } catch {
        sections.push({
          title: "Gmail",
          body: "Gmail unavailable; existing read-only authorization may need renewal.",
        });
      }
    }
    return {
      reply: `${title}\n\nOpen Sections to browse ${sections.map((s) => s.title).join(", ")}.`,
      sections,
    };
  },
  (user) => mirror.sync(user),
);
async function sendWorkMessage(user: string, text: string | Delivery) {
  if (!allowed.has(user)) throw new Error("Unauthorized delivery");
  await views.deliver(
    user,
    user,
    text,
    typeof text === "string" ? "progress" : "answer",
  );
  await sendCalendarApprovals(bot, db, user);
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
      return await assistant.resumeDetailed(user, id, (text, runId) =>
        views.deliver(user, user, { reply: text, runId }, "progress"),
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
  runner: {
    silent: true,
    fetch: { allowed_updates: ["message", "callback_query"] },
  },
  sink: { concurrency: 8 },
});
console.log(
  JSON.stringify({ event: "gateway.started", runtime: "personal-agent" }),
);
