import Fastify from "fastify";
/** No public or internal tool callback. All dispatch is in-process and owner-scoped. */
export function server(..._legacy: unknown[]) {
  const app = Fastify({ logger: false, bodyLimit: 256000 });
  app.get("/healthz", async () => ({
    status: "ok",
    runtime: "personal-agent",
  }));
  return app;
}
