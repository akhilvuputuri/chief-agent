import "dotenv/config";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { quietHoursPattern } from "./coding/notices.js";
const schema = z.object({
  MCP_RUNTIME: z.enum(["on", "off"]).default("off"),
  MCP_CREDENTIALS_JSON: z.string().default("{}"),
  GATHERING_RUNTIME: z.enum(["on", "off"]).default("off"),
  GATHERING_BROWSER: z.enum(["on", "off"]).default("off"),
  GATHERING_ARTIFACT_KEY: z
    .union([z.literal(""), z.string().regex(/^[0-9a-f]{64}$/i)])
    .default(""),
  GATHERING_BROWSER_KEY: z
    .union([z.literal(""), z.string().regex(/^[0-9a-f]{64}$/i)])
    .default(""),
  // Boxed sub-agents (docs/boxes.md). Off unless the AWS stack, migration 032 and the
  // /boxes route are installed.
  BOXES_RUNTIME: z.enum(["on", "off"]).default("off"),
  BOX_AUTH_KEY: z
    .union([z.literal(""), z.string().regex(/^[0-9a-f]{64}$/)])
    .default(""),
  BOX_AWS_ACCOUNT_ID: z
    .union([z.literal(""), z.string().regex(/^\d{12}$/)])
    .default(""),
  CODING_RUNTIME: z.enum(["on", "off"]).default("off"),
  CODING_PUBLIC_ORIGIN: z.string().default(""),
  CODING_AUTH_KEY: z.string().default(""),
  CODING_GITHUB_APP_ID: z.string().default(""),
  CODING_GITHUB_INSTALLATION_ID: z.string().default(""),
  CODING_GITHUB_PRIVATE_KEY: z.string().default(""),
  // Separate minimal App for sandbox tokens; agent publication stays off until all three are set.
  CODING_AGENT_GITHUB_APP_ID: z.string().default(""),
  CODING_AGENT_GITHUB_INSTALLATION_ID: z.string().default(""),
  CODING_AGENT_GITHUB_PRIVATE_KEY: z.string().default(""),
  CODING_COMMIT_NAME: z.string().default(""),
  CODING_COMMIT_EMAIL: z.string().default(""),
  // Owner's quiet hours for coding progress, Asia/Singapore time (journal 115). Progress that
  // would start a new message waits until the window ends; questions, approval cards and
  // results still arrive. Empty turns it off.
  CODING_QUIET_HOURS: z
    .string()
    .regex(quietHoursPattern, "Use HH:MM-HH:MM, for example 23:00-08:00")
    .default("23:00-08:00"),
  MINIAPP_ORIGIN: z
    .union([
      z.literal(""),
      z
        .string()
        .url()
        .refine((v) => {
          const u = new URL(v);
          return (
            u.protocol === "https:" &&
            !u.username &&
            !u.password &&
            u.origin === v
          );
        }, "Use an HTTPS origin without path or credentials"),
    ])
    .default(""),
  CALENDAR_REFRESH_TOKEN: z.string().default(""),
  // Encrypts the runtime-obtained Libby identity at rest; account features are off when empty.
  LIBRARY_IDENTITY_KEY: z
    .union([z.literal(""), z.string().regex(/^[0-9a-f]{64}$/i)])
    .default(""),
  LIBRARY_HOLD_EMAIL: z.union([z.literal(""), z.string().email()]).default(""),
  DAILY_SPREADSHEET_ID: z.string().default(""),
  OPENROUTER_API_KEY: z.string().default(""),
  AGENT_MODEL: z.string().default("openai/gpt-5.6-sol"),
  // Jev picks the tool domains per message; "off" uses the deterministic cues; "all" offers
  // every available domain on every call, so the cached tool list never changes (journal 107).
  TOOL_PICKER: z.enum(["jev", "off", "all"]).default("all"),
  // Email memory MVP (docs/mail-recall.md): an in-memory meaning index over the primary
  // mailbox's last 12 months of Primary mail, offered to the email agent as gmail_recall.
  MAIL_INDEX: z.enum(["on", "off"]).default("on"),
  /** The nightly learner (docs/learning.md); "off" in config/runtime.json stops it. */
  LEARNING: z.enum(["on", "off"]).default("on"),
  // Shadow decisions (#127): Jev predicts beside each turn without changing it. Separate
  // from TOOL_PICKER so the picker can be turned off while measurement continues.
  SHADOW_DECISIONS: z.enum(["jev", "off"]).default("jev"),
  // Reasoning effort per foreground message (journal 90): Jev picks low, medium or high
  // and can raise it mid-turn; "off" keeps every turn at AGENT_REASONING_EFFORT.
  EFFORT_PICKER: z.enum(["jev", "off"]).default("jev"),
  // Topics in the bot's private chat, when threaded mode is on in BotFather. "auto" files
  // scheduled output into topics and sends a message typed in a topic to its agent first;
  // "file" only files output and answers in the topic; "off" uses General only.
  TELEGRAM_TOPICS: z.enum(["auto", "file", "off"]).default("auto"),
  RESPONSIBILITIES: z.enum(["on", "off"]).default("off"),
  // Read-only IBKR holdings (issue #146). Needs migration 026, IBKR_TOKEN_KEY and
  // MINIAPP_ORIGIN (the OAuth redirect is served on that origin).
  IBKR_PORTFOLIO: z.enum(["on", "off"]).default("off"),
  // IBKR order drafts and wider read-only IBKR queries (docs/ibkr-portfolio.md#order-drafts).
  // Drafts are instructions the owner reviews and submits in an IBKR app; Chief cannot
  // submit them. Needs IBKR_PORTFOLIO=on and an owner reconnect that approves mcp.write.
  // Owner-enabled on 20 October 2026; it has no effect while IBKR_PORTFOLIO is off.
  IBKR_ORDER_DRAFTS: z.enum(["on", "off"]).default("on"),
  // Owner-set ceiling on one draft's value in USD (quantity x limit price or current ask).
  IBKR_DRAFT_MAX_USD: z.coerce.number().positive().finite().default(100),
  // Encrypts runtime-obtained IBKR tokens at rest.
  IBKR_TOKEN_KEY: z
    .union([z.literal(""), z.string().regex(/^[0-9a-f]{64}$/i)])
    .default(""),
  AGENT_REASONING_EFFORT: z.literal("medium").default("medium"),
  AGENT_BUDGET_MS: z.coerce.number().int().positive().default(900000),
  AGENT_BUDGET_MODEL_CALLS: z.coerce.number().int().positive().default(40),
  AGENT_BUDGET_TOOL_CALLS: z.coerce.number().int().positive().default(100),
  OPENROUTER_MAX_INPUT_PRICE: z.coerce.number().positive().finite().default(2),
  OPENROUTER_MAX_OUTPUT_PRICE: z.coerce
    .number()
    .positive()
    .finite()
    .default(10),
  SEARCH_MODEL: z.string().default("google/gemini-3.8-flash"),
  MEDIA_MODEL: z.string().default(""),
  SHEETS_OWNER_USER_ID: z.string().regex(/^\d*$/).default(""),
  SHEETS_REFRESH_TOKEN: z.string().default(""),
  SHEETS_SPREADSHEET_ID: z.string().default(""),
  GMAIL_OWNER_USER_ID: z.string().regex(/^\d*$/).default(""),
  GMAIL_SECONDARY_EMAIL: z
    .union([z.literal(""), z.string().email().max(254)])
    .default(""),
  GMAIL_SECONDARY_REFRESH_TOKEN: z.string().default(""),
  GMAIL_EMAIL: z.string().default(""),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_REFRESH_TOKEN: z.string().default(""),
  DATABASE_URL: z.string().url(),
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  TELEGRAM_ALLOWED_USER_IDS: z.string().regex(/^\d+(,\d+)*$/),

  PORT: z.coerce.number().int().default(3000),
  STT_PROVIDER: z.enum(["openai", "elevenlabs", "groq"]).default("openai"),
  TTS_PROVIDER: z.enum(["openai", "elevenlabs"]).default("openai"),
  ELEVENLABS_API_KEY: z.string().default(""),
  ELEVENLABS_VOICE_ID: z
    .string()
    .regex(/^[a-zA-Z0-9_-]*$/)
    .default(""),
  ELEVENLABS_STT_MODEL: z.string().default("scribe_v2"),
  ELEVENLABS_TTS_MODEL: z.string().default("eleven_flash_v2_5"),
  GROQ_API_KEY: z.string().default(""),
  GROQ_STT_MODEL: z.string().default("whisper-large-v3-turbo"),
  OPENAI_API_KEY: z.string().default(""),
  TAVILY_API_KEY: z.string().default(""),
  // Optional stock watchlist monitor; empty disables it entirely.
  MARKET_DATA_PROVIDER: z.enum(["", "twelvedata"]).default(""),
  // prepost quotes are a Pro+ feature; only set with a plan that includes them.
  MARKET_DATA_EXTENDED: z.enum(["", "true"]).default(""),
  TWELVE_DATA_API_KEY: z.string().default(""),
  // Singapore open data (docs/singapore-open-data.md). data.gov.sg works without a key at
  // low rate limits; LTA DataMall tools are offered only with its account key.
  DATAGOVSG_API_KEY: z.string().default(""),
  LTA_DATAMALL_ACCOUNT_KEY: z.string().default(""),
  STT_MODEL: z.string().default("whisper-1"),
  TTS_MODEL: z.string().default("tts-1"),
  TTS_VOICE: z.string().default("alloy"),
  VOICE_REPLIES: z.enum(["true", "false"]).default("false"),
});
/**
 * Behaviour settings that live in reviewed repo config (config/runtime.json, issue #143).
 * Only these names are accepted there, so a secret or a personal identifier can never be
 * committed through it; those stay in the private environment.
 */
export const RUNTIME_SETTINGS = [
  "AGENT_MODEL",
  "AGENT_REASONING_EFFORT",
  "AGENT_BUDGET_MS",
  "AGENT_BUDGET_MODEL_CALLS",
  "AGENT_BUDGET_TOOL_CALLS",
  "OPENROUTER_MAX_INPUT_PRICE",
  "OPENROUTER_MAX_OUTPUT_PRICE",
  "SEARCH_MODEL",
  "MEDIA_MODEL",
  "TOOL_PICKER",
  "MAIL_INDEX",
  "LEARNING",
  "SHADOW_DECISIONS",
  "EFFORT_PICKER",
  "TELEGRAM_TOPICS",
  "VOICE_REPLIES",
  "MARKET_DATA_PROVIDER",
  "MARKET_DATA_EXTENDED",
  "STT_PROVIDER",
  "TTS_PROVIDER",
  "STT_MODEL",
  "TTS_MODEL",
  "TTS_VOICE",
  "ELEVENLABS_VOICE_ID",
  "ELEVENLABS_STT_MODEL",
  "ELEVENLABS_TTS_MODEL",
  "GROQ_STT_MODEL",
  "IBKR_ORDER_DRAFTS",
  "IBKR_DRAFT_MAX_USD",
  "CODING_QUIET_HOURS",
  // PORT is deployment wiring (Compose ports, health checks), not behaviour; it stays in the environment.
] as const satisfies readonly (keyof z.infer<typeof schema>)[];
type RuntimeSetting = (typeof RUNTIME_SETTINGS)[number];

const runtimeFile = z
  .object({
    schemaVersion: z.literal(1),
    // Unknown names, including any secret or identifier, are rejected.
    settings: z.record(
      z.enum(RUNTIME_SETTINGS),
      z.union([z.string(), z.number()]),
    ),
  })
  .strict();

export function readRuntimeSettings(
  url: URL = new URL("../config/runtime.json", import.meta.url),
): Partial<Record<RuntimeSetting, string>> {
  const file = runtimeFile.parse(JSON.parse(readFileSync(url, "utf8")));
  return Object.fromEntries(
    Object.entries(file.settings)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  );
}

/**
 * Reads the configuration. Behaviour settings come from config/runtime.json; during the
 * move to repo config an environment value still wins, so production keeps its current
 * behaviour until its Compose file stops passing these names. `overridden` lists, by name
 * only, the settings whose environment value differs from the file.
 */
export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
  runtime: Partial<Record<RuntimeSetting, string>> = readRuntimeSettings(),
) {
  const merged: Record<string, string | undefined> = { ...runtime };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) merged[k] = v;
  const parsed = schema.parse(merged);
  const fromFile = schema.parse({ ...merged, ...runtime });
  const overridden = RUNTIME_SETTINGS.filter(
    (k) => env[k] !== undefined && parsed[k] !== fromFile[k],
  );
  return Object.assign(parsed, { overridden });
}
export type Config = ReturnType<typeof readConfig>;
