import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  httpsTransport,
  type VisaCredentials,
} from "../src/merchant-lookup.js";

/** A throwaway self-signed certificate that is its own CA, for a local mutual-TLS server. */
function pair() {
  const dir = mkdtempSync(join(tmpdir(), "visa-tls-"));
  try {
    execFileSync(
      "openssl",
      [
        ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1"],
        ...["-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")],
        ...[
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost",
        ],
      ],
      { stdio: "ignore" },
    );
    return {
      cert: readFileSync(join(dir, "c.pem"), "utf8"),
      key: readFileSync(join(dir, "k.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const server = pair();
const other = pair();
const creds = (over: Partial<VisaCredentials> = {}): VisaCredentials => ({
  environment: "sandbox",
  userId: "u",
  password: "p",
  cert: server.cert,
  key: server.key,
  ca: server.cert,
  responseGroup: "GNSTANDARD3",
  ...over,
});

async function serve(
  handler: Parameters<typeof createServer>[1],
): Promise<{ url: string; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const s: Server = createServer(
    {
      cert: server.cert,
      key: server.key,
      ca: [server.cert],
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      const peer = (req.socket as any).getPeerCertificate?.();
      seen.push(
        `${req.method} ${req.url} ${req.headers.authorization} ${peer?.subject?.CN}`,
      );
      (handler as any)(req, res);
    },
  );
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  return {
    url: `https://localhost:${(s.address() as AddressInfo).port}/x`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        s.closeAllConnections();
        s.close(() => r());
      }),
  };
}
const req = (url: string, signal = AbortSignal.timeout(5000)) => ({
  url,
  headers: { authorization: "Basic abc" },
  body: "{}",
  signal,
});

test("the transport presents the client certificate, trusts the given CA and posts the body", async () => {
  const s = await serve((_req: any, res: any) => {
    res.writeHead(200, { "retry-after": "7" });
    res.end('{"ok":true}');
  });
  try {
    const r = await httpsTransport(creds())(req(s.url));
    assert.equal(r.status, 200);
    assert.equal(r.body, '{"ok":true}');
    assert.equal(r.headers["retry-after"], "7");
    assert.deepEqual(s.seen, ["POST /x Basic abc localhost"]);
  } finally {
    await s.close();
  }
});

test("a server it does not trust, or a client certificate the server rejects, fails the connection", async () => {
  const s = await serve((_q: any, res: any) => res.end("{}"));
  try {
    await assert.rejects(httpsTransport(creds({ ca: other.cert }))(req(s.url)));
    await assert.rejects(
      httpsTransport(creds({ cert: other.cert, key: other.key }))(req(s.url)),
    );
    assert.deepEqual(s.seen, []);
  } finally {
    await s.close();
  }
});

test("a response over 1 MB is cut off with an error", async () => {
  const s = await serve((_q: any, res: any) => {
    res.writeHead(200);
    res.end("x".repeat(1024 * 1024 + 10));
  });
  try {
    await assert.rejects(httpsTransport(creds())(req(s.url)), /too large/);
  } finally {
    await s.close();
  }
});

test("an abort after the headers, mid-body, rejects instead of hanging", async () => {
  const s = await serve((_q: any, res: any) => {
    res.writeHead(200);
    res.write("partial");
  });
  try {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    await assert.rejects(httpsTransport(creds())(req(s.url, abort.signal)));
  } finally {
    await s.close();
  }
});

test("a redirect is returned as is and never followed", async () => {
  const s = await serve((_q: any, res: any) => {
    res.writeHead(302, { location: "https://localhost:1/elsewhere" });
    res.end();
  });
  try {
    const r = await httpsTransport(creds())(req(s.url));
    assert.equal(r.status, 302);
    assert.equal(s.seen.length, 1);
  } finally {
    await s.close();
  }
});
