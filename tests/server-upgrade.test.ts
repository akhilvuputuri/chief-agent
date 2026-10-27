import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import websocket from "@fastify/websocket";
import { closeServer, server } from "../src/server.js";

// On the old code a leaked socket keeps close() pending forever. Each test has a timeout,
// and cleanup destroys the client sockets first, so a regression fails instead of hanging.
const clients = new Set<net.Socket>();
async function stop(instance: Awaited<ReturnType<typeof app>>) {
  for (const socket of clients) socket.destroy();
  clients.clear();
  await closeServer(instance);
}

/** The production shape: @fastify/websocket registered only in a child context. */
async function app() {
  const instance = server();
  instance.register(async (child) => {
    await child.register(websocket);
    child.get("/ws", { websocket: true }, () => {});
  });
  await instance.listen({ port: 0, host: "127.0.0.1" });
  return instance;
}
/** Send a WebSocket Upgrade request; report the status line and whether the server
 * closed the socket within `waitMs`. */
function upgrade(port: number, path: string, waitMs = 1000) {
  return new Promise<{ status: string; closed: boolean; socket: net.Socket }>(
    (resolve) => {
      const socket = net.connect(port, "127.0.0.1", () =>
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
            "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        ),
      );
      clients.add(socket);
      let data = "";
      socket.on("data", (d) => (data += d));
      const status = () => data.split("\r\n")[0] ?? "";
      const timer = setTimeout(
        () => resolve({ status: status(), closed: false, socket }),
        waitMs,
      );
      socket.on("close", () => {
        clearTimeout(timer);
        resolve({ status: status(), closed: true, socket });
      });
    },
  );
}

test(
  "an Upgrade request answered over plain HTTP has its socket closed, on every route",
  { timeout: 10_000 },
  async (t) => {
    const instance = await app();
    t.after(() => stop(instance));
    const { port } = instance.server.address() as net.AddressInfo;
    for (const [path, code] of [
      ["/healthz", "200"],
      ["/missing", "404"],
      ["/%zz", "400"],
    ] as const) {
      const result = await upgrade(port, path);
      assert.match(result.status, new RegExp(`^HTTP/1.1 ${code}`), path);
      assert.equal(result.closed, true, `${path} socket left open`);
    }
  },
);

test(
  "a WebSocket client that never answers the closing handshake cannot hold the server open",
  { timeout: 10_000 },
  async (t) => {
    const instance = await app();
    const { port } = instance.server.address() as net.AddressInfo;
    const held = await upgrade(port, "/ws", 300);
    assert.match(held.status, /^HTTP\/1.1 101/);
    assert.equal(held.closed, false);
    // If closeServer() regresses, the timeout cancels the test and this lets close() finish.
    t.after(() => held.socket.destroy());
    const disconnected = once(held.socket, "close");
    const started = Date.now();
    await closeServer(instance, 200);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
    await disconnected;
  },
);

test(
  "ordinary requests keep their connection",
  { timeout: 10_000 },
  async (t) => {
    const instance = await app();
    t.after(() => stop(instance));
    const { port } = instance.server.address() as net.AddressInfo;
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(response.status, 200);
      await response.json();
    }
    // A bad URL without Upgrade is still answered, in Chief's error shape.
    const bad = await fetch(`http://127.0.0.1:${port}/%zz`);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "Bad request" });
  },
);
