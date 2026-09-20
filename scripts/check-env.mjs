import { readFile } from "node:fs/promises";
import { parse } from "dotenv";
const env = parse(await readFile(new URL("../.env", import.meta.url), "utf8"));
const required = [
  "POSTGRES_PASSWORD",
  "DATABASE_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_IDS",
  "AGENT_MODEL",
  "OPENROUTER_API_KEY",
];
const missing = required.filter((key) => !env[key]?.trim());
if (missing.length) {
  console.log(`Still needed: ${missing.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(
    "Required settings are present. This checks presence only; live authentication still needs testing.",
  );
}
for (const key of [
  "OPENAI_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "GROQ_API_KEY",
  "TAVILY_API_KEY",
  "LIBRARY_IDENTITY_KEY",
  "LIBRARY_HOLD_EMAIL",
  "MARKET_DATA_PROVIDER",
  "TWELVE_DATA_API_KEY",
]) {
  console.log(`${key}: ${env[key]?.trim() ? "configured" : "not configured"}`);
}
