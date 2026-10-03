import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BrowserManager, MissingBrowser } from "./manager.js";
const key = process.env.BROWSER_CONTROL_KEY ?? "";
if (!/^[0-9a-f]{64}$/.test(key))
  throw new Error("Browser control is not configured");
const manager = new BrowserManager(
  process.env.BROWSER_PROXY ?? "http://gathering-proxy:3002",
);
const seen = new Map<string, number>();
const app = createServer(async (req, res) => {
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
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2_100_000) throw new Error("Request too large");
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
    const input = z
      .object({
        user: z.string().min(1).max(100),
        session: z.string().uuid(),
        command: z.record(z.unknown()),
      })
      .strict()
      .parse(JSON.parse(body));
    const output = await manager.call(input.user, input.session, input.command);
    res.end(JSON.stringify(output));
  } catch (error) {
    res.writeHead(error instanceof MissingBrowser ? 404 : 400).end(
      JSON.stringify({
        error:
          error instanceof MissingBrowser
            ? "session_missing"
            : "browser_action_failed",
      }),
    );
  }
});
app.requestTimeout = 50000;
app.headersTimeout = 10000;
app.listen(3001, "0.0.0.0");
const sweep = setInterval(() => {
  void manager.expire().catch(() => {});
}, 60000);
sweep.unref();
