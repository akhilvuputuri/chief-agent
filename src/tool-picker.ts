// Tool-group picker (issue #77 stage 3). Once per user message, TypeSafe's Jev
// decision model answers one yes/no question per tool domain; domains that
// score high are offered to the coordinator. A missed domain costs one
// tools_load step, so every failure falls back instead of blocking the turn.
// config/tool-picker.json is shared with the Python eval in evals/picker/,
// which implements the same state, question and pick contract.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Message } from "./model.js";
import type { Spending } from "./spending.js";
import { TOOL_DOMAINS, type ToolDomain } from "./tool-domains.js";

const text = z.string().min(1).max(2000);
const count = z.number().int().positive();
const probability = z.number().min(0).max(1);
const schema = z
  .object({
    schemaVersion: z.literal(1),
    model: z.string().regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/),
    threshold: probability,
    cap: count,
    fallbackMin: probability,
    timeoutMs: count,
    pauseAfterRateLimitMs: count,
    state: z
      .object({
        previousTurns: z.number().int().min(0),
        messageChars: count,
        previousUserChars: count,
        assistantChars: count,
      })
      .strict(),
    question: z
      .object({ instructions: text, true: text, false: text })
      .strict(),
    alwaysAvailable: text,
    domains: z
      .object(
        Object.fromEntries(
          TOOL_DOMAINS.map((d) => [
            d,
            z.object({ description: text, examples: text }).strict(),
          ]),
        ) as Record<
          ToolDomain,
          z.ZodObject<{ description: typeof text; examples: typeof text }>
        >,
      )
      .strict(),
  })
  .strict();

export type PickerConfig = z.infer<typeof schema>;

export function readPickerConfig(
  url: URL = new URL("../config/tool-picker.json", import.meta.url),
): PickerConfig {
  try {
    return schema.parse(JSON.parse(readFileSync(url, "utf8")));
  } catch (error) {
    throw new Error("Invalid bundled tool picker config", { cause: error });
  }
}

/** First n Unicode code points, matching Python slicing in the eval. */
function clip(value: string, n: number) {
  const points = [...value];
  return points.length > n ? points.slice(0, n).join("") : value;
}

export interface PickerTurn {
  user: string;
  assistant: string;
  tools: string[];
}

export interface PickerInput {
  message: string;
  previous: PickerTurn[];
  pendingApprovals: string[];
  activeTask: string | null;
  recentTools: string[];
}

/** What Jev sees: recent text and tool names only, never tool outputs. */
export function pickerState(config: PickerConfig, input: PickerInput) {
  const limits = config.state;
  return {
    latest_user_message: clip(input.message, limits.messageChars),
    previous_turns: (limits.previousTurns
      ? input.previous.slice(-limits.previousTurns)
      : []
    ).map((turn) => ({
      user: clip(turn.user, limits.previousUserChars),
      assistant: clip(turn.assistant, limits.assistantChars),
      tools_used: [...turn.tools],
    })),
    pending_approvals: [...input.pendingApprovals],
    active_background_task: input.activeTask,
    tools_used_last_hour: [...new Set(input.recentTools)],
    always_available: config.alwaysAvailable,
  };
}

export function pickerQuestions(
  config: PickerConfig,
  domains: Iterable<ToolDomain>,
) {
  const asked = new Set(domains);
  return Object.fromEntries(
    TOOL_DOMAINS.filter((d) => asked.has(d)).map((d) => [
      d,
      {
        type: "noul",
        instructions: config.question.instructions.replaceAll("{domain}", d),
        criteria: {
          true: config.question.true
            .replaceAll("{description}", config.domains[d].description)
            .replaceAll("{examples}", config.domains[d].examples),
          false: config.question.false,
        },
      },
    ]),
  );
}

/**
 * Domains at or above the threshold, highest first, up to the cap. When none
 * qualifies, the single best domain if it reaches the fallback floor.
 */
export function pickDomains(
  probabilities: Record<string, unknown>,
  config: Pick<PickerConfig, "threshold" | "cap" | "fallbackMin">,
  domains: Iterable<ToolDomain> = TOOL_DOMAINS,
): ToolDomain[] {
  const asked = new Set(domains);
  const scored = TOOL_DOMAINS.flatMap((d) => {
    const p = probabilities[d];
    return asked.has(d) && typeof p === "number" && Number.isFinite(p)
      ? [{ d, p }]
      : [];
  }).sort((a, b) => b.p - a.p); // stable: ties keep canonical order
  const picked = scored
    .filter((x) => x.p >= config.threshold)
    .slice(0, config.cap);
  if (picked.length) return picked.map((x) => x.d);
  return scored[0] && scored[0].p >= config.fallbackMin ? [scored[0].d] : [];
}

/** The last user messages with the assistant's final reply and tool names. */
export function recentTurns(history: Message[]): PickerTurn[] {
  const turns: PickerTurn[] = [];
  for (const message of history) {
    if (message.role === "user")
      turns.push({ user: message.content ?? "", assistant: "", tools: [] });
    const turn = turns.at(-1);
    if (!turn || message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? [])
      if (!turn.tools.includes(call.function.name))
        turn.tools.push(call.function.name);
    if (message.content) turn.assistant = message.content;
  }
  return turns;
}

export type PickOutcome =
  | "picked"
  | "timeout"
  | "rate_limited"
  | "paused"
  | "rejected"
  | "failed"
  | "invalid";

export type PickResult =
  | {
      ok: true;
      domains: ToolDomain[];
      probabilities: Record<string, number>;
      latencyMs: number;
      costUsd: number | null;
      model: string | null;
    }
  | {
      ok: false;
      outcome: Exclude<PickOutcome, "picked">;
      latencyMs: number;
      httpStatus?: number;
    };

export class ToolPicker {
  private pausedUntil = 0;
  constructor(
    private key: string,
    readonly config: PickerConfig = readPickerConfig(),
    private transport: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  async pick(
    input: PickerInput,
    domains: Iterable<ToolDomain>,
    ledger?: Spending,
  ): Promise<PickResult> {
    const asked = [...domains];
    const start = this.now();
    const elapsed = () => Math.max(0, this.now() - start);
    if (!asked.length)
      return {
        ok: true,
        domains: [],
        probabilities: {},
        latencyMs: 0,
        costUsd: null,
        model: null,
      };
    // After a rate limit, skip Jev for a while rather than adding latency.
    if (start < this.pausedUntil)
      return { ok: false, outcome: "paused", latencyMs: 0 };
    let charge: string | undefined;
    // Usage accounting never decides the pick; its failures are ignored.
    const settle = (usage: unknown) =>
      charge ? ledger!.settle(charge, usage).catch(() => {}) : undefined;
    try {
      charge = await ledger?.begin("openrouter-jev", 0.001);
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
            state: pickerState(this.config, input),
            questions: pickerQuestions(this.config, asked),
          }),
        },
      );
      if (!response.ok) {
        // A definite HTTP rejection is not billed.
        await settle({ cost: 0 });
        if (response.status === 429)
          this.pausedUntil = this.now() + this.config.pauseAfterRateLimitMs;
        return {
          ok: false,
          outcome:
            response.status === 429
              ? "rate_limited"
              : [401, 402, 403].includes(response.status)
                ? "rejected"
                : "failed",
          latencyMs: elapsed(),
          httpStatus: response.status,
        };
      }
      const data: any = await response.json();
      await settle(data?.usage);
      const probabilities: Record<string, number> = {};
      for (const d of asked) {
        const p = data?.answers?.[d]?.noul;
        if (typeof p === "number" && p >= 0 && p <= 1) probabilities[d] = p;
      }
      // A partial answer would silently drop domains; fall back instead.
      if (Object.keys(probabilities).length !== asked.length)
        return { ok: false, outcome: "invalid", latencyMs: elapsed() };
      const cost = data?.usage?.cost;
      return {
        ok: true,
        domains: pickDomains(probabilities, this.config, asked),
        probabilities,
        latencyMs: elapsed(),
        costUsd:
          typeof cost === "number" && Number.isFinite(cost) ? cost : null,
        model: typeof data?.model === "string" ? data.model : null,
      };
    } catch (error) {
      return {
        ok: false,
        outcome:
          (error as Error)?.name === "TimeoutError" ? "timeout" : "failed",
        latencyMs: elapsed(),
      };
    }
  }
}
