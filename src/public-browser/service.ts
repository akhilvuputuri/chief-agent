import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import { publicBrowserCommand } from "./commands.js";
import {
  PublicBrowserBusy,
  PublicBrowserCleanupFailure,
  PublicBrowserEngine,
} from "./engine.js";

// Same signed request as src/browser/service.ts, whose invoice service is deliberately unchanged.
const key = process.env.BROWSER_CONTROL_KEY ?? "";
if (!/^[0-9a-f]{64}$/.test(key))
  throw new Error("Browser control is not configured");
const proxy = process.env.BROWSER_PROXY ?? "http://public-browser-proxy:3002";
// Cleared so nothing started from here can inherit it, whatever its environment option says.
delete process.env.BROWSER_CONTROL_KEY;
const engine = new PublicBrowserEngine(proxy);
const seen = new Map<string, number>();
const exitOnCleanupFailure = (error: unknown) => {
  // Fail closed when a session cannot be proven gone; the restart policy gives a clean process.
  if (error instanceof PublicBrowserCleanupFailure)
    setImmediate(() => process.exit(1));
};
const app = createServer(async (req, res) => {
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  res.once("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(45000),
  ]);
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  if (req.url === "/healthz" && req.method === "GET") {
    res.end('{"ready":true}');
    return;
  }
  if (req.url !== "/rpc" || req.method !== "POST") {
    res.writeHead(404).end('{"error":"unavailable"}');
    return;
  }
  let authorized = false;
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64_000) throw new Error("Request too large");
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8"),
      time = String(req.headers["x-browser-time"] ?? ""),
      nonce = String(req.headers["x-browser-nonce"] ?? ""),
      signature = String(req.headers["x-browser-signature"] ?? "");
    if (
      !/^\d{13}$/.test(time) ||
      Math.abs(Date.now() - Number(time)) > 30000 ||
      !/^[0-9a-f-]{36}$/.test(nonce) ||
      !/^[0-9a-f]{64}$/.test(signature)
    )
      throw new Error("Unauthorized");
    const expected = createHmac("sha256", key)
      .update(time + "\n" + nonce + "\n" + body)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
      throw new Error("Unauthorized");
    for (const [id, at] of seen) if (Date.now() - at > 60000) seen.delete(id);
    if (seen.has(nonce) || seen.size > 2000) throw new Error("Unauthorized");
    seen.set(nonce, Date.now());
    authorized = true;
    const input = z
      .object({
        user: z.string().min(1).max(100),
        session: z.string().uuid(),
        command: publicBrowserCommand,
      })
      .strict()
      .parse(JSON.parse(body));
    const output = await engine.call(
      input.user,
      input.session,
      input.command,
      signal,
    );
    res.end(JSON.stringify({ ok: true, result: output }));
  } catch (error) {
    if (!authorized) {
      res.writeHead(400).end('{"error":"browser_action_failed"}');
      return;
    }
    // The model decides what to try next from this: a failed navigation is ordinary.
    res.end(
      JSON.stringify({
        ok: false,
        busy: error instanceof PublicBrowserBusy,
        error:
          error instanceof z.ZodError
            ? "Invalid browser command"
            : error instanceof Error &&
                !(error instanceof PublicBrowserCleanupFailure)
              ? error.message.slice(0, 500)
              : "Browser command failed",
      }),
    );
    exitOnCleanupFailure(error);
  }
});
app.requestTimeout = 50000;
app.headersTimeout = 10000;
app.listen(3001, "0.0.0.0");
const sweep = setInterval(() => {
  void engine.sweep().catch(exitOnCleanupFailure);
}, 30000);
sweep.unref();
