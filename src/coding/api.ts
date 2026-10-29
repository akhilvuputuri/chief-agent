import { SandboxAcknowledgementPending } from "./provider.js";
import { rejectionReason } from "./rejection-reason.js";
import { piCompletion } from "./pi-proxy.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CodingController } from "./controller.js";
import { ModelError } from "../model.js";
import { CodingModelFailure } from "./model-failure.js";
import {
  isTerminalHttpStatus,
  retryParentHeader,
  type TerminalHttpReceipt,
} from "@chief-agent/pi-runtime/terminal-http-recovery";

const message = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().max(1_000_000).nullable(),
    reasoning_details: z.array(z.record(z.unknown())).optional(),
    tool_call_id: z.string().max(200).optional(),
    tool_calls: z
      .array(
        z
          .object({
            id: z.string().max(200),
            type: z.literal("function"),
            // OpenRouter may return this ordering metadata in a complete response.
            // The Python worker preserves it in the next assistant message.
            index: z.number().int().nonnegative().optional(),
            function: z
              .object({
                name: z.string().max(100),
                arguments: z.string().max(1_000_000),
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
        ["POST", "github-token"],
        ["POST", "pi-session"],
        ["GET", "pi-session"],
        ["POST", "pi/coder/v1/chat/completions"],
        ["POST", "pi/reviewer/v1/chat/completions"],
      ] as const) {
        const diagnosticPhase =
          path === "pi-session" || path === "github-token"
            ? "checkpoint"
            : path === "pi/coder/v1/chat/completions" ||
                path === "pi/reviewer/v1/chat/completions"
              ? "model"
              : path;
        api.route({
          method,
          url: `/:id/${path}`,
          // Pi report/checkpoint documents plus the existing bounded patch/files.
          // Worst-case JSON escaping of every allowed string fits within 64 MB.
          bodyLimit:
            path === "checkpoint" || path === "finish" ? 64_000_000 : 8_000_000,
          // Authenticate the larger artifact routes before parsing their bodies.
          onRequest: async (req, reply) => {
            if (path !== "checkpoint" && path !== "finish") return;
            try {
              await controller.authenticate(
                (req.params as { id: string }).id,
                req.headers.authorization?.replace(/^Bearer /, "") ?? "",
                path === "finish",
              );
            } catch (error) {
              return reply
                .code(
                  error instanceof SandboxAcknowledgementPending ? 503 : 401,
                )
                .send({ error: "Worker capability unavailable" });
            }
          },
          handler: async (req, reply) => {
            const id = (req.params as { id: string }).id;
            if (!z.string().uuid().safeParse(id).success)
              return reply
                .code(401)
                .send({ error: "Invalid worker capability" });
            let job;
            const acknowledgementUntil = Date.now() + 120000;
            while (true) {
              try {
                job = await controller.authenticate(
                  id,
                  req.headers.authorization?.replace(/^Bearer /, "") ?? "",
                  path === "finish",
                );
                break;
              } catch (error) {
                if (error instanceof SandboxAcknowledgementPending) {
                  // The immutable Pi client does not retry HTTP errors. Hold only
                  // its valid bootstrap read while the launch receipt is pending.
                  if (
                    path === "assignment" &&
                    !reply.raw.destroyed &&
                    Date.now() < acknowledgementUntil
                  ) {
                    await new Promise((resolve) =>
                      setTimeout(
                        resolve,
                        Math.min(250, acknowledgementUntil - Date.now()),
                      ),
                    );
                    continue;
                  }
                  return reply.code(503).send({
                    error: "Sandbox launch acknowledgement is pending",
                  });
                }
                return reply
                  .code(401)
                  .send({ error: "Invalid worker capability" });
              }
            }
            try {
              if (
                job.settings.runtime !== "pi" &&
                req.body !== undefined &&
                Buffer.byteLength(JSON.stringify(req.body)) > 800000
              )
                return reply.code(413).send({
                  error: "Legacy worker request exceeds supported size",
                });
              if (path === "pi-session") {
                if (method === "POST")
                  return await controller.piSessionAppend(job, req.body);
                const query = req.query as { scope?: string; offset?: string };
                return await controller.piSessionRead(
                  job,
                  query.scope ?? "",
                  Number(query.offset ?? 0),
                );
              }
              if (path.endsWith("chat/completions")) {
                const response = await piCompletion(
                  controller,
                  job,
                  path.includes("/reviewer/") ? "reviewer" : "coder",
                  req.body,
                  req.headers[retryParentHeader],
                );
                return response.stream
                  ? reply.type("text/event-stream").send(response.body)
                  : response.body;
              }
              if (path === "assignment") return controller.assignment(job);
              if (path === "heartbeat") return await controller.heartbeat(job);
              if (path === "progress")
                return await controller.progress(job, req.body);
              if (path === "checkpoint")
                return await controller.save(job, req.body);
              if (path === "finish")
                return await controller.finish(job, req.body);
              if (path === "logs") return await controller.logs(job, req.body);
              if (path === "github-token")
                return await controller.githubToken(job);
              if (path === "model") {
                if (Buffer.byteLength(JSON.stringify(req.body)) > 4_000_000) {
                  await controller
                    .recordRejection(job, {
                      phase: diagnosticPhase,
                      code: "model_context_limit",
                      httpStatus: 413,
                    })
                    .catch(() => {});
                  return reply.code(413).send({
                    error: "Model input exceeds coding context limit",
                    code: "model_context_limit",
                  });
                }
                return await controller.generate(
                  job,
                  generation.parse(req.body),
                );
              }
            } catch (error) {
              const code =
                error instanceof CodingModelFailure
                  ? error.code
                  : error instanceof z.ZodError
                    ? "invalid_worker_payload"
                    : error instanceof ModelError
                      ? "model_provider_failed"
                      : "worker_request_rejected";
              const recorded = await controller
                .recordRejection(job, {
                  phase: diagnosticPhase,
                  code,
                  httpStatus: 409,
                  ...(code === "worker_request_rejected"
                    ? { reason: rejectionReason(error) }
                    : {}),
                  ...(error instanceof CodingModelFailure ? error.details : {}),
                })
                .catch(() => false);
              const recovery: TerminalHttpReceipt | undefined =
                recorded &&
                path.endsWith("chat/completions") &&
                job.settings.runtime === "pi" &&
                !req.headers[retryParentHeader] &&
                error instanceof CodingModelFailure &&
                ["model_rate_limited", "model_transient_failure"].includes(
                  error.code,
                ) &&
                isTerminalHttpStatus(error.details.providerStatus) &&
                !error.details.timeoutKind &&
                !error.details.finishReason &&
                !error.details.providerFailure
                  ? {
                      version: 1,
                      kind: "terminal-provider-http",
                      callId: error.details.callId,
                      attemptId: job.attempt_id!,
                      providerStatus: error.details.providerStatus,
                    }
                  : undefined;
              return reply.code(409).send({
                error:
                  "Coding request rejected; inspect job state before retrying",
                code,
                ...(recovery ? { recovery } : {}),
              });
            }
          },
        });
      }
    },
    { prefix: "/coding/worker" },
  );
}
