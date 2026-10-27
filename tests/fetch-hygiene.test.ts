import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createGzip } from "node:zlib";
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

test(
  "Singapore reads stop at the limit on the decoded stream",
  { timeout: 30_000 },
  async (t) => {
    // An endless gzip stream of zeros: tiny on the wire, unbounded once decoded.
    // Reading it whole (the old arrayBuffer() path) never finishes.
    const server = createServer((req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
      });
      const gzip = createGzip();
      gzip.pipe(res);
      const zeros = Buffer.alloc(64 * 1024);
      let open = true;
      req.socket.on("close", () => {
        open = false;
        gzip.destroy();
      });
      const pump = () => {
        while (open && gzip.write(zeros));
        if (open) gzip.once("drain", pump);
      };
      pump();
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const port = (server.address() as { port: number }).port;
    const http = new SgHttp({
      fetch: (_url, init) => fetch(`http://127.0.0.1:${port}/`, init),
      sleep: async () => {},
    });
    await assert.rejects(
      http.json("psi"),
      /dataGovRealtime response is too large/,
    );
  },
);

test("Singapore error responses release their bodies", async () => {
  for (const status of [404, 429, 500]) {
    const tracked = trackedBody("error body");
    const http = new SgHttp({
      fetch: async () => new Response(tracked.body, { status }),
      sleep: async () => {},
    });
    await assert.rejects(http.json("psi"));
    assert.equal(tracked.state.cancelled, true, `status ${status}`);
  }
});
