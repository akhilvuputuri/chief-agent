// The shared Jev decision configuration (config/decisions.json): the tool picker's model,
// continuity, routing and link-routing questions. It has no plugin or runtime imports, so
// both the shadow recorder and the link router can read the same single source without a
// circular module graph.
import { readFileSync } from "node:fs";
import { z } from "zod";

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
    // Link routing (docs/study-resources.md). The model id and timeout above are shared, so
    // Jev stays the single decision model for the picker, effort and link classification.
    links: z
      .object({
        instructions: z.string().min(1).max(2000),
        route: z
          .object({
            instructions: z.string().min(1).max(2000),
            criteria: z
              .object({
                study: z.string().min(1).max(2000),
                reader: z.string().min(1).max(2000),
                both: z.string().min(1).max(2000),
              })
              .strict(),
          })
          .strict(),
        topic: z
          .object({
            instructions: z.string().min(1).max(2000),
            criteria: z
              .object({
                "applied-ai-engineering": z.string().min(1).max(2000),
                "agent-platforms": z.string().min(1).max(2000),
                "developer-tools": z.string().min(1).max(2000),
                "voice-conversational-ai": z.string().min(1).max(2000),
                other: z.string().min(1).max(2000),
              })
              .strict(),
          })
          .strict(),
        unsure: z
          .object({
            instructions: z.string().min(1).max(2000),
            criteria: z
              .object({
                true: z.string().min(1).max(2000),
                false: z.string().min(1).max(2000),
              })
              .strict(),
          })
          .strict(),
        apply: z
          .object({
            confidence: z.number().min(0).max(1),
            unsure: z.number().min(0).max(1),
          })
          .strict(),
        interests: z.array(z.string().min(1).max(120)).min(1).max(8),
        explicitCues: z.string().min(1).max(2000),
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
