import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { discardBody, readBody } from "../http-body.js";
export type BrowserCommand = { kind: string; [key: string]: unknown };
export interface BrowserClient {
  call(
    user: string,
    session: string,
    command: BrowserCommand,
    signal?: AbortSignal,
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
  async call(
    user: string,
    session: string,
    command: BrowserCommand,
    signal?: AbortSignal,
  ) {
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
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(45000),
      ]),
      redirect: "error",
    });
    if (response.status === 404) {
      await discardBody(response);
      throw new BrowserSessionMissing();
    }
    if (!response.ok) {
      await discardBody(response);
      throw new Error(
        "Browser request could not be completed; inspect status before retrying",
      );
    }
    if (!response.body) throw new Error("Browser is unavailable");
    const bytes = await readBody(
      response,
      29_000_000,
      () => new Error("Browser response is too large"),
    );
    return z.record(z.unknown()).parse(JSON.parse(bytes.toString("utf8")));
  }
}
