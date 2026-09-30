import { z } from "zod";
import { configuredTiers, type ModelTier } from "./model-policy.js";
import { REASONING_EFFORTS } from "./model.js";

/**
 * The one delegation tool. Generic by design: the agent type decides what it needs, and any IDs
 * or links it should work on travel in the objective or context as ordinary text.
 */
export const agentRun = z
  .object({
    operation: z.literal("agent_run"),
    type: z.string().regex(/^([a-z][a-z0-9-]{0,47}\/)?[a-z][a-z0-9-]{0,47}$/),
    objective: z.string().min(1).max(2000),
    context: z.string().max(4000).default(""),
    // Only tiers the reviewed model policy maps are offered.
    model: z.enum(configuredTiers() as [ModelTier, ...ModelTier[]]).optional(),
    effort: z.enum(REASONING_EFFORTS).optional(),
  })
  .strict();
export type AgentRun = z.infer<typeof agentRun>;

/** findings/v1: the general report contract any plugin agent can use. */
export const agentReport = z
  .object({
    operation: z.literal("agent_report"),
    status: z.enum(["complete", "partial", "blocked"]),
    summary: z.string().min(1).max(3000),
    findings: z
      .array(
        z
          .object({
            text: z.string().min(1).max(600),
            sourceId: z.string().uuid().optional(),
            quote: z.string().min(1).max(300).optional(),
            observationId: z.string().uuid().optional(),
          })
          .strict(),
      )
      .max(12),
    /** IDs of records this agent created, changed or relied on, exactly as its tools returned them. */
    refs: z.array(z.string().min(1).max(2000)).max(12),
    /** A question only the owner can answer; the coordinator asks it. */
    needsOwner: z.string().max(600).optional(),
  })
  .strict();
export type AgentReport = z.infer<typeof agentReport>;
