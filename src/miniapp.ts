import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MiniAuth } from "./miniapp-auth.js";
import { Canvases } from "./canvases.js";
import { event, type Database } from "./db.js";
export interface MiniConfig {
  origin: string;
  token: string;
  allowed: Set<string>;
}
export async function miniapp(
  app: FastifyInstance,
  db: Database,
  config: MiniConfig,
) {
  const auth = new MiniAuth(config.token, config.allowed);
  const canvases = new Canvases(db);
  const files: Record<string, { type: string; body: string }> = {
    "/miniapp/": {
      type: "text/html; charset=utf-8",
      body: await readFile(
        new URL("../web/index.html", import.meta.url),
        "utf8",
      ),
    },
    "/miniapp/app.js": {
      type: "text/javascript; charset=utf-8",
      body: await readFile(
        new URL("../dist/miniapp-ui.js", import.meta.url),
        "utf8",
      ),
    },
    "/miniapp/app.css": {
      type: "text/css; charset=utf-8",
      body: await readFile(new URL("../web/app.css", import.meta.url), "utf8"),
    },
  };
  for (const [path, file] of Object.entries(files))
    app.get(path, async (_req, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .header(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'self' https://telegram.org; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'",
        )
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .type(file.type)
        .send(file.body),
    );
  await app.register(
    async (api) => {
      // Bounded global unauthenticated ingress allowance; this personal app has one process.
      let window = Date.now(),
        requests = 0;
      api.addHook("onRequest", async (req, reply) => {
        reply
          .header("Cache-Control", "no-store")
          .header("X-Content-Type-Options", "nosniff");
        if (Date.now() - window > 60000) {
          window = Date.now();
          requests = 0;
        }
        if (++requests > 300)
          return reply
            .code(429)
            .send({ error: "Too many requests; try again shortly." });
        if (req.headers.origin && req.headers.origin !== config.origin)
          return reply.code(403).send({ error: "Forbidden" });
        if (req.routeOptions.url?.endsWith("/session")) return;
        try {
          auth.verify(req.headers.authorization);
        } catch {
          return reply
            .code(401)
            .send({ error: "Open this app again from Telegram." });
        }
      });
      api.setErrorHandler((_error, _req, reply) =>
        reply.code(400).send({
          error:
            "This request could not be completed. Reopen the view or try again.",
        }),
      );
      api.post("/session", { bodyLimit: 16000 }, async (req, reply) => {
        if (req.headers.origin !== config.origin)
          return reply.code(403).send({ error: "Forbidden" });
        try {
          const body = z
            .object({ initData: z.string().max(16000) })
            .strict()
            .parse(req.body);
          return auth.authenticate(body.initData);
        } catch {
          return reply
            .code(401)
            .send({ error: "Open this app again from Telegram." });
        }
      });
      const owner = (req: { headers: { authorization?: string } }) =>
        auth.verify(req.headers.authorization);
      const page = (q: unknown) =>
        z
          .object({
            offset: z.coerce.number().int().min(0).max(10000).default(0),
          })
          .strict()
          .parse(q);
      api.get("/canvases", async (req) =>
        canvases.list(owner(req), page(req.query).offset),
      );
      api.get("/canvases/:id", async (req, reply) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const { revision } = z
          .object({ revision: z.coerce.number().int().positive().optional() })
          .strict()
          .parse(req.query);
        const user = owner(req);
        let row;
        try {
          row = await canvases.read(user, id, revision);
        } catch {
          return reply.code(404).send({ error: "Canvas not found" });
        }
        await event(db, user, randomUUID(), "canvas.viewed", {
          canvasId: id,
          revision: row.revision,
          originRunId: row.run_id,
        });
        return row;
      });
      api.get("/canvases/:id/head", async (req, reply) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const row = (
          await db.query(
            "SELECT latest_revision FROM canvases WHERE id=$1 AND user_id=$2",
            [id, owner(req)],
          )
        ).rows[0];
        return row ?? reply.code(404).send({ error: "Canvas not found" });
      });
      api.get("/canvases/:id/history", async (req) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        return canvases.history(owner(req), id, page(req.query).offset);
      });
      api.get("/roles", async (req) => {
        const { offset } = page(req.query);
        const rows = (
          await db.query(
            "SELECT id,title,company,status,updated_at FROM jobs WHERE user_id=$1 ORDER BY company,title,id LIMIT 51 OFFSET $2",
            [owner(req), offset],
          )
        ).rows;
        return {
          items: rows.slice(0, 50),
          nextOffset: rows.length > 50 ? offset + 50 : null,
        };
      });
      api.get("/roles/:id", async (req, reply) => {
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const user = owner(req);
        const row = (
          await db.query(
            "SELECT id,title,company,status,url,description,notes,updated_at FROM jobs WHERE id=$1 AND user_id=$2",
            [id, user],
          )
        ).rows[0];
        if (!row) return reply.code(404).send({ error: "Role not found" });
        return row;
      });
    },
    { prefix: "/api/miniapp" },
  );
}
