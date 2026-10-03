import { z } from "zod";
export const squadCheck = z
  .object({
    command: z.string().max(100),
    exitCode: z.number().int(),
    output: z.string().max(8000),
  })
  .strict();
export const squadReview = z
  .object({
    verdict: z.enum(["APPROVE", "REQUEST_CHANGES"]),
    findings: z.string().max(8000),
    model: z.string().max(120),
    patchHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const squadState = z
  .object({
    sequence: z.number().int().positive(),
    revision: z.number().int().positive(),
    attemptId: z.string().uuid(),
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    phase: z.enum([
      "planning",
      "planned",
      "idle",
      "coding",
      "verifying",
      "reviewing",
      "rework",
      "approved",
      "awaiting_input",
    ]),
    candidateVersion: z.number().int().nonnegative(),
    candidateHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .or(z.literal("")),
    toolsUsed: z.number().int().nonnegative().max(500),
    handoff: z
      .object({
        id: z.string().uuid(),
        sender: z.literal("leader"),
        recipient: z.enum(["coder", "reviewer"]),
        instructions: z.string().min(1).max(4000),
        candidateHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .or(z.literal("")),
      })
      .strict()
      .optional(),
    checks: z.array(squadCheck).max(4),
    review: squadReview.optional(),
    findings: z.string().max(8000),
  })
  .strict();
