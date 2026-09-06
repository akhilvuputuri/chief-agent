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
export class Voice {
  constructor(private c: Config) {}
  async transcribe(bytes: Uint8Array) {
    if (!this.c.OPENAI_API_KEY)
      throw new Error("Voice provider is not configured");
    const form = new FormData();
    form.set("model", this.c.STT_MODEL);
    form.set(
      "file",
      new Blob([new Uint8Array(bytes)], { type: "audio/ogg" }),
      "voice.ogg",
    );
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.c.OPENAI_API_KEY}` },
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
  async speak(text: string) {
    if (!this.c.OPENAI_API_KEY)
      throw new Error("Voice provider is not configured");
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.c.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.c.TTS_MODEL,
        voice: this.c.TTS_VOICE,
        input: text.slice(0, 4000),
        response_format: "opus",
      }),
      signal: AbortSignal.timeout(60000),
    });
    return boundedBytes(res, 10 * 1024 * 1024);
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
