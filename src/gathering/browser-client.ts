import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
export type BrowserCommand = { kind: string; [key: string]: unknown };
export interface BrowserClient {
  call(
    user: string,
    session: string,
    command: BrowserCommand,
  ): Promise<Record<string, any>>;
}
export class BrowserSessionMissing extends Error {
  constructor() {
    super("Browser session needs restoration");
  }
}
export class BrowserRpc implements BrowserClient {
  constructor(
    private endpoint: string,
    private key: string,
    private request: typeof fetch = fetch,
  ) {}
  async call(user: string, session: string, command: BrowserCommand) {
    const body = JSON.stringify({ user, session, command }),
      time = String(Date.now()),
      nonce = randomUUID();
    const signature = createHmac("sha256", this.key)
      .update(time + "\n" + nonce + "\n" + body)
      .digest("hex");
    const response = await this.request(new URL("/rpc", this.endpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-browser-time": time,
        "x-browser-nonce": nonce,
        "x-browser-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(45000),
      redirect: "error",
    });
    if (response.status === 404) throw new BrowserSessionMissing();
    if (!response.ok)
      throw new Error(
        "Browser request could not be completed; inspect status before retrying",
      );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Browser is unavailable");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 29_000_000) throw new Error("Browser response is too large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return z
      .record(z.unknown())
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }
}
