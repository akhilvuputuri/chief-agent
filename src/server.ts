import Fastify from "fastify";
import type { Assistant } from "./agent.js";
import { authorized } from "./security.js";
import { TOOL_DESCRIPTION } from "./protocol.js";
export function server(assistant: Assistant, token: string) {
  const app = Fastify({ logger: false, bodyLimit: 256000 });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/internal/tool-description", async (req, reply) => {
    if (!authorized(req.headers.authorization, token))
      return reply.code(401).send({ error: "Unauthorized" });
    return { description: TOOL_DESCRIPTION };
  });
  app.post("/internal/tools", async (req, reply) => {
    const capability = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    try {
      return { result: await assistant.call(capability, req.body) };
    } catch {
      return reply.code(400).send({
        error:
          "Tool rejected: invalid input, unavailable role/provider, or expired run",
      });
    }
  });
  return app;
}
