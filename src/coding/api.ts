import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CodingController } from "./controller.js";

const message = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().max(120000).nullable(),
    reasoning_details: z.array(z.record(z.unknown())).optional(),
    tool_call_id: z.string().max(200).optional(),
    tool_calls: z
      .array(
        z
          .object({
            id: z.string().max(200),
            type: z.literal("function"),
            function: z
              .object({
                name: z.string().max(100),
                arguments: z.string().max(180000),
              })
              .strict(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();
const generation = z
  .object({
    callId: z.string().uuid(),
    role: z.enum(["leader", "coder", "reviewer"]),
    messages: z.array(message).max(120),
    tools: z
      .array(
        z
          .object({
            name: z.string().max(100),
            description: z.string().max(2000),
            parameters: z.record(z.unknown()),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

/** Worker capabilities authorise one attempt, never an owner session or general tools. */
export async function codingApi(
  app: FastifyInstance,
  controller: CodingController,
) {
  await app.register(
    async (api) => {
      for (const [method, path] of [
        ["GET", "assignment"],
        ["POST", "heartbeat"],
        ["POST", "progress"],
        ["POST", "checkpoint"],
        ["POST", "finish"],
        ["POST", "model"],
        ["POST", "logs"],
      ] as const) {
        api.route({
          method,
          url: `/:id/${path}`,
          bodyLimit: 800000,
          handler: async (req, reply) => {
            const id = (req.params as { id: string }).id;
            if (!z.string().uuid().safeParse(id).success)
              return reply
                .code(401)
                .send({ error: "Invalid worker capability" });
            let job;
            try {
              job = await controller.authenticate(
                id,
                req.headers.authorization?.replace(/^Bearer /, "") ?? "",
                path === "finish",
              );
            } catch {
              return reply
                .code(401)
                .send({ error: "Invalid worker capability" });
            }
            try {
              if (path === "assignment") return controller.assignment(job);
              if (path === "heartbeat") return await controller.heartbeat(job);
              if (path === "progress")
                return await controller.progress(job, req.body);
              if (path === "checkpoint")
                return await controller.save(job, req.body);
              if (path === "finish")
                return await controller.finish(job, req.body);
              if (path === "logs") return await controller.logs(job, req.body);
              if (path === "model") {
                if (Buffer.byteLength(JSON.stringify(req.body)) > 180000)
                  return reply.code(413).send({
                    error: "Model input exceeds coding context limit",
                  });
                return await controller.generate(
                  job,
                  generation.parse(req.body),
                );
              }
            } catch {
              return reply.code(409).send({
                error:
                  "Coding request rejected; inspect job state before retrying",
              });
            }
          },
        });
      }
    },
    { prefix: "/coding/worker" },
  );
}
