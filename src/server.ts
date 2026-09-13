import Fastify from "fastify";
import { miniapp, type MiniConfig } from "./miniapp.js";
import type { Database } from "./db.js";
/** No tool callback. Public APIs are read-only and require an authenticated owner. */
export function server(db?: Database, config?: MiniConfig) {
  const app = Fastify({
    logger: false,
    bodyLimit: 120000,
    requestTimeout: 15000,
  });
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
