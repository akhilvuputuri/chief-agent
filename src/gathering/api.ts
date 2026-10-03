import { randomBytes } from "node:crypto";
import "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { MiniAuth } from "../miniapp-auth.js";
import type { Gathering } from "./controller.js";
import { z } from "zod";
import { Readable } from "node:stream";
import { collectionZip } from "./zip.js";
export async function gatheringApi(
  api: FastifyInstance,
  auth: MiniAuth,
  gather: Gathering,
  origin: string,
) {
  const owner = (req: { headers: { authorization?: string } }) =>
    auth.verify(req.headers.authorization);
  const idParam = (p: unknown) =>
    z.object({ id: z.string().uuid() }).strict().parse(p).id;
  api.get("/gathering", async (req) =>
    gather.status(
      owner(req),
      undefined,
      z
        .object({
          offset: z.coerce.number().int().min(0).max(10000).default(0),
        })
        .strict()
        .parse(req.query).offset,
      true,
    ),
  );
  api.get("/gathering/:id", async (req) =>
    gather.status(owner(req), idParam(req.params), 0, true),
  );
  api.post("/gathering/:id/account", async (req) => {
    const body = z
      .object({
        targetKey: z.string().min(1).max(64),
        artifactId: z.string().uuid(),
        revision: z.number().int().min(1),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(req.body);
    return gather.verifyAccount(
      owner(req),
      idParam(req.params),
      body.targetKey,
      body.artifactId,
      body.revision,
    );
  });
  api.get("/files/:id", async (req, reply) => {
    const file = await gather.vault.read(owner(req), idParam(req.params));
    return reply
      .header(
        "Content-Disposition",
        `attachment; filename="invoice.pdf"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      )
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .type("application/pdf")
      .send(file.data);
  });
  api.get("/gathering/:id/archive", async (req, reply) => {
    const user = owner(req),
      id = idParam(req.params);
    await gather.collection(user, id);
    reply
      .header(
        "Content-Disposition",
        `attachment; filename="invoices-${id.slice(0, 8)}.zip"`,
      )
      .type("application/zip");
    return reply.send(Readable.from(collectionZip(gather, user, id)));
  });
  if (!gather.browsers) return;
  api.post("/browser/:id/forget", async (req) =>
    gather.browsers!.forget(owner(req), idParam(req.params)),
  );
  api.get(
    "/browser-profiles",
    async (req) =>
      (
        await gather.db.query(
          "SELECT origin,account_label,updated_at FROM gather_browser_profiles WHERE user_id=$1 ORDER BY origin,account_label LIMIT 100",
          [owner(req)],
        )
      ).rows,
  );
  api.post("/browser-profiles/forget", async (req) => {
    const user = owner(req),
      body = z
        .object({
          origin: z.string().url().max(300),
          accountLabel: z.string().min(1).max(120),
          confirmed: z.literal(true),
        })
        .strict()
        .parse(req.body);
    return gather.browsers!.forgetProfile(user, body.origin, body.accountLabel);
  });
  api.get("/browser/:id", async (req) =>
    gather.browsers!.info(owner(req), idParam(req.params)),
  );
  const tickets = new Map<
    string,
    { user: string; id: string; bearer: string; expires: number }
  >();
  api.get("/browser-ticket/:id", async (req) => {
    const user = owner(req),
      id = idParam(req.params);
    await gather.browsers!.info(user, id);
    for (const [key, value] of tickets)
      if (value.expires < Date.now()) tickets.delete(key);
    if (tickets.size >= 30) throw new Error("Too many browser connections");
    const ticket = randomBytes(32).toString("hex");
    tickets.set(ticket, {
      user,
      id,
      bearer: req.headers.authorization!,
      expires: Date.now() + 30000,
    });
    return { ticket };
  });
  let connections = 0;
  api.get("/browser-control/:id", { websocket: true }, (socket, req) => {
    if (
      req.headers.origin !== origin ||
      req.headers["sec-websocket-protocol"] !== "chief-browser" ||
      connections >= 10
    ) {
      socket.close(1008, "Open from Chief");
      return;
    }
    ++connections;
    let identity: { user: string; id: string; bearer: string } | undefined,
      ready = false,
      busy = false,
      window = Date.now(),
      requests = 0;
    const timeout = setTimeout(() => {
      if (!identity) socket.close(1008, "Open from Chief");
    }, 5000);
    timeout.unref();
    const send = (x: unknown) => {
      if (socket.readyState === 1 && socket.bufferedAmount < 2_500_000)
        socket.send(JSON.stringify(x));
    };
    socket.on("message", (raw: unknown) => {
      void (async () => {
        try {
          if (!Buffer.isBuffer(raw) || raw.length > 8000 || busy)
            throw new Error("Not ready");
          const command = JSON.parse(raw.toString());
          if (!identity) {
            const first = z
              .object({
                kind: z.literal("auth"),
                ticket: z.string().regex(/^[0-9a-f]{64}$/),
              })
              .strict()
              .parse(command);
            const ticket = tickets.get(first.ticket);
            tickets.delete(first.ticket);
            if (
              !ticket ||
              ticket.expires < Date.now() ||
              ticket.id !== idParam(req.params) ||
              auth.verify(ticket.bearer) !== ticket.user
            )
              throw new Error("Unauthorized");
            identity = ticket;
            clearTimeout(timeout);
            busy = true;
            await gather.browsers!.connectOwner(ticket.user, ticket.id);
            ready = true;
            send({ type: "ready" });
            return;
          }
          auth.verify(identity.bearer);
          if (!ready) throw new Error("Not ready");
          if (Date.now() - window >= 60000) {
            window = Date.now();
            requests = 0;
          }
          if (++requests > 150) throw new Error("Too many requests");
          busy = true;
          const result = await gather.browsers!.owner(
            identity.user,
            identity.id,
            command,
          );
          send({
            type:
              command.kind === "done"
                ? "saved"
                : command.kind === "close"
                  ? "closed"
                  : "frame",
            ...result,
          });
        } catch {
          send({
            type: "error",
            message:
              "Browser input could not be completed. Reopen this view if your session expired.",
          });
          socket.close(1008, "Browser unavailable");
        } finally {
          busy = false;
        }
      })();
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      --connections;
      ready = false;
      if (identity)
        void gather.browsers!.disconnectOwner(identity.user, identity.id);
    });
    socket.on("error", () => socket.close());
  });
}
