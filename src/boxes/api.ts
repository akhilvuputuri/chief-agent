import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { ToolValidationError } from "../tool-errors.js";
import { BoxCredentialRefused, type BoxController } from "./controller.js";

const boxId = z.string().uuid();
const bearer = (header: string | undefined) =>
  header?.startsWith("Bearer ") ? header.slice(7) : "";

/** The box channel: boxes dial out to these routes; nothing calls into a box. */
export async function boxApi(app: FastifyInstance, boxes: BoxController) {
  await app.register(
    async (api) => {
      const guard = async (
        reply: { code(n: number): { send(body: unknown): unknown } },
        run: () => Promise<unknown>,
      ) => {
        try {
          return await run();
        } catch (error) {
          if (error instanceof BoxCredentialRefused)
            return reply.code(401).send({ error: "Box credential refused" });
          if (error instanceof ZodError || error instanceof ToolValidationError)
            return reply.code(400).send({ error: "Invalid box request" });
          throw error;
        }
      };
      api.post("/:id/hello", { bodyLimit: 64000 }, async (req, reply) => {
        const id = boxId.safeParse((req.params as { id: string }).id);
        if (!id.success)
          return reply.code(401).send({ error: "Box credential refused" });
        return guard(reply, () => boxes.hello(id.data, req.body));
      });
      api.get("/:id/next", async (req, reply) => {
        const id = boxId.safeParse((req.params as { id: string }).id);
        const after = z.coerce
          .number()
          .int()
          .nonnegative()
          .safeParse((req.query as { after?: string }).after ?? "0");
        if (!id.success || !after.success)
          return reply.code(401).send({ error: "Box credential refused" });
        const abort = new AbortController();
        req.raw.on("close", () => abort.abort());
        return guard(reply, () =>
          boxes.next(
            id.data,
            bearer(req.headers.authorization),
            after.data,
            abort.signal,
          ),
        );
      });
      api.post("/:id/events", { bodyLimit: 400000 }, async (req, reply) => {
        const id = boxId.safeParse((req.params as { id: string }).id);
        if (!id.success)
          return reply.code(401).send({ error: "Box credential refused" });
        return guard(reply, () =>
          boxes.events(id.data, bearer(req.headers.authorization), req.body),
        );
      });
    },
    { prefix: "/boxes" },
  );
}
