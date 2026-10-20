import { HistoryStore } from "./history.js";
import { finishSchema, type Answer } from "./answer.js";
import { jsonSchema } from "./runtime.js";
import { runAlignment } from "./alignment.js";
import { randomUUID } from "node:crypto";
import { runAgentType } from "./agents.js";
import { resolveAgentModel } from "./model-policy.js";
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
  type ReasoningEffort,
  type ToolDefinition,
} from "./model.js";
import { Stop, readOperations, type StopReason } from "./execution.js";
import {
  toolError,
  NotDispatchedError,
  RepeatedFailureError,
  WriteBlockedError,
} from "./tool-errors.js";
/** Model steps, with no successful call between them, in which one call form failed the same way before it is refused. */
const REPEAT_LIMIT = 3;
/** An operation plus its argument names: listing without an id is a different form than reading one. */
function callForm(op: string, raw: string) {
  try {
    const args = JSON.parse(raw);
    return `${op}(${args && typeof args === "object" ? Object.keys(args).sort().join(",") : ""})`;
  } catch {
    return `${op}(?)`;
  }
}
import { domainOf } from "./tool-domains.js";
import { runFamily } from "./run-family.js";
import { higher as higherEffort } from "./effort.js";
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
/** Character size of each top-level runtime-context key; never the values themselves. */
export function runtimeParts(context: string | undefined) {
  try {
    const parsed = JSON.parse(context ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [
        key,
        JSON.stringify(value)?.length ?? 0,
      ]),
    );
  } catch {
    return undefined;
  }
}
export class CustomAgent implements Agent {
  constructor(
    private model: ModelAdapter,
    private specialists: { media?: ModelAdapter } = {},
    private modelFor?: (id: string) => ModelAdapter,
  ) {}
  async run(req: AgentRequest): Promise<AgentResponse> {
    if (req.childModel && !req.specialist)
      throw new Error("Only agent runs can select a model");
    // A child uses its host-resolved model, or the default agent tier (Flash when configured).
    // A runtime built without a model factory runs every agent on its one model.
    const childModel = !this.modelFor
      ? undefined
      : (req.childModel ??
        (req.specialist &&
        !(req.specialist === "media" && this.specialists.media)
          ? resolveAgentModel(undefined, this.model.model ?? "").model
          : undefined));
    const model =
      childModel && childModel !== this.model.model
        ? this.modelFor!(childModel)
        : req.specialist === "media" && this.specialists.media && !childModel
          ? this.specialists.media
          : this.model;
    // Raised mid-turn by req.escalateEffort; never lowered within a turn.
    let effort = req.effort ?? "medium";
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
    // Per call form: the last failure code, in how many model steps it recurred since the last success,
    // and the step that last counted. A model that keeps retrying the same failing form
    // is refused instead of looping; parallel calls in one step count once.
    const failures = new Map<
      string,
      { code: string; count: number; step: number }
    >();
    let step = 0;
    // Set when the host refuses a write because an earlier write's outcome is uncertain.
    // That refusal holds for the rest of this turn: later writes are refused without
    // dispatch, and a successful read in between does not reset it.
    let writesBlocked = "";
    // Turn progress for effort escalation: counts and tool names only.
    let toolCalls = 0,
      failedCalls = 0;
    const toolsUsed = new Set<string>();
    let pendingEffort: Promise<ReasoningEffort | undefined> | undefined;
    // Starts an effort question for the next model call. A pending answer is kept: the
    // higher of the two applies, so a raise is never lost.
    const askEffort = (followUp = false) => {
      if (!req.escalateEffort || effort === "high") return;
      const earlier = pendingEffort;
      const asked = req
        .escalateEffort({
          step,
          toolCalls,
          failedCalls,
          tools: [...toolsUsed],
          current: effort,
          ...(followUp ? { followUp: true } : {}),
        })
        .catch(() => undefined);
      pendingEffort = earlier
        ? Promise.all([earlier, asked]).then(([a, b]) =>
            a && b ? higherEffort(a, b) : (a ?? b),
          )
        : asked;
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
      if (inputs.length) {
        req.message = inputs.at(-1)!.message;
        // New owner input (for example the id the model asked for) can make a refused form valid.
        failures.clear();
        // An absorbed follow-up can be harder than the message the effort was picked for.
        askEffort(true);
      }
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
            `SELECT 1 FROM approvals WHERE user_id=$1 AND run_id IN ${runFamily()} AND status='pending' AND expires_at>now() LIMIT 1`,
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
    // context.over_budget is reported once per turn, not on every model call.
    let overBudgetReported = false;
    try {
      turn: while (true) {
        if (await steer()) {
          // Newer owner input arrived first: the host's first step was for an older message.
          req.firstCall = undefined;
          continue;
        }
        let generation;
        let invocationId = "";
        const first = req.firstCall;
        req.firstCall = undefined;
        if (first) {
          // The host already knows the first step; save the model call that would only make it.
          invocationId = randomUUID();
          generation = {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `host_${invocationId.replaceAll("-", "").slice(0, 24)}`,
                  type: "function",
                  function: { name: first.name, arguments: first.arguments },
                },
              ],
            } as Message,
          };
          messages.push(generation.message);
          await execution.checkpoint(messages);
          await execution.trace("route.first_call", {
            invocationId,
            operation: first.name,
            reason: first.reason,
          });
        }
        for (let attempt = 0; !first; attempt++) {
          // Asked while the previous step's tools ran; it delays this call only when the
          // tools finished first (at most the decision's timeout).
          if (pendingEffort) {
            const raised = await pendingEffort;
            pendingEffort = undefined;
            if (raised) effort = higherEffort(effort, raised);
          }
          const remaining = await execution.consume("models");
          const start = Date.now();
          invocationId = randomUUID();
          try {
            await execution.trace("model.started", {
              invocationId,
              model: model.model ?? null,
              attempt,
              effort,
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
              fixedParts: input.fixedParts,
              // Sizes only (characters per top-level key), for measuring the runtime state.
              runtimeParts: runtimeParts(req.runtime?.context),
              reservedSize: input.reservedSize,
              exchangeSize: input.exchangeSize,
              workingSize: input.workingSize,
              trimmed: input.trimmed,
              compacted: input.compacted,
              wireCompacted: input.wireCompacted,
              serializedSize: input.serializedSize,
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
            if (input.overBudget && !overBudgetReported) {
              overBudgetReported = true;
              await execution.trace("context.over_budget", {
                fixedSize: input.fixedSize,
                reservedSize: input.reservedSize,
                exchangeSize: input.exchangeSize,
                workingSize: input.workingSize,
                budget: contextBudget,
                reason:
                  input.fixedSize >= contextBudget ? "fixed" : "protected",
              });
            }
            if (req.specialist)
              await execution.trace("research.model_input", {
                version: 1,
                invocationId,
                messages: omitImages(input.messages),
                tools,
                reasoning: effort,
                model: model.model ?? null,
                omitted: input.omitted,
              });
            // Context/journal writes are await points, so recheck before starting a model.
            if (req.signal.aborted) throw new Stop("cancelled");
            if (req.shouldYield?.()) continue turn;
            generation = await model.generate({
              messages: input.messages,
              tools,
              reasoning: effort,
              sessionId: req.runId,
              ...(req.cacheKey ? { cacheKey: req.cacheKey } : {}),
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
              effort,
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
        if (!generation) throw new Error("No model response");
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
        step++;
        // A step that only finishes the turn has no next model call to raise.
        const working = calls.some((c) => c.function.name !== "finish_turn");
        const failedBefore = failedCalls;
        if (working) askEffort();
        for (const [callIndex, call] of calls.entries()) {
          if (req.shouldYield?.() || req.signal.aborted) {
            await skipCalls(callIndex);
            await steer();
            continue turn;
          }
          const op = call.function.name;
          const form = callForm(op, call.function.arguments);
          let result: unknown;
          let candidate: typeof finish;
          const start = Date.now();
          if (req.signal.aborted) throw new Stop("cancelled");
          if (op.startsWith("work_") && op !== "work_status")
            await execution.attach(true);
          await execution.consume("tools");
          if (op !== "finish_turn") {
            toolCalls++;
            toolsUsed.add(op);
          }
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
            const repeated = failures.get(form);
            // Refuse from the next step on, never the rest of the step that reached the limit.
            if (
              repeated &&
              repeated.count >= REPEAT_LIMIT &&
              repeated.step !== step
            )
              throw new RepeatedFailureError(op, repeated.code, repeated.count);
            // A new delegation could only retry the refused writes in another context.
            if (
              writesBlocked &&
              op !== "finish_turn" &&
              (!readOperations.has(op) || op === "agent_run")
            )
              throw new WriteBlockedError(writesBlocked);
            if (!enabled.has(op)) {
              // A known tool whose domain is not loaded yet: load the domain and
              // dispatch. Arguments are still validated and the owner-scoped
              // dispatcher still decides; offering a schema grants nothing.
              const domain = domainOf(op);
              if (req.loadTools && domain) {
                await req.loadTools([domain]);
                tools = [...(req.runtime?.tools ?? []), finishTool];
                enabled = new Set(tools.map((t) => t.name));
              }
              if (!enabled.has(op)) throw new Error("Operation unavailable");
            }
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
                    op === "agent_run"
                      ? await runAgentType(
                          req,
                          input,
                          (child) => this.run(child),
                          this.model.model ?? "",
                        )
                      : [
                            "job_alignment_start",
                            "job_alignment_resume",
                            "job_alignment_read",
                          ].includes(op)
                        ? await runAlignment(req, input, (child) =>
                            this.run(child),
                          )
                        : op === "tools_load"
                          ? await (async () => {
                              if (!req.loadTools)
                                throw new Error("Operation unavailable");
                              return req.loadTools(
                                (input as { domains: string[] }).domains,
                              );
                            })()
                          : await req.execute(input);
                  if (
                    op === "research_report" ||
                    op === "media_report" ||
                    op === "job_alignment_report" ||
                    op === "agent_report"
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
                    op === "agent_run" ||
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
            if (
              op === "agent_run" &&
              !writesBlocked &&
              (result as { writesBlocked?: boolean })?.writesBlocked
            )
              writesBlocked =
                "A delegated agent's write was refused because an earlier write's outcome is uncertain";
            // Any success is progress and may supply what a failing form lacked
            // (such as an id from parcel_match), so every count starts again.
            failures.clear();
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
            if (error instanceof WriteBlockedError && !writesBlocked)
              writesBlocked = error.message;
            // finish_turn stays available: refusing it would leave no way to answer.
            if (
              op !== "finish_turn" &&
              !(error instanceof RepeatedFailureError)
            ) {
              const code = (result as any).error.code as string;
              const last = failures.get(form);
              failures.set(form, {
                code,
                step,
                count:
                  last?.code !== code
                    ? 1
                    : last.step === step
                      ? last.count
                      : last.count + 1,
              });
            }
            const uncertain =
              dispatched &&
              op !== "finish_turn" &&
              !readOperations.has(op) &&
              ["RESULT_UNRECORDED", "TOOL_FAILED"].includes(
                (result as any).error.code,
              );
            if (op !== "finish_turn") failedCalls++;
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
        // A failure in this step asks again now, so the recovering call can run higher.
        if (working && failedCalls > failedBefore && !finish) askEffort();
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
                ? "I reached an internal context limit before I could finish. Your messages and retrieved results are saved; the request was not completed."
                : error instanceof ModelError
                  ? error.message
                  : execution.trackedTaskId
                    ? `Execution stopped after an error. Saved results are retained; inspect /status ${execution.trackedTaskId} before continuing this task.`
                    : "This request stopped after an error. It was not completed; saved results remain. Ask for help before repeating any write.";
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
