import { HistoryStore } from "./history.js";
import { finishSchema, type Answer } from "./answer.js";
import { jsonSchema } from "./runtime.js";
import { runAlignment } from "./alignment.js";
import { randomUUID } from "node:crypto";
import { pinPlugin } from "./plugin-execution.js";
import { delegateResearch } from "./research.js";
import { delegateParcels } from "./parcel-extraction.js";
import { delegateMedia } from "./media.js";
import { projectObservation } from "./observations.js";
import { action } from "./protocol.js";
import type { AgentRequest, AgentResponse } from "./protocol.js";
import type { Agent } from "./agent.js";
import { context, contextBudget, ContextLimitError } from "./context.js";
import {
  ModelError,
  type ModelAdapter,
  type Message,
  type ModelMessage,
  type ToolDefinition,
} from "./model.js";
import { Stop, readOperations, type StopReason } from "./execution.js";
import { toolError, NotDispatchedError } from "./tool-errors.js";
const finishTool: ToolDefinition = {
  name: "finish_turn",
  description:
    "Pause with your natural reply and an explicit reason after completing any independent runnable work.",
  parameters: jsonSchema(finishSchema),
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
    private pluginModel?: (id: string) => ModelAdapter,
  ) {}
  async run(req: AgentRequest): Promise<AgentResponse> {
    if (req.pluginModel && (!req.specialist || !this.pluginModel))
      throw new Error("Plugin model override is unavailable");
    const model = req.pluginModel
      ? this.pluginModel!(req.pluginModel)
      : req.specialist === "media" && this.specialists.media
        ? this.specialists.media
        : this.model;
    const execution = req.execution;
    if (!execution || !req.execute || !req.signal)
      throw new Error("Owner-scoped execution is required");
    const messages = [
      ...(req.history as Message[]),
      { role: "user", content: req.message } as Message,
    ];
    let tools = [...(req.runtime?.tools ?? []), finishTool];
    let enabled = new Set(tools.map((t) => t.name));
    const undeliveredMessageIndices: number[] = [];
    const histories = new HistoryStore(execution.db);
    const suppress = async (indices: number[]) => {
      undeliveredMessageIndices.push(...indices);
      await histories.excludeFromContext(
        execution.user,
        execution.run,
        indices,
      );
    };
    const steer = async () => {
      if (req.signal!.aborted) throw new Stop("cancelled");
      if (!req.shouldYield?.()) return false;
      if (!req.steer) throw new Stop("interrupted");
      const inputs = await req.steer();
      for (const input of inputs) {
        messages.push({ role: "user", content: input.message });
        await execution.db.query(
          "UPDATE conversation_inputs SET message_index=$4 WHERE id=$1 AND user_id=$2 AND run_id=$3 AND state='running'",
          [input.id, execution.user, execution.run, messages.length - 1],
        );
      }
      if (inputs.length) req.message = inputs.at(-1)!.message;
      await execution.checkpoint(messages);
      if (inputs.length)
        await execution.trace("input.checkpointed", {
          inputs: inputs.map((input, index) => ({
            inputId: input.id,
            messageIndex: messages.length - inputs.length + index,
          })),
        });
      return true;
    };
    let answer: Answer | undefined;
    let reply = "",
      reason: StopReason = "answer";
    const prepareReply = async (indices: number[]) => {
      const approval =
        reason === "answer" &&
        (
          await execution.db.query(
            "SELECT 1 FROM approvals WHERE user_id=$1 AND run_id=$2 AND status='pending' AND expires_at>now() LIMIT 1",
            [execution.user, execution.run],
          )
        ).rows.length;
      // The final journal/approval lookups can receive input too. Keep the full
      // response in this run, but omit any undelivered assistant text from chat.
      if (req.shouldYield?.() || req.signal!.aborted) {
        await suppress(indices);
        answer = undefined;
        reply = "";
        reason = "answer";
        await steer();
        return true;
      }
      if (approval) reason = "awaiting_approval";
      return false;
    };
    await execution.checkpoint(messages);
    try {
      turn: while (true) {
        if (await steer()) continue;
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
            tools = [...(req.runtime?.tools ?? []), finishTool];
            enabled = new Set(tools.map((t) => t.name));
            const input = context(
              {
                ...req,
                runtime: { context: req.runtime?.context ?? "", tools },
              },
              // Undelivered finals remain in the immutable journal, but must not
              // look like something the user already heard in subsequent context.
              messages.filter(
                (_, index) => !undeliveredMessageIndices.includes(index),
              ),
            );
            await execution.trace("context.selected", {
              fixedSize: input.fixedSize,
              reservedSize: input.reservedSize,
              exchangeSize: input.exchangeSize,
              workingSize: input.workingSize,
              compacted: input.compacted,
              omitted: input.omitted,
              messageCount: input.messages.length,
              inputCharacters:
                JSON.stringify(omitImages(input.messages)).length +
                JSON.stringify(tools).length,
            });
            if (input.omitted)
              await execution.trace("context.omitted", {
                messages: input.omitted,
              });
            if (input.overBudget)
              await execution.trace("context.over_budget", {
                fixedSize: input.fixedSize,
                reservedSize: input.reservedSize,
                budget: contextBudget,
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
            // Context/journal writes are await points, so recheck before starting a model.
            if (req.signal.aborted) throw new Stop("cancelled");
            if (req.shouldYield?.()) continue turn;
            generation = await model.generate({
              messages: input.messages,
              tools,
              reasoning: "medium",
              sessionId: req.runId,
              signal: AbortSignal.any([
                req.signal,
                ...(req.modelSignal ? [req.modelSignal] : []),
                AbortSignal.timeout(Math.max(1, remaining)),
              ]),
            });
            // Save the complete model response before dispatching any requested operation.
            messages.push(generation.message);
            await execution.checkpoint(
              messages,
              req.managedDelivery && !generation.message.tool_calls?.length
                ? [messages.length - 1]
                : [],
            );
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
                : error instanceof ContextLimitError
                  ? { contextSizes: error.sizes, budget: contextBudget }
                  : {
                      // Bounded error identity; no user content is parsed on this path.
                      error:
                        error instanceof Error
                          ? `${error.name}: ${error.message.slice(0, 300)}`
                          : "unknown",
                    }),
              attempt,
              latencyMs: Date.now() - start,
            });
            if (req.signal.aborted) throw new Stop("cancelled");
            if (req.shouldYield?.()) continue turn;
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
        const calls = generation.message.tool_calls ?? [];
        const skipCalls = async (from: number, journal?: string) => {
          const result = {
            error:
              "Not dispatched: newer input or cancellation interrupted this turn",
            code: "NOT_DISPATCHED",
          };
          if (journal) await execution.endCall(journal, result, "interrupted");
          for (const pending of calls.slice(from))
            messages.push({
              role: "tool",
              tool_call_id: pending.id,
              content: JSON.stringify(result),
            });
          await execution.checkpoint(messages);
        };
        if (req.shouldYield?.() || req.signal.aborted) {
          if (calls.length) await skipCalls(0);
          else await suppress([messages.length - 1]);
          await steer();
          continue;
        }
        if (calls.length && generation.message.content && req.progress) {
          try {
            await req.progress(generation.message.content);
          } catch {
            await execution.trace("delivery.progress_failed", {});
          }
        }
        if (!calls.length) {
          reply = generation.message.content ?? "";
          if (await prepareReply([messages.length - 1])) continue;
          break;
        }
        let finish: (Answer & { reason: StopReason }) | undefined;
        let finishObservation: string | undefined;
        for (const [callIndex, call] of calls.entries()) {
          if (req.shouldYield?.() || req.signal.aborted) {
            await skipCalls(callIndex);
            await steer();
            continue turn;
          }
          const op = call.function.name;
          let result: unknown;
          let candidate: typeof finish;
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
            // Budget/journal writes above are await points; check again before actual dispatch.
            if (req.shouldYield?.() || req.signal.aborted)
              throw new NotDispatchedError(
                req.signal.aborted ? "cancelled" : "interrupted",
              );
            if (!enabled.has(op)) throw new Error("Operation unavailable");
            const args = JSON.parse(call.function.arguments);
            if (op === "finish_turn") {
              candidate = finishSchema.parse(args);
              const { reason: _reason, ...envelope } = candidate;
              result = { recorded: true, answer: envelope };
            } else {
              if (Object.hasOwn(args, "operation"))
                throw new Error("Operation must come from the tool name");
              const input = action.parse({ ...args, operation: op });
              for (let attempt = 0; ; attempt++) {
                try {
                  if (req.shouldYield?.() || req.signal.aborted)
                    throw new NotDispatchedError(
                      req.signal.aborted ? "cancelled" : "interrupted",
                    );
                  dispatched = true;
                  result =
                    op === "plugin_delegate"
                      ? await (async () => {
                          if (req.specialist)
                            throw new Error(
                              "Plugin validation: recursive delegation is unavailable",
                            );
                          if (input.operation !== "plugin_delegate")
                            throw new Error(
                              "Plugin validation: invalid assignment",
                            );
                          const {
                            agentId,
                            operation,
                            emailTargets,
                            ...assignment
                          } = input;
                          const definition = await pinPlugin(
                            execution,
                            agentId,
                          );
                          if (definition.contract === "parcel-extraction/v1")
                            return delegateParcels(
                              req,
                              input,
                              (child) => this.run(child),
                              definition,
                            );
                          if (emailTargets)
                            throw new Error(
                              "Plugin validation: public research cannot receive private email targets",
                            );
                          return delegateResearch(
                            req,
                            { ...assignment, operation: "research_delegate" },
                            (child) => this.run(child),
                            definition,
                          );
                        })()
                      : op === "research_delegate"
                        ? await delegateResearch(req, input, (child) =>
                            this.run(child),
                          )
                        : [
                              "job_alignment_start",
                              "job_alignment_resume",
                              "job_alignment_read",
                            ].includes(op)
                          ? await runAlignment(req, input, (child) =>
                              this.run(child),
                            )
                          : op === "media_delegate"
                            ? await delegateMedia(
                                req,
                                input,
                                (child) => this.run(child),
                                (this.specialists.media ?? this.model).model ??
                                  "",
                              )
                            : await req.execute(input);
                  if (
                    op === "research_report" ||
                    op === "parcel_report" ||
                    op === "media_report" ||
                    op === "job_alignment_report"
                  )
                    candidate = {
                      reply: JSON.stringify(result),
                      reason: "answer",
                    };
                  break;
                } catch (error) {
                  // Only retry known transient reads; all writes have a single dispatch.
                  if (
                    !readOperations.has(op) ||
                    op === "research_delegate" ||
                    op === "plugin_delegate" ||
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
            if (candidate) {
              finish = candidate;
              finishObservation = op === "finish_turn" ? journal : undefined;
            }
          } catch (error) {
            if (error instanceof NotDispatchedError) {
              await skipCalls(callIndex, journal);
              if (error.reason === "cancelled") throw new Stop("cancelled");
              continue turn;
            }
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
          req.afterTool?.(op);
        }
        if (await steer()) continue;
        if (finish) {
          answer = finish;
          reply = finish.reply;
          reason = finish.reason;
          const replyIndex = messages.length;
          messages.push({ role: "assistant", content: reply });
          if (
            finishObservation &&
            (finish.canvases?.length ||
              finish.sections?.length ||
              finish.records?.length ||
              finish.sources?.length ||
              finish.numbers?.length ||
              reply.length > 1800)
          ) {
            // A separate compact group survives omission of the large finish call/reply.
            messages.push({
              role: "assistant",
              content: `[Saved answer details: observationId=${finishObservation}. Use observation_read with offsets to retrieve the original answer envelope for follow-up questions.]`,
            });
          }
          await execution.checkpoint(
            messages,
            req.managedDelivery
              ? messages.flatMap((message, index) =>
                  index >= replyIndex && message.role === "assistant"
                    ? [index]
                    : [],
                )
              : [],
          );
          if (
            await prepareReply(
              messages.flatMap((message, index) =>
                index >= replyIndex && message.role === "assistant"
                  ? [index]
                  : [],
              ),
            )
          )
            continue;
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
        reason === "interrupted"
          ? ""
          : reason === "budget_exhausted"
            ? "The execution budget is used up. Completed results are saved. Use /status to inspect progress and /continue to grant another allocation."
            : reason === "cancelled"
              ? "Cancelled. Completed actions remain recorded."
              : error instanceof ContextLimitError
                ? "This request exceeds the context limit while preserving our current exchange. Please narrow the active batch; your messages and saved results are retained."
                : error instanceof ModelError
                  ? error.message
                  : "Execution stopped after an error. Saved results are retained; inspect /status before continuing.";
    }
    await execution.finish(reason);
    return {
      ...answer,
      reply,
      history: messages,
      stopReason: reason,
      ...(undeliveredMessageIndices.length
        ? { undeliveredMessageIndices }
        : {}),
    };
  }
}
