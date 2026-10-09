import { squadState } from "./squad-schema.js";
import { runtimeMemory } from "./memory-schema.js";
import { z } from "zod";

const id = z.string().uuid();
export const codingStart = z
  .object({
    operation: z.literal("coding_start"),
    requestKey: z.string().min(1).max(100),
    objective: z.string().min(1).max(8000),
    context: z.string().max(16000).default(""),
    mode: z.enum(["plan", "implement"]),
  })
  .strict();
export const codingStatus = z
  .object({ operation: z.literal("coding_status"), id: id.optional() })
  .strict();
export const codingReply = z
  .object({
    operation: z.literal("coding_reply"),
    id,
    baseRevision: z.number().int().positive(),
    requestKey: z.string().min(1).max(100),
    message: z.string().min(1).max(8000),
    mode: z.enum(["plan", "implement"]).optional(),
  })
  .strict();
export const codingCancel = z
  .object({ operation: z.literal("coding_cancel"), id })
  .strict();
export const codingResume = z
  .object({
    operation: z.literal("coding_resume"),
    id,
    baseRevision: z.number().int().positive(),
    requestKey: z.string().min(1).max(100),
  })
  .strict();
export const codingModels = z
  .object({
    operation: z.literal("coding_models"),
    list: z.boolean().optional(),
  })
  .strict();
export const codingModelSet = z
  .object({
    operation: z.literal("coding_model_set"),
    role: z.enum(["leader", "coder", "reviewer"]),
    model: z.string().min(1).max(120),
  })
  .strict();
export const codingAction = z.discriminatedUnion("operation", [
  codingStart,
  codingStatus,
  codingReply,
  codingCancel,
  codingResume,
  codingModels,
  codingModelSet,
]);
export type CodingAction = z.infer<typeof codingAction>;

export const checkpoint = z
  .object({
    plan: z.string().max(32000).default(""),
    patch: z.string().max(500000).default(""),
    summary: z.string().max(4000).default(""),
    squadState: squadState.optional(),
    runtimeMemory: runtimeMemory.optional(),
    piState: z
      .object({
        version: z.literal(1),
        toolsUsed: z.number().int().min(0).max(1000),
      })
      .strict()
      .optional(),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(240),
            content: z.string().max(128000).nullable(),
            mode: z.enum(["100644", "100755"]).optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
export const outcome = z
  .object({
    kind: z.enum([
      "plan_ready",
      "awaiting_input",
      "candidate",
      "paused",
      "failed",
    ]),
    summary: z.string().min(1).max(4000),
    question: z.string().max(2000).default(""),
    checkpoint,
    checks: z
      .array(
        z
          .object({
            command: z.string().max(100),
            exitCode: z.number().int(),
            output: z.string().max(8000),
          })
          .strict(),
      )
      .max(4)
      .default([]),
    review: z
      .object({
        verdict: z.enum(["APPROVE", "REQUEST_CHANGES"]),
        findings: z.string().max(8000),
        model: z.string().max(120),
        patchHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Checkpoint = z.infer<typeof checkpoint>;
export type Outcome = z.infer<typeof outcome>;
export const workerEvent = z
  .object({
    key: z.string().min(1).max(100),
    stage: z.enum(["planning", "implementing", "verifying", "reviewing"]),
    summary: z.string().min(1).max(2000),
  })
  .strict();

export const codingSettings = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    branch: z.literal("main"),
    image: z
      .string()
      .regex(/^ghcr\.io\/[a-z0-9/_.-]+@sha256:[a-f0-9]{64}$/)
      .or(z.literal("")),
    model: z.string().min(1).max(120),
    reviewerModel: z.string().min(1).max(120),
    leaderModel: z.string().min(1).max(120).optional(),
    squad: z.boolean().optional(),
    autoMerge: z.boolean().optional(),
    runtime: z.enum(["node", "python", "pi"]).optional(),
    harnessVersion: z.literal(2).optional(),
    effort: z.enum(["low", "medium", "high"]),
    limits: z
      .object({
        ms: z.number().int().positive().max(7200000),
        models: z.number().int().positive().max(400),
        tools: z.number().int().positive().max(1000),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.runtime === "pi" &&
      (value.squad || value.harnessVersion || value.autoMerge)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pi is a separate draft-only runtime profile",
      });
    if (
      value.harnessVersion === 2 &&
      (value.runtime !== "python" || value.squad !== true)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Working-state harness requires the Python squad",
      });
  });
export type CodingSettings = z.infer<typeof codingSettings>;

/** Reserve room for model/tool schema and a complete current call group. */
export function assertCodingBrief(
  objective: string,
  context: string,
  plan = "",
  summary = "",
) {
  const content = JSON.stringify({
    objective,
    context,
    savedPlan: plan,
    savedSummary: summary,
  });
  if (
    Buffer.byteLength(
      JSON.stringify({ messages: [{ role: "user", content }] }),
    ) > 70000
  )
    throw new Error(
      "Coding brief is too large for one run; provide a shorter objective/context or a concise implementation brief. The original request and saved plan are retained.",
    );
}
