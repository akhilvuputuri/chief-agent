// Shadow decisions (issue #127). For each foreground message the host asks Jev what it
// *would* decide, in parallel with the real turn, and records the prediction next to what
// actually happened. Nothing here changes the turn: no caller awaits a prediction, every
// failure is swallowed, and the record is written after the reply.
//
// The questions and thresholds come from config/decisions.json, which the offline eval
// (evals/decisions) reads too, so shadow data is comparable with the measured results.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Database } from "./db.js";
import { event } from "./db.js";
import type { Spending } from "./spending.js";
import type { PickerTurn } from "./tool-picker.js";
import { plugins } from "./plugin-registry.js";

const config = z
  .object({
    schemaVersion: z.literal(1),
    model: z.string().min(1),
    timeoutMs: z.number().int().positive(),
    shadow: z
      .object({
        continuity: z.boolean(),
        routing: z.boolean(),
        picker: z.boolean(),
      })
      .strict(),
    continuity: z
      .object({
        threshold: z.number().min(0).max(1),
        question: z.object({ type: z.literal("noul") }).passthrough(),
      })
      .strict(),
    routing: z
      .object({
        threshold: z.number().min(0).max(1),
        instructions: z.string().min(1),
        chief: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type DecisionConfig = z.infer<typeof config>;

export function readDecisionConfig(
  url: URL = new URL("../config/decisions.json", import.meta.url),
): DecisionConfig {
  return config.parse(JSON.parse(readFileSync(url, "utf8")));
}

export type ShadowInput = {
  message: string;
  /** Recent turns, oldest first, as the tool picker builds them. */
  previous: PickerTurn[];
  /** Agent types Chief can delegate to now, with their descriptions. */
  agents: { type: string; description: string }[];
};

type Prediction = {
  consumer: "continuity" | "routing";
  ok: boolean;
  /** continuity: drop or keep; routing: an agent type or chief. */
  decision?: string;
  score?: number;
  latencyMs: number;
  costUsd: number | null;
  model: string | null;
  error?: string;
};

export class ShadowDecisions {
  constructor(
    private key: string,
    readonly config: DecisionConfig = readDecisionConfig(),
    private transport: typeof fetch = fetch,
  ) {}

  /** Starts the shadow calls. The promise always resolves; it never delays the turn. */
  start(input: ShadowInput, ledger?: Spending): Promise<Prediction[]> {
    const last = input.previous.at(-1);
    const jobs: Promise<Prediction>[] = [];
    if (this.config.shadow.continuity && last)
      jobs.push(
        this.ask(
          "continuity",
          {
            previous_user_message: last.user.slice(0, 500),
            previous_assistant_reply: last.assistant.slice(0, 600),
            latest_user_message: input.message.slice(0, 2000),
          },
          { needs_previous: this.config.continuity.question },
          ledger,
          (answers) => {
            const p = answers?.needs_previous?.noul;
            if (typeof p !== "number") return null;
            return {
              decision: p < this.config.continuity.threshold ? "drop" : "keep",
              score: p,
            };
          },
        ),
      );
    if (this.config.shadow.routing && input.agents.length)
      jobs.push(
        this.ask(
          "routing",
          {
            latest_user_message: input.message.slice(0, 2000),
            previous_turns: input.previous.slice(-2).map((t) => ({
              user: t.user.slice(0, 500),
              assistant: t.assistant.slice(0, 300),
            })),
          },
          {
            agent: {
              type: "choice",
              instructions: this.config.routing.instructions,
              criteria: {
                ...Object.fromEntries(
                  input.agents.map((a) => [a.type, a.description]),
                ),
                chief: this.config.routing.chief,
              },
            },
          },
          ledger,
          (answers) => {
            const agent = answers?.agent?.choice;
            const p = answers?.agent?.probabilities?.[agent];
            if (typeof agent !== "string" || typeof p !== "number") return null;
            return {
              decision:
                agent !== "chief" && p >= this.config.routing.threshold
                  ? agent
                  : "chief",
              score: p,
            };
          },
        ),
      );
    return Promise.all(jobs);
  }

  private async ask(
    consumer: Prediction["consumer"],
    state: unknown,
    questions: unknown,
    ledger: Spending | undefined,
    read: (answers: any) => { decision: string; score: number } | null,
  ): Promise<Prediction> {
    const started = Date.now();
    let charge: string | undefined;
    const settle = (usage: unknown) =>
      charge ? ledger!.settle(charge, usage).catch(() => {}) : undefined;
    try {
      charge = await ledger
        ?.begin("openrouter-jev", 0.001)
        .catch(() => undefined);
      const response = await this.transport(
        "https://openrouter.ai/api/alpha/decisions",
        {
          method: "POST",
          signal: AbortSignal.timeout(this.config.timeoutMs),
          headers: {
            Authorization: `Bearer ${this.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: this.config.model, state, questions }),
        },
      );
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500)
          await settle({ cost: 0 });
        return {
          consumer,
          ok: false,
          latencyMs: Date.now() - started,
          costUsd: null,
          model: null,
          error: `http_${response.status}`,
        };
      }
      const data: any = await response.json();
      await settle(data?.usage);
      const answer = read(data?.answers);
      const cost = data?.usage?.cost;
      return {
        consumer,
        ok: !!answer,
        ...(answer ?? { error: "invalid" }),
        latencyMs: Date.now() - started,
        costUsd:
          typeof cost === "number" && Number.isFinite(cost) ? cost : null,
        model: typeof data?.model === "string" ? data.model : null,
      };
    } catch (error) {
      return {
        consumer,
        ok: false,
        latencyMs: Date.now() - started,
        costUsd: null,
        model: null,
        error: (error as Error)?.name === "TimeoutError" ? "timeout" : "failed",
      };
    }
  }

  /**
   * After the reply: records each prediction with what Chief actually did in this turn
   * (and its agent children), plus the picker check. Never throws.
   */
  async record(
    db: Database,
    user: string,
    run: string,
    predictions: Prediction[],
    turn: { interrupted: boolean; stopReason: string; messages: number } = {
      interrupted: false,
      stopReason: "answer",
      messages: 1,
    },
    typeName: (type: string) => string = catalogueType,
  ) {
    try {
      const calls = (
        await db.query(
          `SELECT c.operation,c.arguments,c.state FROM runtime_calls c WHERE c.run_id=$1`,
          [run],
        )
      ).rows as { operation: string; arguments: any; state: string }[];
      // Only delegations that actually ran: refused, failed and never-dispatched calls are not.
      const delegated = calls
        .filter((c) => c.operation === "agent_run" && c.state === "success")
        .map((c) => {
          try {
            return typeName(
              String(JSON.parse(c.arguments?.raw ?? "{}").type ?? ""),
            );
          } catch {
            return "";
          }
        })
        .filter(Boolean);
      const recalled = calls.filter((c) =>
        [
          "conversation_read",
          "conversation_search",
          "observation_read",
        ].includes(c.operation),
      ).length;
      for (const p of predictions) {
        const actual =
          p.consumer === "routing"
            ? delegated.length === 1
              ? delegated[0]!
              : delegated.length
                ? "several"
                : "chief"
            : "keep";
        await event(db, user, run, "decision.shadow", {
          version: 1,
          consumer: p.consumer,
          ok: p.ok,
          prediction: p.decision ?? null,
          score: p.score ?? null,
          threshold:
            p.consumer === "routing"
              ? this.config.routing.threshold
              : this.config.continuity.threshold,
          actual,
          // routing: would the fast path have matched Chief's own single delegation?
          agree:
            p.consumer === "routing" && p.decision
              ? p.decision === "chief" || p.decision === actual
              : null,
          delegated,
          recalled,
          interrupted: turn.interrupted,
          stopReason: turn.stopReason,
          messages: turn.messages,
          latencyMs: p.latencyMs,
          costUsd: p.costUsd,
          model: p.model,
          ...(p.error ? { error: p.error } : {}),
        });
      }
    } catch {
      /* Shadow data is optional; a failure here never affects the owner. */
    }
  }
}

/** The catalogue name for a type Chief passed: an alias stays, a full ID becomes its alias. */
export function catalogueType(type: string) {
  try {
    const agentId = plugins.resolve(type);
    return (
      Object.entries(plugins.aliases).find(([, id]) => id === agentId)?.[0] ??
      agentId
    );
  } catch {
    return type;
  }
}

/**
 * Picker check (no model call): which optional domains the turn offered, which it
 * actually used, and whether it had to load one mid-turn. Tells us whether the domain
 * picker still earns its latency now that most tools live in agents.
 */
export async function recordPickerCheck(
  db: Database,
  user: string,
  run: string,
  domainOf: (operation: string) => string | undefined,
) {
  try {
    const selected = (
      await db.query(
        "SELECT data FROM events WHERE run_id=$1 AND user_id=$2 AND type IN ('tools.selected','tools.loaded') ORDER BY id",
        [run, user],
      )
    ).rows.map((r) => r.data as { domains?: string[] });
    const offered = new Set(selected[0]?.domains ?? []);
    const loaded = new Set(selected.at(-1)?.domains ?? []);
    const used = new Set(
      (
        await db.query(
          "SELECT DISTINCT operation FROM runtime_calls WHERE run_id=$1",
          [run],
        )
      ).rows
        .map((r) => domainOf(r.operation))
        .filter((d): d is string => !!d),
    );
    await event(db, user, run, "decision.shadow", {
      version: 1,
      consumer: "picker",
      ok: true,
      offered: [...offered].sort(),
      used: [...used].sort(),
      // Offered but unused costs schema characters; used but not offered cost a load step.
      unused: [...offered].filter((d) => !used.has(d)).sort(),
      loadedLater: [...loaded].filter((d) => !offered.has(d)).sort(),
    });
  } catch {
    /* optional */
  }
}
