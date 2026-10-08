import { z } from "zod";

/** Worker observations are never requirements, verification or review authority. */
export const notebook = z
  .object({
    subtask: z.string().max(1000).default(""),
    findings: z.string().max(6000).default(""),
    nextAction: z.string().max(1000).default(""),
    questions: z.string().max(2000).default(""),
  })
  .strict();
export const loopMemory = z
  .object({
    notes: notebook.default({}),
    receipts: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-f0-9]{64}$/),
            tool: z.string().max(40),
            path: z.string().max(240).optional(),
            fingerprint: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            start: z.number().int().nonnegative().optional(),
            end: z.number().int().nonnegative().optional(),
            unit: z.enum(["characters", "lines"]).optional(),
          })
          .strict(),
      )
      .max(80)
      .default([]),
    recent: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(16)
      .default([]),
    modelCalls: z.number().int().nonnegative().max(400).default(0),
    toolsUsed: z.number().int().nonnegative().max(1000).default(0),
    compactions: z.number().int().nonnegative().max(400).default(0),
    nudges: z.number().int().nonnegative().max(1000).default(0),
    resets: z.number().int().nonnegative().max(400).default(0),
    loopLevel: z.number().int().min(0).max(2).default(0),
    repeatStreak: z.number().int().nonnegative().max(1000).default(0),
    lastProgressAt: z.string().datetime().optional(),
  })
  .strict();
export const runtimeMemory = z
  .object({
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    leader: loopMemory.optional(),
    coder: loopMemory.optional(),
    reviewer: loopMemory.optional(),
  })
  .strict();
