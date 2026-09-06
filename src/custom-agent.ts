import { action } from "./protocol.js";
import type { AgentRequest, AgentResponse } from "./protocol.js";
import type { Agent } from "./agent.js";
import { context } from "./context.js";
import {
  ModelError,
  type ModelAdapter,
  type Message,
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
export class CustomAgent implements Agent {
  constructor(private model: ModelAdapter) {}
  async run(req: AgentRequest): Promise<AgentResponse> {
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
        for (let attempt = 0; ; attempt++) {
          const remaining = await execution.consume("models");
          const start = Date.now();
          try {
            await execution.trace("model.started", {
              model: this.model.model ?? null,
              attempt,
            });
            const input = context(req, messages);
            if (input.omitted)
              await execution.trace("context.omitted", {
                messages: input.omitted,
              });
            generation = await this.model.generate({
              messages: input.messages,
              tools,
              reasoning: "medium",
              signal: AbortSignal.any([
                req.signal,
                AbortSignal.timeout(Math.max(1, remaining)),
              ]),
            });
            // Save the complete model response before dispatching any requested operation.
            messages.push(generation.message);
            await execution.checkpoint(messages);
            await execution.trace("model.completed", {
              model: generation.model,
              provider: generation.provider,
              usage: generation.usage ?? null,
              latencyMs: Date.now() - start,
            });
            break;
          } catch (error) {
            await execution.trace("model.failed", {
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
                  result = await req.execute(input);
                  break;
                } catch (error) {
                  // Only retry known transient reads; all writes have a single dispatch.
                  if (
                    !readOperations.has(op) ||
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
            content: JSON.stringify(result),
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
