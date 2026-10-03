import { Gathering } from "./gathering/controller.js";
import { FileVault } from "./gathering/vault.js";
import { GatheringBrowsers } from "./gathering/sessions.js";
import { BrowserRpc } from "./gathering/browser-client.js";
import { formatTelegram } from "./telegram-format.js";
import { recordFeedSent } from "./telegram-feeds.js";
import { readFileSync } from "node:fs";
import { CodeBuildClient } from "@aws-sdk/client-codebuild";
import { CodingController } from "./coding/controller.js";
import { CodeBuildSandbox } from "./coding/provider.js";
import { GitHubPublisher } from "./coding/github.js";
import { codingSettings } from "./coding/schema.js";
import { codingApi } from "./coding/api.js";
import { destination, taskDelivery } from "./delivery-routing.js";
import "./process-guard.js";
import { errorFields, opsLog } from "./ops-log.js";
import { RoutineScheduler, RoutineDelivery } from "./routines.js";
import { Responsibilities } from "./responsibilities.js";
import {
  ResponsibilityWorker,
  ResponsibilityDelivery,
} from "./responsibility-worker.js";
import { StockMonitor, StockDelivery, WatchlistTools } from "./stocks.js";
import { TwelveDataProvider } from "./stock-provider.js";
import { NewsBulletin, NewsTools, voteKeyboard } from "./news.js";
import { PublicFeedFetcher } from "./news-feed.js";
import { run as runTelegram } from "@grammyjs/runner";
import { CustomAgent } from "./custom-agent.js";
import { OpenRouter } from "./model.js";
import { resolveMainModel } from "./model-policy.js";
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
import { connect, ensureUser, event } from "./db.js";
import { JobTools } from "./tools.js";
import { WebTools } from "./providers.js";
import { Assistant } from "./agent.js";
import { ToolPicker } from "./tool-picker.js";
import { ShadowDecisions } from "./shadow.js";
import { server } from "./server.js";
import {
  telegram,
  sendCalendarApprovals,
  sendLibraryApprovals,
  sendResponsibilityApprovals,
} from "./telegram.js";
// Startup refusals carry a fixed code so the sanitized crash line identifies them.
const startupError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });
const c = readConfig();
const mainModel = resolveMainModel(c.AGENT_MODEL);
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
  throw startupError(
    "STARTUP_MIGRATION_014",
    "Checkpoint steering migration 014 must be applied with the gateway stopped",
  );
if (
  !(await db.query("SELECT 1 FROM runtime_migrations WHERE version=17")).rows
    .length
)
  throw startupError(
    "STARTUP_MIGRATION_017",
    "Scheduled routines migration 017 must be applied with the gateway stopped",
  );
if (
  !(await db.query("SELECT 1 FROM runtime_migrations WHERE version=18")).rows
    .length
)
  throw startupError(
    "STARTUP_MIGRATION_018",
    "Stock watchlist migration 018 must be applied with the gateway stopped",
  );
if (
  !(await db.query("SELECT 1 FROM runtime_migrations WHERE version=20")).rows
    .length
)
  throw startupError(
    "STARTUP_MIGRATION_020",
    "Stock monitoring-window migration 020 must be applied with the gateway stopped",
  );
if (
  !(await db.query("SELECT 1 FROM runtime_migrations WHERE version=21")).rows
    .length
)
  throw startupError(
    "STARTUP_MIGRATION_021",
    "News bulletin migration 021 must be applied with the gateway stopped",
  );
if (
  !(await db.query("SELECT 1 FROM runtime_migrations WHERE version=25")).rows
    .length
)
  throw startupError(
    "STARTUP_MIGRATION_025",
    "Subscriptions migration 025 must be applied with the gateway stopped",
  );
await recoverRuntime(db);
// Library account features need migration 016; without the key they stay off even if tables exist.
const libraryReady = await libraryMigrated(db);
if (c.LIBRARY_IDENTITY_KEY && !libraryReady)
  throw startupError(
    "STARTUP_MIGRATION_016",
    "Library migration 016 must be applied with the gateway stopped before LIBRARY_IDENTITY_KEY is set",
  );
if (libraryReady) {
  const recovered = await recoverLibrary(db);
  if (recovered.recovered)
    opsLog("library.recovered", "info", {
      failedCount: recovered.failed,
      uncertainCount: recovered.uncertain,
      abortedCount: recovered.aborted,
    });
  if (
    !c.LIBRARY_IDENTITY_KEY &&
    (await db.query("SELECT 1 FROM library_identities LIMIT 1")).rows.length
  )
    opsLog("library.disabled_with_identity_present", "warn");
}
const google = {
  owner: c.GMAIL_OWNER_USER_ID,
  email: c.GMAIL_EMAIL,
  clientId: c.GOOGLE_CLIENT_ID,
  clientSecret: c.GOOGLE_CLIENT_SECRET,
  refreshToken: c.GOOGLE_REFRESH_TOKEN,
};
const gmail = new GmailTools({
  ...google,
  ...(c.GMAIL_SECONDARY_EMAIL || c.GMAIL_SECONDARY_REFRESH_TOKEN
    ? {
        secondary: {
          email: c.GMAIL_SECONDARY_EMAIL,
          refreshToken: c.GMAIL_SECONDARY_REFRESH_TOKEN,
        },
      }
    : {}),
});
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
const stockProvider =
  c.MARKET_DATA_PROVIDER === "twelvedata"
    ? new TwelveDataProvider(c.TWELVE_DATA_API_KEY, {
        supportsExtended: c.MARKET_DATA_EXTENDED === "true",
      })
    : undefined;
if (c.MARKET_DATA_PROVIDER === "twelvedata" && !c.TWELVE_DATA_API_KEY)
  throw startupError(
    "STARTUP_MARKET_DATA_KEY",
    "MARKET_DATA_PROVIDER=twelvedata requires TWELVE_DATA_API_KEY",
  );
const parser = new ScheduleParser();
// Editions are plain text with link previews off; 👍/👎 buttons carry item ids.
const newsFetcher = new PublicFeedFetcher();
const newsBulletin = new NewsBulletin(
  db,
  newsFetcher,
  (user) => allowed.has(user),
  async (user, payload) => {
    await topics.deliver(
      user,
      payload.destination ?? { kind: "topic", topic: "news" },
      async (thread, notice) => {
        const sent = await bot.api.sendMessage(
          user,
          [notice, payload.text].filter(Boolean).join("\n\n"),
          {
            ...thread,
            link_preview_options: { is_disabled: true },
            ...(payload.items?.length
              ? {
                  reply_markup: {
                    inline_keyboard: voteKeyboard(payload.items),
                  },
                }
              : {}),
          },
        );
        await recordFeedSent(
          db,
          user,
          payload.editionId,
          "news",
          sent,
          thread.message_thread_id,
        );
        return sent;
      },
    );
  },
  undefined,
  (user) => topics.capture(user, { kind: "topic", topic: "news" }),
);
const daily = new DailyTools(db, parser, calendar, mirror);
if (
  c.RESPONSIBILITIES === "on" &&
  !(await db.query("SELECT 1 FROM runtime_migrations WHERE version=23")).rows
    .length
)
  throw startupError(
    "STARTUP_MIGRATION_023",
    "Responsibilities migration 023 must be installed before enabling monitoring",
  );
const responsibilities =
  c.RESPONSIBILITIES === "on"
    ? new Responsibilities(db, { gmail, calendar })
    : undefined;
let coding: CodingController | undefined;
if (c.CODING_RUNTIME === "on") {
  if (
    !(await db.query("SELECT 1 FROM runtime_migrations WHERE version=24")).rows
      .length
  )
    throw startupError(
      "STARTUP_MIGRATION_024",
      "Coding migration 024 must be installed before enabling the runtime",
    );
  if (
    !c.CODING_CODEBUILD_PROJECT ||
    !c.CODING_GITHUB_APP_ID ||
    !c.CODING_GITHUB_INSTALLATION_ID ||
    !c.CODING_GITHUB_PRIVATE_KEY ||
    !c.OPENROUTER_API_KEY
  )
    throw startupError(
      "STARTUP_CODING_CONFIG",
      "Coding provider, GitHub App and model configuration are required",
    );
  const settings = codingSettings.parse(
    JSON.parse(
      readFileSync(new URL("../config/coding.json", import.meta.url), "utf8"),
    ),
  );
  if (!settings.image)
    throw startupError(
      "STARTUP_CODING_IMAGE",
      "Coding needs a reviewed immutable worker image digest",
    );
  const provider = new CodeBuildSandbox(
    new CodeBuildClient({ region: c.CODING_AWS_REGION, maxAttempts: 1 }),
    c.CODING_CODEBUILD_PROJECT,
  );
  await provider.validate();
  const owners = new Set(c.TELEGRAM_ALLOWED_USER_IDS.split(","));
  coding = new CodingController(
    db,
    settings,
    provider,
    new GitHubPublisher(
      settings.repository,
      c.CODING_GITHUB_APP_ID,
      c.CODING_GITHUB_INSTALLATION_ID,
      c.CODING_GITHUB_PRIVATE_KEY,
      { name: c.CODING_COMMIT_NAME, email: c.CODING_COMMIT_EMAIL },
    ),
    c.CODING_AUTH_KEY,
    c.CODING_PUBLIC_ORIGIN,
    (user) => owners.has(user),
    (model) =>
      new OpenRouter(
        c.OPENROUTER_API_KEY,
        model,
        c.OPENROUTER_MAX_INPUT_PRICE,
        c.OPENROUTER_MAX_OUTPUT_PRICE,
      ),
  );
}
let gathering: Gathering | undefined;
if (c.GATHERING_RUNTIME === "on") {
  if (!c.GATHERING_ARTIFACT_KEY || !c.MINIAPP_ORIGIN)
    throw startupError(
      "STARTUP_GATHERING_CONFIG",
      "Gathering needs an artifact key and authenticated Mini App origin",
    );
  if (
    !(await db.query("SELECT 1 FROM runtime_migrations WHERE version=26")).rows
      .length
  )
    throw startupError(
      "STARTUP_MIGRATION_026",
      "Gathering migration 026 must be installed before enabling the capability",
    );
  const key = secretKey(c.GATHERING_ARTIFACT_KEY);
  if (c.GATHERING_BROWSER === "on" && !c.GATHERING_BROWSER_KEY)
    throw startupError(
      "STARTUP_BROWSER_CONFIG",
      "Browser control is not configured",
    );
  const browsers =
    c.GATHERING_BROWSER === "on"
      ? new GatheringBrowsers(
          db,
          key,
          new BrowserRpc(
            "http://gathering-browser:3001",
            c.GATHERING_BROWSER_KEY,
          ),
          c.MINIAPP_ORIGIN,
        )
      : undefined;
  gathering = new Gathering(
    db,
    new FileVault(db, key),
    c.GMAIL_OWNER_USER_ID && c.GOOGLE_REFRESH_TOKEN ? gmail : undefined,
    browsers,
    c.MINIAPP_ORIGIN,
  );
}
const assistant = new Assistant(
  db,
  new CustomAgent(
    new OpenRouter(
      c.OPENROUTER_API_KEY,
      mainModel,
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
    new WatchlistTools(db, stockProvider),
    new NewsTools(db, newsFetcher, newsBulletin),
    responsibilities,
    coding,
    gathering,
  ),
  {
    canvases: !!c.MINIAPP_ORIGIN,
    web: !!(c.TAVILY_API_KEY || c.OPENROUTER_API_KEY),
    gmail: !!c.GOOGLE_REFRESH_TOKEN,
    calendar: !!c.CALENDAR_REFRESH_TOKEN,
    subscriptions: true,
    parcels: true,
    library: true,
    libraryAccount: !!libraryIdentity,
    preparationSheet: !!(c.SHEETS_REFRESH_TOKEN && c.SHEETS_SPREADSHEET_ID),
    dailySheet: !!(c.SHEETS_REFRESH_TOKEN && c.DAILY_SPREADSHEET_ID),
    stocks: !!stockProvider,
    news: true,
    ...(responsibilities ? { responsibilities: true } : {}),
    ...(coding ? { coding: true } : {}),
    ...(gathering ? { gathering: true } : {}),
  },
  {
    ms: c.AGENT_BUDGET_MS,
    models: c.AGENT_BUDGET_MODEL_CALLS,
    tools: c.AGENT_BUDGET_TOOL_CALLS,
  },
  c.TOOL_PICKER === "jev" && c.OPENROUTER_API_KEY
    ? new ToolPicker(c.OPENROUTER_API_KEY)
    : undefined,
  // Shadow decisions (#127) record what Jev would decide; they never change a turn.
  // It sends the same kind of data as the Jev picker, so it follows the picker's switch.
  c.TOOL_PICKER === "jev" && c.OPENROUTER_API_KEY
    ? new ShadowDecisions(c.OPENROUTER_API_KEY)
    : undefined,
);
if (responsibilities)
  responsibilities.onInactive = (user, id) =>
    assistant.interruptResponsibility(user, id);
const app = server(
  db,
  c.MINIAPP_ORIGIN
    ? {
        origin: c.MINIAPP_ORIGIN,
        token: c.TELEGRAM_BOT_TOKEN,
        allowed: new Set(c.TELEGRAM_ALLOWED_USER_IDS.split(",")),
        responsibilities: !!responsibilities,
        gathering,
      }
    : undefined,
);
const bot = telegram(c, assistant, db);
if (coding) await codingApi(app, coding);
// Scheduled output goes to its own topic when threaded mode is on; otherwise to General.
const topics = bot.topics;
// Create Chief's topics up front so the owner can write in them before anything is posted.
for (const user of c.TELEGRAM_ALLOWED_USER_IDS.split(","))
  // Topic ids are recorded as the owner's events, so the owner row must exist first.
  void ensureUser(db, user)
    .then(() => topics.ensure(user))
    .catch((error) =>
      opsLog("telegram.topic_failed", "warn", errorFields(error)),
    );
notifyOwner = async (text) => {
  for (const user of c.TELEGRAM_ALLOWED_USER_IDS.split(","))
    await bot.api.sendMessage(user, text).catch(() => {});
};
const views = new TelegramViews(db, bot.api, undefined, c.MINIAPP_ORIGIN);
const allowed = new Set(c.TELEGRAM_ALLOWED_USER_IDS.split(","));
const responsibilityWorker = responsibilities
  ? new ResponsibilityWorker(responsibilities, (user) => allowed.has(user), {
      gmail,
      calendar,
    })
  : undefined;
const responsibilityDelivery = responsibilities
  ? new ResponsibilityDelivery(
      responsibilities,
      (user) => allowed.has(user),
      async (user, finding) => {
        const members = finding.members ?? [finding];
        const reply = members
          .map(
            (f: any) =>
              `${f.spec.title}\n${members.length > 1 ? f.payload.reply.slice(0, 250) + (f.payload.reply.length > 250 ? "…" : "") : f.payload.reply}${
                f.payload.evidence?.length
                  ? "\nSource: " +
                    f.payload.evidence
                      .slice(0, 2)
                      .map((e: string) =>
                        e.slice(0, members.length > 1 ? 60 : 200),
                      )
                      .join(", ")
                  : ""
              }`,
          )
          .join("\n\n");
        return topics.deliver(
          user,
          { kind: "topic", topic: "updates" },
          async (extra) =>
            bot.api.sendMessage(user, reply, {
              ...extra,
              link_preview_options: { is_disabled: true },
              reply_markup: {
                inline_keyboard: members.flatMap((f: any) => [
                  ...(c.MINIAPP_ORIGIN
                    ? [
                        [
                          {
                            text: "Details · " + f.spec.title.slice(0, 40),
                            web_app: {
                              url:
                                c.MINIAPP_ORIGIN +
                                "/miniapp/?view=responsibilities&responsibility=" +
                                f.responsibility_id,
                            },
                          },
                        ],
                      ]
                    : []),
                  [
                    { text: "Useful", callback_data: `rsp:useful:${f.id}` },
                    { text: "Later", callback_data: `rsp:later:${f.id}` },
                    { text: "Resolved", callback_data: `rsp:resolved:${f.id}` },
                    {
                      text: "Less like this",
                      callback_data: `rsp:less:${f.id}`,
                    },
                  ],
                ]),
              },
            }),
        );
      },
      undefined,
      calendar,
    )
  : undefined;
await responsibilityDelivery?.recover();
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
          undefined,
          `briefing:${j.id}:${Date.now()}`,
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
  const delivery: Delivery = typeof text === "string" ? { reply: text } : text;
  await topics.deliver(
    user,
    delivery.destination ?? { kind: "general" },
    async (extra, notice) => {
      await views.deliver(
        user,
        { id: user, thread: extra.message_thread_id },
        {
          ...delivery,
          reply: [notice, delivery.sourceLabel, delivery.reply]
            .filter(Boolean)
            .join("\n\n"),
        },
        typeof text === "string" ? "progress" : "answer",
      );
      if (delivery.runId && typeof text !== "string") {
        const sent = (
          await db.query(
            "SELECT data FROM events WHERE user_id=$1 AND run_id=$2 AND type IN ('telegram.message_sent','telegram.view_opened') ORDER BY id DESC LIMIT 1",
            [user, delivery.runId],
          )
        ).rows[0];
        if (sent)
          await recordFeedSent(
            db,
            user,
            delivery.runId,
            "updates",
            { message_id: sent.data.messageId },
            extra.message_thread_id,
          );
      }
      if (delivery.runId)
        await event(db, user, delivery.runId, "telegram.delivery_routed", {
          threadId: extra.message_thread_id ?? null,
          intendedThreadId:
            delivery.destination?.kind === "thread"
              ? delivery.destination.threadId
              : null,
          stopReason: delivery.reason,
          kind: "work",
        });
      await sendCalendarApprovals(
        bot,
        db,
        user,
        undefined,
        extra.message_thread_id,
        delivery.runId,
      );
      await sendLibraryApprovals(
        bot,
        db,
        user,
        undefined,
        extra.message_thread_id,
        delivery.runId,
      );
    },
  );
  if (delivery.runId)
    await assistant.recordDelivery(user, delivery.runId, delivery.reply);
}
const routineScheduler = new RoutineScheduler(db, (user) => allowed.has(user));
const routineDelivery = new RoutineDelivery(
  db,
  sendWorkMessage,
  async (user, payload) => ({
    ...payload,
    destination: await topics.capture(
      user,
      payload.destination ?? { kind: "general" },
    ),
  }),
);
await routineDelivery.recover();
const stockMonitor = stockProvider
  ? new StockMonitor(
      db,
      stockProvider,
      (user) => allowed.has(user),
      undefined,
      (user) => topics.capture(user, { kind: "topic", topic: "markets" }),
    )
  : undefined;
const stockDelivery = new StockDelivery(db, async (user, payload) => {
  if (!allowed.has(user)) throw new Error("Unauthorized delivery");
  const extra = {
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: `Pause ${payload.symbol} alerts`,
            callback_data: `stk:item:${payload.itemId}`,
          },
        ],
        [
          {
            text: "Pause all stock alerts",
            callback_data: `stk:all:${payload.alertId}`,
          },
        ],
      ],
    },
  };
  await topics.deliver(
    user,
    payload.destination ?? { kind: "topic", topic: "markets" },
    async (thread, notice) => {
      const sent = await bot.api.sendMessage(
        user,
        [notice, payload.reply].filter(Boolean).join("\n\n"),
        { ...thread, ...extra },
      );
      await recordFeedSent(
        db,
        user,
        payload.alertId,
        "markets",
        sent,
        thread.message_thread_id,
      );
      return sent;
    },
  );
});
await stockDelivery.recover();
await newsBulletin.recover();
await coding?.recoverDelivery();
const routineTimer = setInterval(() => {
  void coding
    ?.tick()
    .catch((error) =>
      opsLog("coding.tick_failed", "error", errorFields(error)),
    );
  void coding
    ?.deliver(async (user, threadId, text, approvalId) => {
      const parts = formatTelegram(text);
      let last;
      for (const [index, part] of parts.entries()) {
        last = await topics.deliver(
          user,
          {
            kind: threadId ? "thread" : "general",
            ...(threadId ? { threadId } : {}),
          } as import("./delivery-routing.js").Destination,
          (extra) =>
            bot.api.sendMessage(user, part.text, {
              ...extra,
              entities: part.entities,
              link_preview_options: { is_disabled: true },
              ...(approvalId && index === parts.length - 1
                ? {
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {
                            text: "Approve requirements",
                            callback_data: `cod:yes:${approvalId}`,
                          },
                          {
                            text: "Request changes",
                            callback_data: `cod:no:${approvalId}`,
                          },
                        ],
                      ],
                    },
                  }
                : {}),
            }),
        );
      }
      return last;
    })
    .catch((error) =>
      opsLog("coding.delivery_failed", "error", errorFields(error)),
    );
  void responsibilityWorker
    ?.tick()
    .catch((error) =>
      opsLog("responsibility.tick_failed", "error", errorFields(error)),
    );
  void responsibilityDelivery
    ?.tick()
    .catch((error) =>
      opsLog("responsibility.delivery_failed", "error", errorFields(error)),
    );
  void routineScheduler
    .tick()
    .catch((error) =>
      opsLog("routine.tick_failed", "error", errorFields(error)),
    );
  void routineDelivery
    .tick()
    .catch((error) =>
      opsLog("routine.delivery_failed", "error", errorFields(error)),
    );
  void stockMonitor
    ?.tick()
    .catch((error) => opsLog("stock.tick_failed", "error", errorFields(error)));
  void stockDelivery
    .tick()
    .catch((error) =>
      opsLog("stock.delivery_failed", "error", errorFields(error)),
    );
  void newsBulletin
    .tick()
    .catch((error) => opsLog("news.tick_failed", "error", errorFields(error)));
}, 15000);
routineTimer.unref();
const workWorker = new WorkWorker(
  db,
  async (user, id) => {
    if (!allowed.has(user)) throw new Error("Unauthorized delivery");
    if (responsibilities && (await responsibilities.scope(user, id)))
      return assistant.resumeDetailed(user, id);
    const typing = () => {
      void bot.api.sendChatAction(user, "typing").catch(() => {});
    };
    typing();
    const timer = setInterval(typing, 4500);
    timer.unref();
    try {
      return await assistant.resumeDetailed(user, id, (text, runId) =>
        (async () => {
          const routed = await taskDelivery(db, user, id, {
            reply: text,
            runId,
            reason: "answer",
          });
          await topics.deliver(user, routed.destination!, async (extra) =>
            views.deliver(
              user,
              { id: user, thread: extra.message_thread_id },
              routed,
              "progress",
            ),
          );
        })(),
      );
    } finally {
      clearInterval(timer);
    }
  },
  sendWorkMessage,
  async (user, task, delivery) =>
    (await responsibilityWorker?.capture(user, task, delivery)) ||
    routineDelivery.capture(user, task, delivery),
  !responsibilities,
);
const workTimer = setInterval(() => {
  void workWorker
    .tick()
    .catch((error) => opsLog("work.tick_failed", "error", errorFields(error)));
}, 15000);
workTimer.unref();
const gatheringTimer = gathering?.browsers
  ? setInterval(() => {
      void gathering?.browsers
        ?.sweep()
        .catch(() => opsLog("gathering.cleanup_failed", "error"));
    }, 10000)
  : undefined;
gatheringTimer?.unref();
const scheduleTimer = setInterval(() => {
  void worker
    .tick()
    .catch((error) =>
      opsLog("schedule.tick_failed", "error", errorFields(error)),
    );
}, 15000);
scheduleTimer.unref();
await app.listen({ host: "0.0.0.0", port: c.PORT });
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    opsLog("gateway.stopping", "info");
    void (async () => {
      clearInterval(scheduleTimer);
      clearInterval(gatheringTimer);
      clearInterval(workTimer);
      clearInterval(routineTimer);
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
const started = Date.now();
opsLog("gateway.started", "info");
// Which repo-config settings this environment still overrides (names only, issue #143).
opsLog("config.loaded", "info", {
  envSettings: c.overridden,
});
// Low-rate liveness record: its absence in CloudWatch means the gateway or the
// log path stopped, not that nothing happened.
setInterval(
  () =>
    opsLog("gateway.heartbeat", "info", {
      uptimeS: Math.round((Date.now() - started) / 1000),
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
    }),
  300000,
).unref();
