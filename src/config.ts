import "dotenv/config";
import { z } from "zod";
const schema = z.object({
  GMAIL_OWNER_USER_ID: z.string().regex(/^\d*$/).default(""),
  GMAIL_EMAIL: z.string().default(""),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_REFRESH_TOKEN: z.string().default(""),
  DATABASE_URL: z.string().url(),
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  TELEGRAM_ALLOWED_USER_IDS: z.string().regex(/^\d+(,\d+)*$/),
  INTERNAL_API_TOKEN: z.string().min(32),
  HERMES_URL: z.string().url().default("http://localhost:8000"),
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
  STT_MODEL: z.string().default("whisper-1"),
  TTS_MODEL: z.string().default("tts-1"),
  TTS_VOICE: z.string().default("alloy"),
  VOICE_REPLIES: z.enum(["true", "false"]).default("false"),
});
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  return schema.parse(env);
}
export type Config = ReturnType<typeof readConfig>;
