import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { publicAddress } from "./policy.js";
export async function resolvePublic(host: string, resolve = lookup) {
  const rows = await resolve(host, { all: true, verbatim: true });
  if (!rows.length || rows.some((r) => !publicAddress(r.address)))
    throw new Error("Destination is not public");
  return rows[0]!;
}
export function publicProxy() {
  let active = 0;
  const app = createServer((req, res) => {
    res.writeHead(req.url === "/healthz" ? 200 : 403, {
      "content-type": "text/plain",
    });
    res.end(req.url === "/healthz" ? "ok" : "HTTPS only");
  });
  app.on("connect", async (req, client, head) => {
    let upstream: ReturnType<typeof connect> | undefined,
      claimed = false;
    const reject = () => {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      upstream?.destroy();
    };
    try {
      const u = new URL("https://" + req.url);
      if (
        (u.port && u.port !== "443") ||
        u.username ||
        u.password ||
        u.pathname !== "/" ||
        u.search ||
        !u.hostname.includes(".") ||
        /\[|:|^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) ||
        /(^|\.)(localhost|local|internal|invalid|test)$/.test(u.hostname) ||
        active >= 80
      )
        throw new Error("Destination refused");
      const pinned = await resolvePublic(u.hostname);
      if (client.destroyed) return;
      ++active;
      claimed = true;
      upstream = connect({
        host: pinned.address,
        port: 443,
        family: pinned.family,
      });
      const timeout = setTimeout(() => {
        client.destroy();
        upstream?.destroy();
      }, 90000);
      timeout.unref();
      let transferred = 0;
      const count = (data: Buffer) => {
        transferred += data.length;
        if (transferred > 64 * 1024 * 1024) {
          client.destroy();
          upstream?.destroy();
        }
      };
      upstream.on("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream!.write(head);
        client.pipe(upstream!);
        upstream!.pipe(client);
      });
      upstream.on("data", count);
      client.on("data", count);
      upstream.on("error", reject);
      client.on("error", () => upstream?.destroy());
      client.on("close", () => {
        clearTimeout(timeout);
        upstream?.destroy();
        if (claimed) {
          claimed = false;
          --active;
        }
      });
      upstream.on("close", () => client.destroy());
    } catch {
      reject();
      if (claimed) {
        claimed = false;
        --active;
      }
    }
  });
  return app;
}
if (process.argv[1]?.endsWith("/browser/proxy.js")) {
  publicProxy().listen(3002, "0.0.0.0");
}
