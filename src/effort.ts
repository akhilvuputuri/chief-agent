// Reasoning effort per foreground message. TypeSafe's Jev answers one choice question
// (low, medium or high) before the first model call, and again as the turn grows, so a
// message that turns out harder can raise effort mid-turn. Effort never falls within a
// turn. Every failure keeps the current effort, so Jev can never block a reply.
// config/reasoning-effort.json holds the question, thresholds and escalation policy.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ReasoningEffort } from "./model.js";
import { REASONING_EFFORTS } from "./model.js";
import type { Spending } from "./spending.js";
import type { PickerTurn } from "./tool-picker.js";

const text = z.string().min(1).max(2000);
const count = z.number().int().positive();
const probability = z.number().min(0).max(1);
const schema = z
  .object({
    schemaVersion: z.literal(1),
    model: z.string().regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/),
    timeoutMs: count,
    state: z
      .object({
        previousTurns: z.number().int().min(0),
        messageChars: count,
        previousUserChars: count,
        assistantChars: count,
      })
      .strict(),
    question: z
      .object({
        instructions: text,
        criteria: z.object({ low: text, medium: text, high: text }).strict(),
      })
      .strict(),
    // The lowest probability at which Jev's low or high pick is applied; otherwise medium.
    apply: z.object({ low: probability, high: probability }).strict(),
    // Ask again from this model step, then every `every` steps, and after a new tool failure.
    escalation: z
      .object({ firstStep: count, every: count, onFailure: z.boolean() })
      .strict(),
  })
  .strict();
export type EffortConfig = z.infer<typeof schema>;

export function readEffortConfig(
  url: URL = new URL("../config/reasoning-effort.json", import.meta.url),
): EffortConfig {
  return schema.parse(JSON.parse(readFileSync(url, "utf8")));
}

/** What the turn has done so far, sent with an escalation question. No arguments or results. */
export type EffortProgress = {
  step: number;
  toolCalls: number;
  failedCalls: number;
  tools: string[];
  current: ReasoningEffort;
  /** A follow-up was absorbed into the turn; `latest_user_message` is that follow-up. */
  followUp?: boolean;
};

export type EffortDecision = {
  ok: boolean;
  /** Jev's own pick, before the thresholds. */
  choice?: ReasoningEffort;
  probabilities?: Partial<Record<ReasoningEffort, number>>;
  /** The effort the turn uses after this decision. */
  applied: ReasoningEffort;
  latencyMs: number;
  costUsd: number | null;
  model: string | null;
  error?: string;
};

const rank = (e: ReasoningEffort) => REASONING_EFFORTS.indexOf(e);
export const higher = (a: ReasoningEffort, b: ReasoningEffort) =>
  rank(b) > rank(a) ? b : a;

/** Whether to ask again before the next model call. Pure, so the policy is testable. */
export function shouldEscalate(
  config: EffortConfig,
  progress: EffortProgress,
  lastAsked: { step: number; failedCalls: number },
) {
  if (progress.current === "high") return false;
  if (progress.followUp) return true;
  const { firstStep, every, onFailure } = config.escalation;
  if (onFailure && progress.failedCalls > lastAsked.failedCalls) return true;
  return (
    progress.step >= firstStep &&
    (progress.step - firstStep) % every === 0 &&
    progress.step !== lastAsked.step
  );
}

export class EffortPicker {
  constructor(
    private key: string,
    readonly config: EffortConfig = readEffortConfig(),
    private transport: typeof fetch = fetch,
  ) {}

  /**
   * One decision. Without `progress` it is the message's starting effort; with it, an
   * escalation that can only raise `progress.current`. Never throws.
   */
  async decide(
    input: {
      message: string;
      previous: PickerTurn[];
      progress?: EffortProgress;
    },
    ledger?: Spending,
  ): Promise<EffortDecision> {
    const floor = input.progress?.current ?? "low";
    const fallback = input.progress?.current ?? "medium";
    const s = this.config.state;
    const started = Date.now();
    let charge: string | undefined;
    const settle = (usage: unknown) =>
      charge ? ledger!.settle(charge, usage).catch(() => {}) : undefined;
    const failed = (error: string) => ({
      ok: false,
      applied: fallback,
      latencyMs: Date.now() - started,
      costUsd: null,
      model: null,
      error,
    });
    try {
      charge = await ledger
        ?.begin("openrouter-jev", 0.001)
        .catch(() => undefined);
      const state = {
        latest_user_message: input.message.slice(0, s.messageChars),
        previous_turns: (s.previousTurns
          ? input.previous.slice(-s.previousTurns)
          : []
        ).map((t) => ({
          user: t.user.slice(0, s.previousUserChars),
          assistant: t.assistant.slice(0, s.assistantChars),
        })),
        ...(input.progress
          ? {
              turn_progress: {
                model_steps: input.progress.step,
                tool_calls: input.progress.toolCalls,
                failed_tool_calls: input.progress.failedCalls,
                tools_used: input.progress.tools.slice(0, 20),
                current_effort: input.progress.current,
                ...(input.progress.followUp
                  ? { absorbed_follow_up: true }
                  : {}),
              },
            }
          : {}),
      };
      const response = await this.transport(
        "https://openrouter.ai/api/alpha/decisions",
        {
          method: "POST",
          signal: AbortSignal.timeout(this.config.timeoutMs),
          headers: {
            Authorization: `Bearer ${this.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.model,
            state,
            questions: {
              effort: {
                type: "choice",
                instructions: this.config.question.instructions,
                criteria: this.config.question.criteria,
              },
            },
          }),
        },
      );
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500)
          await settle({ cost: 0 });
        return failed(`http_${response.status}`);
      }
      const data: any = await response.json();
      await settle(data?.usage);
      const choice = data?.answers?.effort?.choice;
      const raw = data?.answers?.effort?.probabilities;
      const p = raw?.[choice];
      if (
        !REASONING_EFFORTS.includes(choice) ||
        typeof p !== "number" ||
        !(p >= 0 && p <= 1)
      )
        return failed("invalid");
      const probabilities: Partial<Record<ReasoningEffort, number>> = {};
      for (const e of REASONING_EFFORTS)
        if (typeof raw[e] === "number" && raw[e] >= 0 && raw[e] <= 1)
          probabilities[e] = Math.round(raw[e] * 10_000) / 10_000;
      const picked: ReasoningEffort =
        choice === "low" && p >= this.config.apply.low
          ? "low"
          : choice === "high" && p >= this.config.apply.high
            ? "high"
            : "medium";
      const cost = data?.usage?.cost;
      return {
        ok: true,
        choice,
        probabilities,
        applied: input.progress ? higher(floor, picked) : picked,
        latencyMs: Date.now() - started,
        costUsd:
          typeof cost === "number" && Number.isFinite(cost) ? cost : null,
        model: typeof data?.model === "string" ? data.model : null,
      };
    } catch (error) {
      return failed(
        (error as Error)?.name === "TimeoutError" ? "timeout" : "failed",
      );
    }
  }
}
