import { readFileSync } from "node:fs";
import { z } from "zod";

const modelId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/);
export const MODEL_TIERS = ["fast", "standard", "strong"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
const tier = z.enum(MODEL_TIERS);
// First-party list price, $ per million tokens.
const listPrice = z.number().positive().finite().max(400);

const schema = z
  .object({
    schemaVersion: z.literal(1),
    // Null preserves the existing AGENT_MODEL value until a reviewed PR chooses a model.
    main: modelId.nullable(),
    // Subagent model tiers. A call names a tier, never a model ID; only this reviewed file maps it.
    agents: z
      .object({
        default: tier,
        tiers: z
          .object({ fast: modelId, standard: modelId, strong: modelId })
          .partial()
          .strict(),
      })
      .strict()
      .refine((a) => !!a.tiers[a.default], "the default tier needs a model")
      .optional(),
    // The nightly memory judge (docs/learning.md#nightly-judge). It was a different family from
    // the main and learner models so it would not grade their work; on 11 November 2026 the owner
    // chose Opus 5.5 for it, the same model (journal 164). Unset, it uses the standard tier.
    judge: modelId.optional(),
    // A model of another family that re-judges a small nightly sample of the judge's verdicts,
    // so agreement can be read (13 November 2026, journal 183). It is shown facts and the
    // owner messages they cite only, never a turn's tool calls. It replaces nothing: the judge
    // above still gives every recorded verdict. Unset, there is no cross-check.
    judgeSecond: modelId.optional(),
    // Provider price ceilings ($ per million tokens) for every OpenRouter caller. When set, this
    // reviewed value replaces OPENROUTER_MAX_INPUT_PRICE/OPENROUTER_MAX_OUTPUT_PRICE; raising it
    // needs an explicit owner request (owner-approved $4/$20 on 19 October 2026 for Opus 5.5).
    priceCeilings: z
      .object({
        input: z.number().positive().finite().max(100),
        output: z.number().positive().finite().max(400),
      })
      .strict()
      .optional(),
    // Direct provider pathways (src/model-router.ts). Each listed OpenRouter model ID maps to
    // the provider's own ID and first-party list prices, written out rather than derived from
    // the slug. An unlisted model, or one priced above priceCeilings, stays on OpenRouter.
    providers: z
      .object({
        anthropic: z
          .object({
            // Retry once on OpenRouter when the direct call fails before any output.
            fallback: z.boolean(),
            models: z.record(
              modelId.refine((m) => m.startsWith("anthropic/")),
              z
                .object({
                  id: z.string().regex(/^claude-[a-z0-9-]{1,80}$/),
                  input: listPrice,
                  output: listPrice,
                  cacheRead: listPrice,
                  cacheWrite: listPrice,
                })
                .strict(),
            ),
          })
          .strict(),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

export type ModelPolicy = z.infer<typeof schema>;

export function readModelPolicy(
  url: URL = new URL("../config/model-policy.json", import.meta.url),
): ModelPolicy {
  try {
    return schema.parse(JSON.parse(readFileSync(url, "utf8")));
  } catch (error) {
    throw new Error("Invalid bundled model policy", { cause: error });
  }
}

export function resolveMainModel(
  environmentModel: string,
  policy: ModelPolicy = readModelPolicy(),
): string {
  return policy.main ?? environmentModel;
}

/**
 * The model ID for a subagent tier. Without an agents section every tier uses the main model,
 * so a deployment that has not chosen subagent models behaves as before.
 */
export function resolveAgentModel(
  requested: ModelTier | undefined,
  mainModel: string,
  policy: ModelPolicy = readModelPolicy(),
): { tier: ModelTier; model: string } {
  const agents = policy.agents;
  const tier = requested ?? agents?.default ?? "standard";
  if (!agents) return { tier, model: mainModel };
  const model = agents.tiers[tier];
  if (!model)
    throw new Error(
      `Agent validation: model tier "${tier}" is not configured; use ${MODEL_TIERS.filter((t) => agents.tiers[t]).join(" or ")}`,
    );
  return { tier, model };
}

/** The nightly judge's model: the reviewed policy value, else the learner's standard tier. */
export function resolveJudgeModel(
  mainModel: string,
  policy: ModelPolicy = readModelPolicy(),
): string {
  return policy.judge ?? resolveAgentModel("standard", mainModel, policy).model;
}

/** The model that cross-checks a sample of the judge's verdicts, when the policy names one. */
export function resolveJudgeSecondModel(
  policy: ModelPolicy = readModelPolicy(),
): string | undefined {
  return policy.judgeSecond;
}

/** The effective provider price ceilings: the reviewed policy value, else the environment's. */
export function resolvePriceCeilings(
  environment: { input: number; output: number },
  policy: ModelPolicy = readModelPolicy(),
): { input: number; output: number } {
  return policy.priceCeilings ?? environment;
}

export function configuredTiers(policy: ModelPolicy = readModelPolicy()) {
  return policy.agents
    ? MODEL_TIERS.filter((t) => policy.agents!.tiers[t])
    : ([...MODEL_TIERS] as ModelTier[]);
}

export type AnthropicRoute = {
  nativeModel: string;
  prices: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  fallback: boolean;
};

/** The reviewed direct Anthropic mapping for an OpenRouter model ID, if the policy lists one. */
export function resolveAnthropicModel(
  model: string,
  policy: ModelPolicy = readModelPolicy(),
): AnthropicRoute | undefined {
  const section = policy.providers?.anthropic;
  if (!section || !Object.hasOwn(section.models, model)) return undefined;
  const { id, ...prices } = section.models[model]!;
  return { nativeModel: id, prices, fallback: section.fallback };
}
