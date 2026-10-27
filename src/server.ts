import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { miniapp, type MiniConfig } from "./miniapp.js";
import type { Database } from "./db.js";
/** Sockets of Upgrade requests, per app, until they close. */
const upgrades = new WeakMap<FastifyInstance, Set<Duplex>>();
/** Once a Node server has an "upgrade" listener (here @fastify/websocket's, registered
 * only in the miniapp context), every Upgrade request's socket leaves Node's HTTP
 * handling. The plugin destroys it after a plain HTTP answer only for routes in its own
 * context, so an Upgrade request to /healthz, a 404 or a malformed URL left its socket
 * open, and app.close() waited for it forever (journal 127). */
function watchUpgrade(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  // Node sets `upgrade` only on requests it handed to an "upgrade" listener.
  if (!(request.raw as IncomingMessage & { upgrade?: boolean }).upgrade) return;
  const socket = request.raw.socket;
  const open = upgrades.get(app)!;
  open.add(socket);
  socket.once("close", () => open.delete(socket));
  // A WebSocket handshake never finishes the HTTP response; a plain answer does.
  reply.raw.once("finish", () => socket.destroy());
}
/** No model-tool callback. Saved views are read-only; gathering account/browser controls require authenticated owner input. */
export function server(db?: Database, config?: MiniConfig) {
  const app: FastifyInstance = Fastify({
    logger: false,
    bodyLimit: 120000,
    requestTimeout: 15000,
    // A malformed URL is answered before any hook runs.
    frameworkErrors: (
      error: { statusCode?: number },
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      watchUpgrade(app, request, reply);
      reply.code(error.statusCode ?? 400).send({ error: "Bad request" });
    },
  });
  upgrades.set(app, new Set());
  app.addHook("onRequest", async (request, reply) =>
    watchUpgrade(app, request, reply),
  );
  app.get("/healthz", async () => ({
    status: "ok",
    runtime: "personal-agent",
  }));
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: "Not found" }),
  );
  if (db && config)
    app.register(async (instance) => {
      await miniapp(instance, db, config);
    });
  return app;
}
/** Close the app, giving open WebSockets `graceMs` to finish their closing handshake
 * before their sockets are destroyed: a client that never answers would otherwise hold
 * app.close() open. */
export async function closeServer(app: FastifyInstance, graceMs = 1000) {
  let timer: NodeJS.Timeout | undefined;
  const closing = app.close();
  const closed = await Promise.race([
    closing.then(() => true),
    new Promise<false>((r) => (timer = setTimeout(() => r(false), graceMs))),
  ]);
  clearTimeout(timer);
  if (!closed) for (const socket of upgrades.get(app) ?? []) socket.destroy();
  await closing;
}
