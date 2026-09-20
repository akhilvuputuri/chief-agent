import { run as runTelegram } from "@grammyjs/runner";
import { CustomAgent } from "./custom-agent.js";
import { OpenRouter } from "./model.js";
import { recoverRuntime } from "./execution.js";
import { TelegramViews } from "./telegram-views.js";
import type { Delivery } from "./answer.js";
import { WorkWorker } from "./work-worker.js";
import { DailyTools, DailyWorker, ScheduleParser } from "./daily.js";
import { CalendarActions } from "./calendar-actions.js";
import { LibraryClient } from "./library-client.js";
import { MemoryPacing, PostgresPacing } from "./library-pacing.js";
import { LibraryTools } from "./library.js";
import { LibraryIdentity } from "./library-identity.js";
import { LinkCeremony } from "./library-link.js";
import { LibraryActions } from "./library-actions.js";
import { libraryMigrated, recoverLibrary } from "./library-recovery.js";
import { secretKey } from "./secret-box.js";
import { CalendarTools } from "./calendar.js";
import { DailySheet } from "./daily-sheet.js";
import { SheetsTools } from "./sheets.js";
import { GmailTools, unreadDigest } from "./gmail.js";
import { readConfig } from "./config.js";
import { connect } from "./db.js";
import { JobTools } from "./tools.js";
import { WebTools } from "./providers.js";
import { Assistant } from "./agent.js";
import { server } from "./server.js";
import {
  telegram,
  sendCalendarApprovals,
  sendLibraryApprovals,
} from "./telegram.js";
const c = readConfig();
const db = connect(c.DATABASE_URL);
await db.query("SELECT 1");
// Refuse a stale/missing migration rather than silently losing legacy conversation context.
if (
  !(await db.query("SELECT 1 FROM runtime_migrations WHERE version=14")).rows
    .length ||
  (
    await db.query(
      "SELECT 1 FROM conversations WHERE history<>'[]' UNION ALL SELECT 1 FROM runtime_runs WHERE messages<>'[]' LIMIT 1",
    )
  ).rows.length
)
  throw new Error(
    "Checkpoint steering migration 014 must be applied with the gateway stopped",
  );
await recoverRuntime(db);
// Library account features need migration 016; without the key they stay off even if tables exist.
const libraryReady = await libraryMigrated(db);
if (c.LIBRARY_IDENTITY_KEY && !libraryReady)
  throw new Error(
    "Library migration 016 must be applied with the gateway stopped before LIBRARY_IDENTITY_KEY is set",
  );
if (libraryReady) {
  const recovered = await recoverLibrary(db);
  console.error(JSON.stringify({ event: "library.recovered", ...recovered }));
  if (
    !c.LIBRARY_IDENTITY_KEY &&
    (await db.query("SELECT 1 FROM library_identities LIMIT 1")).rows.length
  )
    console.error(
      JSON.stringify({ event: "library.disabled_with_identity_present" }),
    );
}
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
const shutdown = new AbortController();
let notifyOwner: (text: string) => Promise<void> = async () => {};
const libraryClient = new LibraryClient({
  pacing:
    c.LIBRARY_IDENTITY_KEY && libraryReady
      ? new PostgresPacing(db)
      : new MemoryPacing(),
  signal: shutdown.signal,
  onBreakerOpen: async (until, reason) => {
    const when = new Date(until).toLocaleString("en-SG", {
      timeZone: "Asia/Singapore",
    });
    await notifyOwner(
      reason === "failures"
        ? `The library did not answer repeatedly. Library calls are paused until ${when}; nothing will be retried on its own.`
        : `The library asked us to slow down. Library calls are paused until ${when}; nothing will be retried on its own.`,
    );
  },
});
const libraryOwner = c.TELEGRAM_ALLOWED_USER_IDS.split(",")[0]!;
const libraryIdentity = c.LIBRARY_IDENTITY_KEY
  ? new LibraryIdentity(db, libraryClient, secretKey(c.LIBRARY_IDENTITY_KEY))
  : undefined;
let libraryActions: LibraryActions | undefined;
if (libraryIdentity) {
  const link = new LinkCeremony(
    db,
    libraryClient,
    libraryIdentity,
    {
      editMessageText: (chat, messageId, text, extra) =>
        bot.api.editMessageText(chat, messageId, text, extra),
    },
    (user, approvalId, outcome) =>
      libraryActions!.linkFinished(user, approvalId, outcome),
  );
  libraryActions = new LibraryActions(
    db,
    { identity: libraryIdentity, link, client: libraryClient },
    libraryOwner,
  );
}
const library = new LibraryTools(libraryClient, undefined, libraryIdentity);
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
    (model) =>
      new OpenRouter(
        c.OPENROUTER_API_KEY,
        model,
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
    new CalendarActions(db, calendar, c.GMAIL_OWNER_USER_ID),
    library,
    libraryActions,
  ),
  {
    canvases: !!c.MINIAPP_ORIGIN,
    web: !!(c.TAVILY_API_KEY || c.OPENROUTER_API_KEY),
    gmail: !!c.GOOGLE_REFRESH_TOKEN,
    calendar: !!c.CALENDAR_REFRESH_TOKEN,
    library: true,
    libraryAccount: !!libraryIdentity,
    preparationSheet: !!(c.SHEETS_REFRESH_TOKEN && c.SHEETS_SPREADSHEET_ID),
    dailySheet: !!(c.SHEETS_REFRESH_TOKEN && c.DAILY_SPREADSHEET_ID),
  },
  {
    ms: c.AGENT_BUDGET_MS,
    models: c.AGENT_BUDGET_MODEL_CALLS,
    tools: c.AGENT_BUDGET_TOOL_CALLS,
  },
);
const app = server(
  db,
  c.MINIAPP_ORIGIN
    ? {
        origin: c.MINIAPP_ORIGIN,
        token: c.TELEGRAM_BOT_TOKEN,
        allowed: new Set(c.TELEGRAM_ALLOWED_USER_IDS.split(",")),
      }
    : undefined,
);
const bot = telegram(c, assistant, db);
notifyOwner = async (text) => {
  for (const user of c.TELEGRAM_ALLOWED_USER_IDS.split(","))
    await bot.api.sendMessage(user, text).catch(() => {});
};
const views = new TelegramViews(db, bot.api, undefined, c.MINIAPP_ORIGIN);
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
        const lines = unreadDigest(r);
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
  if (typeof text !== "string" && text.runId)
    await assistant.recordDelivery(user, text.runId, text.reply);
  await sendCalendarApprovals(bot, db, user);
  await sendLibraryApprovals(bot, db, user);
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
      shutdown.abort();
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
