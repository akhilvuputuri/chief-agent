import "dotenv/config";
import { z } from "zod";
const schema = z.object({
  DATABASE_URL: z.string().url(),
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  TELEGRAM_ALLOWED_USER_IDS: z.string().regex(/^\d+(,\d+)*$/),
  INTERNAL_API_TOKEN: z.string().min(32),
  HERMES_URL: z.string().url().default("http://localhost:8000"),
  PORT: z.coerce.number().int().default(3000),
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
