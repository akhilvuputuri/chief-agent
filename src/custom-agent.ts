import { runAlignment } from "./alignment.js";
import { randomUUID } from "node:crypto";
import { delegateResearch } from "./research.js";
import { delegateMedia } from "./media.js";
import { projectObservation } from "./observations.js";
import { action } from "./protocol.js";
import type { AgentRequest, AgentResponse } from "./protocol.js";
import type { Agent } from "./agent.js";
import { context } from "./context.js";
import {
  ModelError,
  type ModelAdapter,
  type Message,
  type ModelMessage,
  type ToolDefinition,
} from "./model.js";
import { Stop, readOperations, type StopReason } from "./execution.js";
import { toolError } from "./tool-errors.js";
const finishTool: ToolDefinition = {
  name: "finish_turn",
  description:
    "Pause with your natural reply and an explicit reason after completing any independent runnable work.",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        enum: ["answer", "awaiting_user", "awaiting_approval"],
      },
      reply: { type: "string" },
    },
    required: ["reason", "reply"],
    additionalProperties: false,
  },
};
/** Image parts are replaced before tracing so model-input records never retain raw bytes. */
export function omitImages(messages: ModelMessage[]) {
  return messages.map((m) =>
    Array.isArray(m.content)
      ? {
          ...m,
          content: m.content.map((part) =>
            part.type === "image_url"
              ? {
                  type: "image_url" as const,
                  image_url: {
                    url: `[image omitted from trace: ${part.image_url.url.length} characters]`,
                  },
                }
              : part,
          ),
        }
      : m,
  );
}
export class CustomAgent implements Agent {
  constructor(
    private model: ModelAdapter,
    private specialists: { media?: ModelAdapter } = {},
  ) {}
  async run(req: AgentRequest): Promise<AgentResponse> {
    const model =
      req.specialist === "media" && this.specialists.media
        ? this.specialists.media
        : this.model;
    const execution = req.execution;
    if (!execution || !req.execute || !req.signal)
      throw new Error("Owner-scoped execution is required");
    const messages = [
      ...(req.history as Message[]),
      { role: "user", content: req.message } as Message,
    ];
    const tools = [...(req.runtime?.tools ?? []), finishTool];
    const enabled = new Set(tools.map((t) => t.name));
    let reply = "",
      reason: StopReason = "answer";
    await execution.checkpoint(messages);
    try {
      while (true) {
        let generation;
        let invocationId = "";
        for (let attempt = 0; ; attempt++) {
          const remaining = await execution.consume("models");
          const start = Date.now();
          invocationId = randomUUID();
          try {
            await execution.trace("model.started", {
              invocationId,
              model: model.model ?? null,
              attempt,
            });
            await req.refreshContext?.();
            const input = context(req, messages);
            if (input.omitted)
              await execution.trace("context.omitted", {
                messages: input.omitted,
              });
            if (req.specialist)
              await execution.trace("research.model_input", {
                version: 1,
                invocationId,
                messages: omitImages(input.messages),
                tools,
                reasoning: "medium",
                omitted: input.omitted,
              });
            generation = await model.generate({
              messages: input.messages,
              tools,
              reasoning: "medium",
              sessionId: req.runId,
              signal: AbortSignal.any([
                req.signal,
                AbortSignal.timeout(Math.max(1, remaining)),
              ]),
            });
            // Save the complete model response before dispatching any requested operation.
            messages.push(generation.message);
            await execution.checkpoint(messages);
            await execution.trace("model.completed", {
              invocationId,
              model: generation.model ?? model.model,
              provider: generation.provider,
              usage: generation.usage ?? null,
              latencyMs: Date.now() - start,
            });
            break;
          } catch (error) {
            await execution.trace("model.failed", {
              invocationId,
              ...(error instanceof ModelError
                ? { diagnostics: error.diagnostics, transient: error.transient }
                : {}),
              attempt,
              latencyMs: Date.now() - start,
            });
            if (req.signal.aborted) throw new Stop("cancelled");
            if (Date.now() - start >= remaining)
              throw new Stop("budget_exhausted");
            if (
              !(
                (error instanceof ModelError && error.transient) ||
                error instanceof TypeError
              ) ||
              attempt >= 2
            )
              throw error;
          } finally {
            await execution.elapsed(Date.now() - start);
          }
        }
        if (req.signal.aborted) throw new Stop("cancelled");
        const calls = generation.message.tool_calls ?? [];
        if (calls.length && generation.message.content && req.progress) {
          try {
            await req.progress(generation.message.content);
          } catch {
            await execution.trace("delivery.progress_failed", {});
          }
        }
        if (!calls.length) {
          reply = generation.message.content ?? "";
          break;
        }
        let finish: { reply: string; reason: StopReason } | undefined;
        for (const call of calls) {
          const op = call.function.name;
          let result: unknown;
          const start = Date.now();
          if (req.signal.aborted) throw new Stop("cancelled");
          if (op.startsWith("work_") && op !== "work_status")
            await execution.attach(true);
          await execution.consume("tools");
          const journal = await execution.beginCall(call.id, op, {
            raw: call.function.arguments,
          });
          await execution.trace("tool.linked", {
            invocationId,
            observationId: journal,
            callId: call.id,
            operation: op,
          });
          let dispatched = false;
          try {
            if (!enabled.has(op)) throw new Error("Operation unavailable");
            const args = JSON.parse(call.function.arguments);
            if (op === "finish_turn") {
              if (
                !["answer", "awaiting_user", "awaiting_approval"].includes(
                  args.reason,
                ) ||
                typeof args.reply !== "string"
              )
                throw new Error("Invalid finish arguments");
              finish = { reply: args.reply, reason: args.reason };
              result = { recorded: true };
            } else {
              if (Object.hasOwn(args, "operation"))
                throw new Error("Operation must come from the tool name");
              const input = action.parse({ ...args, operation: op });
              for (let attempt = 0; ; attempt++) {
                try {
                  dispatched = true;
                  result =
                    op === "research_delegate"
                      ? await delegateResearch(req, input, (child) =>
                          this.run(child),
                        )
                      : op === "media_delegate"
                        ? await delegateMedia(
                            req,
                            input,
                            (child) => this.run(child),
                            (this.specialists.media ?? this.model).model ?? "",
                          )
                        : [
                              "job_alignment_start",
                              "job_alignment_resume",
                              "job_alignment_read",
                            ].includes(op)
                          ? await runAlignment(req, input, (child) =>
                              this.run(child),
                            )
                          : await req.execute(input);
                  if (
                    op === "research_report" ||
                    op === "media_report" ||
                    op === "job_alignment_report"
                  )
                    finish = {
                      reply: JSON.stringify(result),
                      reason: "answer",
                    };
                  break;
                } catch (error) {
                  // Only retry known transient reads; all writes have a single dispatch.
                  if (
                    !readOperations.has(op) ||
                    op === "research_delegate" ||
                    op === "media_delegate" ||
                    op.startsWith("job_alignment_") ||
                    attempt >= 2 ||
                    !(
                      error instanceof TypeError ||
                      (error instanceof Error &&
                        error.name === "TimeoutError") ||
                      /429|502|503|504|ETIMEDOUT|ECONNRESET/.test(String(error))
                    )
                  )
                    throw error;
                  await execution.consume("tools");
                }
              }
            }
            await execution.endCall(journal, result);
          } catch (error) {
            if (error instanceof Stop) throw error;
            result = { error: toolError(error) };
            const uncertain =
              dispatched &&
              op !== "finish_turn" &&
              !readOperations.has(op) &&
              ["RESULT_UNRECORDED", "TOOL_FAILED"].includes(
                (result as any).error.code,
              );
            await execution.endCall(
              journal,
              result,
              uncertain ? "uncertain" : "failed",
            );
            if (uncertain) throw new Stop("failed");
          } finally {
            await execution.elapsed(Date.now() - start);
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(
              result && typeof result === "object" && "error" in result
                ? result
                : projectObservation(op, result, journal),
            ),
          });
          await execution.checkpoint(messages);
          await execution.attach();
        }
        if (finish) {
          reply = finish.reply;
          reason = finish.reason;
          messages.push({ role: "assistant", content: reply });
          await execution.checkpoint(messages);
          break;
        }
      }
    } catch (error) {
      reason =
        error instanceof Stop
          ? error.reason
          : req.signal.aborted
            ? "cancelled"
            : "failed";
      // These are operational notices, not replacements for model-written task reports.
      reply =
        reason === "budget_exhausted"
          ? "The execution budget is used up. Completed results are saved. Use /status to inspect progress and /continue to grant another allocation."
          : reason === "cancelled"
            ? "Cancelled. Completed actions remain recorded."
            : error instanceof ModelError
              ? error.message
              : "Execution stopped after an error. Saved results are retained; inspect /status before continuing.";
    }
    if (
      reason === "answer" &&
      (
        await execution.db.query(
          "SELECT 1 FROM approvals WHERE user_id=$1 AND run_id=$2 AND status='pending' AND expires_at>now() LIMIT 1",
          [execution.user, execution.run],
        )
      ).rows.length
    )
      reason = "awaiting_approval";
    await execution.finish(reason);
    return { reply, history: messages, stopReason: reason };
  }
}
