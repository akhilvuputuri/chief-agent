import { readFileSync } from "node:fs";
import { z } from "zod";

const modelId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/);
export const MODEL_TIERS = ["fast", "standard", "strong"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
const tier = z.enum(MODEL_TIERS);

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
          .partial(),
      })
      .strict()
      .refine((a) => !!a.tiers[a.default], "the default tier needs a model")
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

export function configuredTiers(policy: ModelPolicy = readModelPolicy()) {
  return policy.agents
    ? MODEL_TIERS.filter((t) => policy.agents!.tiers[t])
    : ([...MODEL_TIERS] as ModelTier[]);
}
