import { InputFile } from "grammy";
import { MediaOutbox } from "./media-outbox.js";
import { sendRunMedia } from "./telegram-media.js";
import { editCodingStatus, sendCodingDelivery } from "./coding/delivery.js";
import { parseQuietHours } from "./coding/notices.js";
import { selectCodingBackend } from "./coding/backend.js";
import { randomUUID } from "node:crypto";
import { LinkResolver, postEvidenceSchema } from "./link-resolution.js";
import { McpTools, loadMcpRegistry, parseMcpCredentials } from "./mcp.js";
import { Gathering } from "./gathering/controller.js";
import { FileVault } from "./gathering/vault.js";
import { GatheringBrowsers } from "./gathering/sessions.js";
import { BrowserRpc } from "./gathering/browser-client.js";
import { formatTelegram } from "./telegram-format.js";
import { recordFeedSent } from "./telegram-feeds.js";
import { readFileSync } from "node:fs";
import { CodingController } from "./coding/controller.js";
import type { SandboxProvider } from "./coding/provider.js";
import { GitHubPublisher } from "./coding/github.js";
import { AgentGitHubTokens } from "./coding/agent-github.js";
import { codingSettings } from "./coding/schema.js";
import { codingApi } from "./coding/api.js";
import {
  destination,
  taskDelivery,
  workDestination,
} from "./delivery-routing.js";
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
import { CreditBucket } from "./market-credits.js";
import { StockLookup } from "./stock-lookup.js";
import { SingaporeTools } from "./singapore/tools.js";
import { MarketHistory } from "./market-history.js";
import { RuleDelivery, RuleEngine } from "./stock-rules.js";
import {
  NewsBulletin,
  NewsTools,
  mcpReaderLink,
  saveKeyboard,
} from "./news.js";
import { PublicFeedFetcher } from "./news-feed.js";
import { run as runTelegram, type RunnerHandle } from "@grammyjs/runner";
import { CustomAgent } from "./custom-agent.js";
import { OpenRouter } from "./model.js";
import {
  resolveAgentModel,
  resolveMainModel,
  resolvePriceCeilings,
} from "./model-policy.js";
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
import { IbkrAuth } from "./ibkr/oauth.js";
import { IbkrMcp } from "./ibkr/mcp.js";
import { IBKR_CALLBACK_PATH, ibkrRoutes } from "./ibkr/routes.js";
import { Portfolio } from "./portfolio.js";
import { OrderDrafts } from "./ibkr/orders.js";
import { CalendarTools } from "./calendar.js";
import { DailySheet } from "./daily-sheet.js";
import { SheetsTools } from "./sheets.js";
import { GmailTools } from "./gmail.js";
import { MailIndex, OpenRouterEmbedder } from "./mail-recall.js";
import { buildBriefing } from "./daily-briefing.js";
import { readConfig } from "./config.js";
import { connect, ensureUser, event } from "./db.js";
import { JobTools } from "./tools.js";
import { WebTools } from "./providers.js";
import { Assistant } from "./agent.js";
import { ToolPicker } from "./tool-picker.js";
import { ShadowDecisions } from "./shadow.js";
import { EffortPicker } from "./effort.js";
import { closeServer, server } from "./server.js";
import { stopGateway } from "./gateway-stop.js";
import { Learner } from "./learning.js";
import { MemoryStore } from "./memory.js";
import {
  logsEndpoint,
  startTracing,
  stopTracing,
  tracesEndpoint,
} from "./otel.js";
import {
  telegram,
  sendCalendarApprovals,
  sendLibraryApprovals,
  sendPortfolioApprovals,
  sendResponsibilityApprovals,
} from "./telegram.js";
// Startup refusals carry a fixed code so the sanitized crash line identifies them.
const startupError = (code: string, message: string) =>
  Object.assign(new Error(message), { code });
const c = readConfig();
// OpenTelemetry trace export (issue #323): off unless an OTLP endpoint is set.
// A malformed endpoint disables export with a warning; telemetry never stops the gateway.
let tracesUrl: string | undefined;
let logsUrl: string | undefined;
try {
  tracesUrl = tracesEndpoint();
} catch {
  opsLog("trace.export_disabled", "warn", {
    errorCode: "OTEL_ENDPOINT_INVALID",
  });
}
// Evaluation results (implicit feedback) go to the logs endpoint; a bad one only stops those.
try {
  logsUrl = tracesUrl ? logsEndpoint() : undefined;
} catch {
  opsLog("trace.export_disabled", "warn", {
    errorCode: "OTEL_LOGS_ENDPOINT_INVALID",
  });
}
if (tracesUrl) {
  const release = process.env.RELEASE_SHA;
  startTracing({
    endpoint: tracesUrl,
    ...(logsUrl ? { logsEndpoint: logsUrl } : {}),
    ...(release && /^[0-9a-f]{40}$/.test(release)
      ? { serviceVersion: release }
      : {}),
  });
  opsLog("trace.export_enabled", "info");
}
const mainModel = resolveMainModel(c.AGENT_MODEL);
const priceCeilings = resolvePriceCeilings({
  input: c.OPENROUTER_MAX_INPUT_PRICE,
  output: c.OPENROUTER_MAX_OUTPUT_PRICE,
});
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
if (
  !(await db.query("SELECT 1 FROM runtime_migrations WHERE version=29")).rows
    .length
)
  throw startupError(
    "STARTUP_MIGRATION_029",
    "Stock rules migration 029 must be applied with the gateway stopped",
  );
if (
  !(await db.query("SELECT 1 FROM runtime_migrations WHERE version=10")).rows
    .length
)
  throw startupError(
    "STARTUP_MIGRATION_010",
    "Memory migration 010 must be applied with the gateway stopped",
  );
// Revisions take over from the memories table: import what they do not hold yet, which
// is every row on the first start and any row an older image wrote after a rollback.
const memoryImport = await new MemoryStore(db).importLegacy();
if (memoryImport.imported || memoryImport.projected)
  opsLog("memory.imported", "info", {
    importedCount: memoryImport.imported,
    projectedCount: memoryImport.projected,
  });
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
// Email memory MVP: built in the background after start, primary mailbox only.
const mailIndex =
  c.MAIL_INDEX === "on" &&
  c.GMAIL_OWNER_USER_ID &&
  c.GOOGLE_REFRESH_TOKEN &&
  c.OPENROUTER_API_KEY
    ? new MailIndex(
        gmail,
        new OpenRouterEmbedder(c.OPENROUTER_API_KEY),
        c.GMAIL_OWNER_USER_ID,
      )
    : undefined;
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
// One credit allowance shared by the monitor and on-demand lookups.
const marketCredits = stockProvider
  ? new CreditBucket(stockProvider.creditsPerMinute)
  : undefined;
// Split-adjusted history shared by lookups and rules: fetched once per stock per day.
const marketHistory = stockProvider
  ? new MarketHistory(stockProvider)
  : undefined;
const stockLookup =
  stockProvider && marketCredits
    ? new StockLookup(
        db,
        stockProvider,
        marketCredits,
        undefined,
        marketHistory,
      )
    : undefined;
if (c.MARKET_DATA_PROVIDER === "twelvedata" && !c.TWELVE_DATA_API_KEY)
  throw startupError(
    "STARTUP_MARKET_DATA_KEY",
    "MARKET_DATA_PROVIDER=twelvedata requires TWELVE_DATA_API_KEY",
  );
// Read-only Singapore open data; DataMall tools appear only with its account key.
// Pictures tools make (radar maps) wait here until the reply for their run is sent.
const media = new MediaOutbox();
const singapore = new SingaporeTools({
  dataGovKey: c.DATAGOVSG_API_KEY || undefined,
  dataMallKey: c.LTA_DATAMALL_ACCOUNT_KEY || undefined,
  media,
});
const parser = new ScheduleParser();
// Editions are plain text with link previews off; Save buttons carry item ids.
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
                    inline_keyboard: saveKeyboard(payload.items),
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
  // `mcp` is assigned below; Reader learning is off when connectors are.
  () => (mcp?.configured ? mcpReaderLink(mcp) : undefined),
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
let boxes: import("./boxes/controller.js").BoxController | undefined;
/** Each EC2 box profile's task command, for the coding sandbox's startup check. */
let boxTaskCommands: Record<string, string[] | undefined> = {};
let NoticeRetry: typeof import("./boxes/controller.js").NoticeRetry =
  Error as any;
if (c.BOXES_RUNTIME === "on") {
  // Loaded only when boxes are on, so a gateway without them pays nothing.
  const { BoxController } = await import("./boxes/controller.js");
  ({ NoticeRetry } = await import("./boxes/controller.js"));
  const { Ec2BoxProvider } = await import("./boxes/ec2-provider.js");
  const { boxOrigin, boxSettings, loadBoxesFile } =
    await import("./boxes/config.js");
  const { EC2Client } = await import("@aws-sdk/client-ec2");
  if (!c.BOX_AUTH_KEY || !c.BOX_AWS_ACCOUNT_ID || !c.CODING_PUBLIC_ORIGIN)
    throw startupError(
      "STARTUP_BOXES_CONFIG",
      "Boxes need BOX_AUTH_KEY, BOX_AWS_ACCOUNT_ID and CODING_PUBLIC_ORIGIN",
    );
  // Box and coding credentials are separate trust domains.
  if (c.BOX_AUTH_KEY === c.CODING_AUTH_KEY)
    throw startupError(
      "STARTUP_BOXES_KEY",
      "BOX_AUTH_KEY must differ from CODING_AUTH_KEY",
    );
  if (
    !(await db.query("SELECT 1 FROM runtime_migrations WHERE version=32")).rows
      .length
  )
    throw startupError(
      "STARTUP_MIGRATION_032",
      "Box migration 032 must be installed before boxes are enabled",
    );
  const file = loadBoxesFile(new URL("../config/boxes.json", import.meta.url));
  const settings = boxSettings(file, c.BOX_AWS_ACCOUNT_ID);
  boxTaskCommands = Object.fromEntries(
    Object.entries(file.ec2).map(([name, ec2]) => [name, ec2.taskCommand]),
  );
  boxes = new BoxController(
    db,
    settings.config,
    {
      ec2: new Ec2BoxProvider(
        new EC2Client({ region: file.region, maxAttempts: 1 }),
        file.environment,
        settings.ec2,
      ),
    },
    c.BOX_AUTH_KEY,
    boxOrigin(c.CODING_PUBLIC_ORIGIN),
    undefined,
    {},
    undefined,
    (user) => c.TELEGRAM_ALLOWED_USER_IDS.split(",").includes(user),
  );
  await boxes.recoverNotices();
}
let coding: CodingController | undefined;
const codingQuietHours = parseQuietHours(c.CODING_QUIET_HOURS);
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
    !c.CODING_GITHUB_APP_ID ||
    !c.CODING_GITHUB_INSTALLATION_ID ||
    !c.CODING_GITHUB_PRIVATE_KEY ||
    !c.OPENROUTER_API_KEY
  )
    throw startupError(
      "STARTUP_CODING_CONFIG",
      "Coding GitHub App and model configuration are required",
    );
  const legacySettings = codingSettings.parse(
    JSON.parse(
      readFileSync(new URL("../config/coding.json", import.meta.url), "utf8"),
    ),
  );
  const backend = JSON.parse(
    readFileSync(
      new URL("../config/coding-backend.json", import.meta.url),
      "utf8",
    ),
  );
  const settings = selectCodingBackend(
    backend,
    JSON.parse(
      readFileSync(new URL("../config/coding.json", import.meta.url), "utf8"),
    ),
    JSON.parse(
      readFileSync(
        new URL("../config/coding-pi.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  if (!settings.image)
    throw startupError(
      "STARTUP_CODING_IMAGE",
      "Coding needs a reviewed immutable worker image digest",
    );
  if (
    (settings.squad || settings.runtime === "pi" || legacySettings.squad) &&
    !(await db.query("SELECT 1 FROM runtime_migrations WHERE version=27")).rows
      .length
  )
    throw startupError(
      "STARTUP_MIGRATION_027",
      "Coding squad migration 027 must be installed before activation",
    );
  let provider: SandboxProvider;
  try {
    const { codingSandbox } = await import("./coding/box-sandbox.js");
    provider = await codingSandbox({
      db,
      settings,
      boxes,
      taskCommand: boxTaskCommands.coding,
    });
  } catch (error) {
    throw startupError("STARTUP_CODING_SANDBOX", (error as Error).message);
  }
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
      undefined,
      settings.autoMerge === true ||
        settings.prWorkflow === "owner_merge" ||
        legacySettings.autoMerge === true,
    ),
    c.CODING_AUTH_KEY,
    c.CODING_PUBLIC_ORIGIN,
    (user) => owners.has(user),
    (model) =>
      new OpenRouter(
        c.OPENROUTER_API_KEY,
        model,
        priceCeilings.input,
        priceCeilings.output,
      ),
    undefined,
    async () => {
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Coding model catalog unavailable");
      const result: any = await response.json();
      if (!Array.isArray(result.data))
        throw new Error("Invalid coding model catalog");
      return result.data
        .filter((m: any) => typeof m.id === "string" && m.id.length <= 120)
        .map((m: any) => ({
          id: m.id,
          inputPrice: Number(m.pricing?.prompt) * 1e6,
          outputPrice: Number(m.pricing?.completion) * 1e6,
          tools:
            Array.isArray(m.supported_parameters) &&
            m.supported_parameters.includes("tools") &&
            (m.supported_parameters.includes("reasoning") ||
              m.supported_parameters.includes("reasoning_effort")),
          ...(Number.isSafeInteger(m.context_length) && m.context_length > 0
            ? { contextWindow: m.context_length }
            : {}),
        }));
    },
    {
      input: priceCeilings.input,
      output: priceCeilings.output,
    },
    legacySettings.autoMerge === true,
    c.CODING_AGENT_GITHUB_APP_ID &&
      c.CODING_AGENT_GITHUB_INSTALLATION_ID &&
      c.CODING_AGENT_GITHUB_PRIVATE_KEY
      ? {
          tokens: new AgentGitHubTokens(
            settings.repository,
            c.CODING_AGENT_GITHUB_APP_ID,
            c.CODING_AGENT_GITHUB_INSTALLATION_ID,
            c.CODING_AGENT_GITHUB_PRIVATE_KEY,
          ),
          author: { name: c.CODING_COMMIT_NAME, email: c.CODING_COMMIT_EMAIL },
        }
      : undefined,
  );
}
// Read-only IBKR holdings (issue #146): off unless explicitly enabled with its migration.
let notifyUser: (user: string, text: string) => Promise<void> = async () => {};
let portfolio: Portfolio | undefined;
if (c.IBKR_PORTFOLIO === "on") {
  if (
    !(await db.query("SELECT 1 FROM runtime_migrations WHERE version=26")).rows
      .length
  )
    throw startupError(
      "STARTUP_MIGRATION_026",
      "IBKR portfolio migration 026 must be installed before enabling holdings",
    );
  if (!c.IBKR_TOKEN_KEY || !c.MINIAPP_ORIGIN)
    throw startupError(
      "STARTUP_IBKR_CONFIG",
      "IBKR_PORTFOLIO=on requires IBKR_TOKEN_KEY and MINIAPP_ORIGIN",
    );
  const owners = new Set(c.TELEGRAM_ALLOWED_USER_IDS.split(","));
  const drafts = c.IBKR_ORDER_DRAFTS === "on";
  const auth = new IbkrAuth(
    db,
    secretKey(c.IBKR_TOKEN_KEY),
    c.MINIAPP_ORIGIN + IBKR_CALLBACK_PATH,
    fetch,
    Date.now,
    drafts,
  );
  const mcp = new IbkrMcp((user, force) => auth.accessToken(user, force));
  portfolio = new Portfolio(
    db,
    auth,
    mcp,
    (user) => owners.has(user),
    (user, text) => notifyUser(user, text),
    Date.now,
    drafts ? new OrderDrafts(auth, mcp, c.IBKR_DRAFT_MAX_USD) : undefined,
  );
  await portfolio.recover();
}
let gathering: Gathering | undefined;
if (c.GATHERING_RUNTIME === "on") {
  if (!c.GATHERING_ARTIFACT_KEY || !c.MINIAPP_ORIGIN)
    throw startupError(
      "STARTUP_GATHERING_CONFIG",
      "Gathering needs an artifact key and authenticated Mini App origin",
    );
  if (
    !(await db.query("SELECT 1 FROM runtime_migrations WHERE version=28")).rows
      .length
  )
    throw startupError(
      "STARTUP_MIGRATION_028",
      "Gathering migration 028 must be installed before enabling the capability",
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
const linksMigrated = !!(
  await db.query("SELECT 1 FROM runtime_migrations WHERE version=31")
).rows.length;
const linkBrowser =
  c.GATHERING_BROWSER === "on" && c.GATHERING_BROWSER_KEY
    ? new BrowserRpc("http://gathering-browser:3001", c.GATHERING_BROWSER_KEY)
    : undefined;
const links = linksMigrated
  ? new LinkResolver(
      db,
      undefined,
      linkBrowser
        ? async (user, url, signal) => {
            const result = await linkBrowser.call(
              user,
              randomUUID(),
              { kind: "resolve_public", url },
              signal,
            );
            return postEvidenceSchema.parse(result);
          }
        : undefined,
    )
  : undefined;
let mcp: McpTools | undefined;
const mcpMigrated = !!(
  await db.query("SELECT 1 FROM runtime_migrations WHERE version=30")
).rows.length;
if (c.MCP_RUNTIME === "on" && (!mcpMigrated || !linksMigrated))
  throw startupError(
    "STARTUP_MIGRATION_030",
    "MCP migrations 030 and 031 must be installed before enabling connectors",
  );
// Keep pending-write protection active after disabling connections; disabling does not settle uncertainty.
if (mcpMigrated) {
  const credentials =
    c.MCP_RUNTIME === "on" ? parseMcpCredentials(c.MCP_CREDENTIALS_JSON) : {};
  const owners = new Set(c.TELEGRAM_ALLOWED_USER_IDS.split(","));
  if (Object.values(credentials).some((secret) => !owners.has(secret.owner)))
    throw startupError(
      "STARTUP_MCP_OWNER",
      "MCP credential owner must be an allowed Telegram user",
    );
  mcp = new McpTools(
    db,
    loadMcpRegistry(),
    credentials,
    undefined,
    undefined,
    links,
  );
}
const assistant = new Assistant(
  db,
  new CustomAgent(
    new OpenRouter(
      c.OPENROUTER_API_KEY,
      mainModel,
      priceCeilings.input,
      priceCeilings.output,
    ),
    // Optional task-specific vision/document model; the main model is used when unset.
    c.MEDIA_MODEL
      ? {
          media: new OpenRouter(
            c.OPENROUTER_API_KEY,
            c.MEDIA_MODEL,
            priceCeilings.input,
            priceCeilings.output,
          ),
        }
      : {},
    (model) =>
      new OpenRouter(
        c.OPENROUTER_API_KEY,
        model,
        priceCeilings.input,
        priceCeilings.output,
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
    new WatchlistTools(db, stockProvider, undefined, marketCredits),
    new NewsTools(db, newsFetcher, newsBulletin),
    responsibilities,
    coding,
    portfolio,
    stockLookup,
    gathering,
    mcp,
    links,
    singapore,
    mailIndex,
  ),
  {
    links: !!links,
    mcp: !!mcp?.configured,
    canvases: !!c.MINIAPP_ORIGIN,
    web: !!(c.TAVILY_API_KEY || c.OPENROUTER_API_KEY),
    gmail: !!c.GOOGLE_REFRESH_TOKEN,
    mailIndex: !!mailIndex,
    calendar: !!c.CALENDAR_REFRESH_TOKEN,
    subscriptions: true,
    parcels: true,
    library: true,
    libraryAccount: !!libraryIdentity,
    preparationSheet: !!(c.SHEETS_REFRESH_TOKEN && c.SHEETS_SPREADSHEET_ID),
    dailySheet: !!(c.SHEETS_REFRESH_TOKEN && c.DAILY_SPREADSHEET_ID),
    stocks: !!stockProvider,
    news: true,
    singapore: true,
    ltaDataMall: singapore.dataMallConfigured,
    ...(responsibilities ? { responsibilities: true } : {}),
    ...(coding ? { coding: true } : {}),
    ...(portfolio ? { portfolio: true } : {}),
    ...(portfolio?.orders ? { portfolioDrafts: true } : {}),
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
  // Its own switch, so the picker can be turned off while measurement continues.
  c.SHADOW_DECISIONS === "jev" && c.OPENROUTER_API_KEY
    ? new ShadowDecisions(c.OPENROUTER_API_KEY)
    : undefined,
  // Reasoning effort per foreground message (journal 90); off keeps medium. An unreadable
  // config disables it instead of stopping the gateway.
  c.EFFORT_PICKER === "jev" && c.OPENROUTER_API_KEY
    ? (() => {
        try {
          return new EffortPicker(c.OPENROUTER_API_KEY);
        } catch (error) {
          opsLog("effort.config_failed", "error", errorFields(error));
          return undefined;
        }
      })()
    : undefined,
  // A fixed tool list keeps the cached prompt prefix stable (journal 107).
  c.TOOL_PICKER === "all",
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
const bot = telegram(c, assistant, db, media);
if (coding) await codingApi(app, coding);
if (boxes) await (await import("./boxes/api.js")).boxApi(app, boxes);
if (portfolio) {
  notifyUser = async (user, text) => {
    await bot.api.sendMessage(user, text, {
      link_preview_options: { is_disabled: true },
    });
  };
  ibkrRoutes(app, portfolio, (user, text) => notifyUser(user, text));
}
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
        return topics.deliver(user, { kind: "general" }, async (extra) =>
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
  (j) => buildBriefing(j, { db, calendar, gmail }),
  (user) => mirror.sync(user),
);
async function sendWorkMessage(user: string, text: string | Delivery) {
  if (!allowed.has(user)) throw new Error("Unauthorized delivery");
  const delivery: Delivery = typeof text === "string" ? { reply: text } : text;
  await topics.deliver(
    user,
    workDestination(delivery),
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
      // Pictures a background run queued (radar maps) follow its reply in the same thread.
      if (delivery.runId && typeof text !== "string")
        await sendRunMedia(bot.api, db, media, user, delivery.runId, {
          message_thread_id: extra.message_thread_id,
        });
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
            {
              message_id: sent.data.messageId,
              message_thread_id: sent.data.threadId ?? undefined,
            },
            extra.message_thread_id,
          );
      }
      if (delivery.runId) {
        const receipt = (
          await db.query(
            "SELECT data FROM events WHERE user_id=$1 AND run_id=$2 AND type IN ('telegram.message_sent','telegram.view_opened') ORDER BY id DESC LIMIT 1",
            [user, delivery.runId],
          )
        ).rows[0];
        await event(db, user, delivery.runId, "telegram.delivery_routed", {
          threadId: receipt?.data?.threadId ?? extra.message_thread_id ?? null,
          intendedThreadId:
            delivery.destination?.kind === "thread"
              ? delivery.destination.threadId
              : null,
          stopReason: delivery.reason,
          kind: "work",
        });
      }
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
      await sendPortfolioApprovals(
        bot,
        db,
        portfolio,
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
      marketCredits,
      marketCredits && marketHistory
        ? new RuleEngine(
            db,
            stockProvider.name,
            marketCredits,
            marketHistory,
            (user) => topics.capture(user, { kind: "topic", topic: "markets" }),
          )
        : undefined,
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
// Rule alerts: same Markets delivery, with a pause button for the rule itself.
const ruleDelivery = new RuleDelivery(db, async (user, payload) => {
  if (!allowed.has(user)) throw new Error("Unauthorized delivery");
  await topics.deliver(
    user,
    payload.destination ?? { kind: "topic", topic: "markets" },
    async (thread, notice) => {
      const sent = await bot.api.sendMessage(
        user,
        [notice, payload.reply].filter(Boolean).join("\n\n"),
        {
          ...thread,
          link_preview_options: { is_disabled: true },
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Pause this rule",
                  callback_data: `wr:pause:${payload.ruleId}`,
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
        },
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
await ruleDelivery.recover();
await newsBulletin.recover();
await coding?.recoverDelivery();
await coding?.recoverModels();
const boxTimer = boxes
  ? setInterval(() => {
      void boxes
        .tick()
        .catch((error) =>
          opsLog("boxes.tick_failed", "error", errorFields(error)),
        );
      void boxes
        .deliverNotices(async (user, text) => {
          try {
            await bot.api.sendMessage(user, text, {
              link_preview_options: { is_disabled: true },
            });
          } catch (error) {
            // Telegram definitely refused (rate limit): safe to try again later.
            if ((error as { error_code?: number })?.error_code === 429)
              throw new NoticeRetry();
            throw error;
          }
        })
        .catch((error) =>
          opsLog("boxes.notice_failed", "error", errorFields(error)),
        );
    }, 15000)
  : undefined;
const routineTimer = setInterval(() => {
  void coding
    ?.automationTick()
    .catch((error) =>
      opsLog("coding.automation_failed", "error", errorFields(error)),
    );
  void coding
    ?.tick()
    .catch((error) =>
      opsLog("coding.tick_failed", "error", errorFields(error)),
    );
  void coding
    ?.deliver(
      async (user, target, text, approval, document) =>
        sendCodingDelivery(text, approval, document, {
          text: (part, keyboard) =>
            topics.deliver(user, target, (extra) =>
              bot.api.sendMessage(user, part.text, {
                ...extra,
                entities: part.entities,
                link_preview_options: { is_disabled: true },
                ...(keyboard ? { reply_markup: keyboard } : {}),
              }),
            ),
          document: (file, caption, keyboard) =>
            topics.deliver(user, target, (extra) =>
              bot.api.sendDocument(
                user,
                new InputFile(Buffer.from(file.content, "utf8"), file.filename),
                {
                  ...extra,
                  caption: caption.text,
                  caption_entities: caption.entities,
                  ...(keyboard ? { reply_markup: keyboard } : {}),
                },
              ),
            ),
        }),
      {
        // Progress edits one status message in place (journal 115).
        edit: (user, messageId, text) =>
          editCodingStatus(text, (part) =>
            bot.api.editMessageText(user, messageId, part.text, {
              entities: part.entities,
              link_preview_options: { is_disabled: true },
            }),
          ),
        quietHours: codingQuietHours,
      },
    )
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
  void portfolio
    ?.tick()
    .catch((error) =>
      opsLog("portfolio.tick_failed", "error", errorFields(error)),
    );
  void stockMonitor
    ?.tick()
    .catch((error) => opsLog("stock.tick_failed", "error", errorFields(error)));
  void stockDelivery
    .tick()
    .catch((error) =>
      opsLog("stock.delivery_failed", "error", errorFields(error)),
    );
  void ruleDelivery
    .tick()
    .catch((error) =>
      opsLog("stock.rule_delivery_failed", "error", errorFields(error)),
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
// The nightly learner (docs/learning.md): one bounded run per owner a night, from 03:30
// Singapore, deferred while the owner is active. LEARNING in config/runtime.json turns it off.
const learnerModel = resolveAgentModel("standard", mainModel).model;
const learner = new Learner(db, {
  model: new OpenRouter(
    c.OPENROUTER_API_KEY,
    learnerModel,
    priceCeilings.input,
    priceCeilings.output,
  ),
  modelName: learnerModel,
  enabled: c.LEARNING === "on",
});
await learner.recover();
let learning = false;
const learnerTimer = setInterval(() => {
  if (learning) return;
  learning = true;
  void (async () => {
    // One owner's failure never skips the others.
    for (const user of allowed)
      await learner
        .tick(user)
        .catch((error) =>
          opsLog("learner.tick_failed", "error", errorFields(error)),
        );
  })()
    .catch((error) =>
      opsLog("learner.tick_failed", "error", errorFields(error)),
    )
    .finally(() => {
      learning = false;
    });
}, 10 * 60_000);
learnerTimer.unref();
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
// Failures are logged by the index and retried on the next gmail_recall.
void mailIndex?.start();
// Assigned after bot.init(); a signal during startup finds no runner yet and
// must also stop it from starting against a closed pool.
let runner: RunnerHandle | undefined;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    stopping = true;
    opsLog("gateway.stopping", "info");
    void (async () => {
      clearInterval(scheduleTimer);
      clearInterval(gatheringTimer);
      clearInterval(workTimer);
      clearInterval(learnerTimer);
      clearInterval(routineTimer);
      if (boxTimer) clearInterval(boxTimer);
      shutdown.abort();
      assistant.shutdown();
      const result = await stopGateway({
        stopIntake: async () => runner?.stop(),
        handlersRunning: () => runner?.size() ?? 0,
        closeHttp: () => closeServer(app),
        closeDatabase: () => db.end(),
      });
      // Spans from turns that just finished; bounded so a down collector cannot delay exit
      // past the container's stop grace period.
      await stopTracing(300);
      if (result.complete) {
        opsLog("gateway.stopped", "info");
        // Another open handle (an MCP client, a box connection) must not hold
        // the process until SIGKILL once everything owned here has closed.
        setTimeout(() => process.exit(0), 1000).unref();
        return;
      }
      opsLog("gateway.stop_incomplete", "warn", {
        intakeStopped: result.intakeStopped,
        handlersLeft: result.handlersLeft,
        httpClosed: result.httpClosed,
        databaseClosed: result.databaseClosed,
      });
      process.exit(1);
    })();
  });
await bot.init();
// Never start polling after a stop began: the next getUpdates would confirm
// updates to Telegram that a closed pool can no longer record.
if (!stopping)
  runner = runTelegram(bot, {
    runner: {
      silent: true,
      fetch: { allowed_updates: ["message", "callback_query"] },
    },
    sink: { concurrency: 8 },
  });
const started = Date.now();
// The Node version shows which undici fixes are live (journal 126).
opsLog("gateway.started", "info", { nodeVersion: process.version });
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
