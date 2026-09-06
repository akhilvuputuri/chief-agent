import type { Config } from "./config.js";
import { publicHttps } from "./security.js";
export async function boundedBytes(
  response: Response,
  max: number,
): Promise<Uint8Array> {
  if (!response.ok) throw new Error("Provider request failed");
  if (Number(response.headers.get("content-length")) > max)
    throw new Error("Response too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Error("Response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
export interface SpeechToText {
  transcribe(bytes: Uint8Array): Promise<string>;
}
export type SpeechAudio = {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
};
export interface TextToSpeech {
  speak(text: string): Promise<SpeechAudio>;
}
export class Voice implements SpeechToText, TextToSpeech {
  constructor(private c: Config) {}
  get transcriptionReady() {
    return Boolean(
      this.c.STT_PROVIDER === "elevenlabs"
        ? this.c.ELEVENLABS_API_KEY
        : this.c.STT_PROVIDER === "groq"
          ? this.c.GROQ_API_KEY
          : this.c.OPENAI_API_KEY,
    );
  }
  get synthesisReady() {
    return Boolean(
      this.c.TTS_PROVIDER === "elevenlabs"
        ? this.c.ELEVENLABS_API_KEY && this.c.ELEVENLABS_VOICE_ID
        : this.c.OPENAI_API_KEY,
    );
  }
  async transcribe(bytes: Uint8Array) {
    if (!this.transcriptionReady)
      throw new Error("Voice provider is not configured");
    if (!bytes.length || bytes.length > 10 * 1024 * 1024)
      throw new Error("Invalid audio size");
    const eleven = this.c.STT_PROVIDER === "elevenlabs";
    const groq = this.c.STT_PROVIDER === "groq";
    const form = new FormData();
    form.set(
      eleven ? "model_id" : "model",
      eleven
        ? this.c.ELEVENLABS_STT_MODEL
        : groq
          ? this.c.GROQ_STT_MODEL
          : this.c.STT_MODEL,
    );
    form.set(
      "file",
      new Blob([new Uint8Array(bytes)], { type: "audio/ogg" }),
      "voice.ogg",
    );
    if (eleven) {
      form.set("tag_audio_events", "false");
      form.set("timestamps_granularity", "none");
    }
    const headers: Record<string, string> = eleven
      ? { "xi-api-key": this.c.ELEVENLABS_API_KEY }
      : {
          Authorization: `Bearer ${groq ? this.c.GROQ_API_KEY : this.c.OPENAI_API_KEY}`,
        };
    const endpoint = eleven
      ? "https://api.elevenlabs.io/v1/speech-to-text"
      : groq
        ? "https://api.groq.com/openai/v1/audio/transcriptions"
        : "https://api.openai.com/v1/audio/transcriptions";
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    const data = JSON.parse(
      new TextDecoder().decode(await boundedBytes(res, 100000)),
    );
    if (
      typeof data.text !== "string" ||
      !data.text.trim() ||
      data.text.length > 20000
    )
      throw new Error("Invalid transcript");
    return data.text as string;
  }
  async speak(text: string): Promise<SpeechAudio> {
    if (!this.synthesisReady)
      throw new Error("Voice provider is not configured");
    if (!text.trim()) throw new Error("Empty speech");
    const eleven = this.c.TTS_PROVIDER === "elevenlabs";
    const endpoint = eleven
      ? `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.c.ELEVENLABS_VOICE_ID)}?output_format=mp3_44100_128`
      : "https://api.openai.com/v1/audio/speech";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(eleven
        ? { "xi-api-key": this.c.ELEVENLABS_API_KEY }
        : { Authorization: `Bearer ${this.c.OPENAI_API_KEY}` }),
    };
    const input = text.slice(0, 4000);
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(
        eleven
          ? { text: input, model_id: this.c.ELEVENLABS_TTS_MODEL }
          : {
              model: this.c.TTS_MODEL,
              voice: this.c.TTS_VOICE,
              input,
              response_format: "opus",
            },
      ),
      signal: AbortSignal.timeout(60000),
    });
    const bytes = await boundedBytes(res, 10 * 1024 * 1024);
    if (!bytes.length) throw new Error("Empty speech response");
    return {
      bytes,
      filename: eleven ? "reply.mp3" : "reply.ogg",
      mimeType: eleven ? "audio/mpeg" : "audio/ogg",
    };
  }
}
export class WebTools {
  constructor(private key: string) {}
  async call(operation: "web_search" | "web_read", input: string) {
    if (!this.key) throw new Error("Search provider is not configured");
    const payload =
      operation === "web_search"
        ? { query: input, max_results: 5, include_raw_content: false }
        : { urls: [publicHttps(input)] };
    const res = await fetch(
      `https://api.tavily.com/${operation === "web_search" ? "search" : "extract"}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      },
    );
    const data = JSON.parse(
      new TextDecoder().decode(await boundedBytes(res, 500000)),
    );
    return { untrusted: true, content: JSON.stringify(data).slice(0, 24000) };
  }
}
