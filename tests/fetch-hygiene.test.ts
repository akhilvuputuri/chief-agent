import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { boundedBytes } from "../src/providers.js";
import { SgHttp } from "../src/singapore/http.js";
import { errorFields } from "../src/ops-log.js";

/** A body that records whether the reader cancelled it. */
function trackedBody(text: string) {
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

test("fetch failures log the code from error.cause", () => {
  const socket = Object.assign(new Error("other side closed"), {
    name: "SocketError",
    code: "UND_ERR_SOCKET",
  });
  const failed = new TypeError("fetch failed", { cause: socket });
  const fields = errorFields(failed);
  assert.equal(fields.errorCategory, "TypeError");
  assert.equal(fields.errorCode, "UND_ERR_SOCKET");
  assert.equal(fields.causeCategory, "SocketError");
  // An error's own code still wins over its cause's.
  const own = Object.assign(new Error("x", { cause: socket }), {
    code: "EOWN",
  });
  assert.equal(errorFields(own).errorCode, "EOWN");
  assert.equal(errorFields(new Error("plain")).causeCategory, undefined);
});

test("a failed or oversized response's body is cancelled, not left holding its connection", async () => {
  const failed = trackedBody("error page");
  await assert.rejects(
    boundedBytes(new Response(failed.body, { status: 502 }), 100),
    /HTTP 502/,
  );
  assert.equal(failed.state.cancelled, true);
  const declared = trackedBody("x");
  await assert.rejects(
    boundedBytes(
      new Response(declared.body, { headers: { "content-length": "999" } }),
      10,
    ),
    /too large/,
  );
  assert.equal(declared.state.cancelled, true);
});

test("Singapore responses are limited after decompression and error bodies are released", async (t) => {
  // About 5 MB of JSON that gzips to a few KB: content-length passes, the decoded body does not.
  const big = gzipSync(
    Buffer.from(JSON.stringify({ code: 0, data: "a".repeat(5 * 1024 * 1024) })),
  );
  const server = createServer((req, res) => {
    if (req.url?.includes("fail")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "content-length": String(big.length),
    });
    res.end(big);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  let failNext = false;
  const http = new SgHttp({
    fetch: (_url, init) =>
      fetch(`http://127.0.0.1:${port}/${failNext ? "fail" : "ok"}`, init),
    sleep: async () => {},
  });
  assert.ok(big.length < 4 * 1024 * 1024);
  await assert.rejects(
    http.json("psi"),
    /dataGovRealtime response is too large/,
  );
  failNext = true;
  await assert.rejects(http.json("psi"), /request failed \(404\)/);
});
