import { squadState } from "./squad-schema.js";
import { runtimeMemory } from "./memory-schema.js";
import { z } from "zod";
import { MAX_OUTPUT_TOKENS } from "../model.js";
import { reportLimits, reportDocument } from "@chief-agent/pi-runtime/report";

const id = z.string().uuid();
export const codingStart = z
  .object({
    operation: z.literal("coding_start"),
    requestKey: z.string().min(1).max(100),
    objective: z.string().min(1),
    context: z.string().default(""),
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
    message: z.string().min(1),
    /** Only when the owner explicitly asked, in this conversation, to resume or answer this job. */
    confirmStale: z.boolean().optional(),
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
    /** Only when the owner explicitly asked, in this conversation, to resume this job. */
    confirmStale: z.boolean().optional(),
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
export const codingJobUpdate = z
  .object({
    operation: z.literal("coding_job_update"),
    id,
    baseRevision: z.number().int().positive(),
    requestKey: z.string().min(1).max(100),
    /** Only after the owner asked for this change on this job, and confirmed it if unclear. */
    ownerConfirmed: z.literal(true),
    leaderModel: z.string().min(1).max(120).optional(),
    coderModel: z.string().min(1).max(120).optional(),
    reviewerModel: z.string().min(1).max(120).optional(),
    /** Move a stopped Pi job to the worker image new jobs use, keeping its work. */
    upgradeWorker: z.literal(true).optional(),
    limits: z
      .object({
        ms: z.number().int().positive().max(14_400_000).optional(),
        models: z.number().int().positive().max(2000).optional(),
        tools: z.number().int().positive().max(5000).optional(),
      })
      .strict()
      .optional(),
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
  codingJobUpdate,
]);
export type CodingAction = z.infer<typeof codingAction>;

export const checkpoint = z
  .object({
    plan: z.string().max(reportLimits.document).default(""),
    patch: z.string().max(10_000_000).default(""),
    summary: z.string().max(4000).default(""),
    squadState: squadState.optional(),
    runtimeMemory: runtimeMemory.optional(),
    /** A Pi job's state between attempts (journal 192); the sessions themselves are stored apart. */
    piState: z
      .object({
        version: z.literal(1),
        phase: z.enum(["build", "review"]).optional(),
        /** Inbox events already in the coder's session. */
        delivered: z.array(z.string().uuid()).default([]),
        /** The candidate the reviewer last judged, so the next round reads what changed since. */
        reviewed: z
          .object({
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            base: z.string().regex(/^[a-f0-9]{40}$/),
            patch: z.string().max(10_000_000),
          })
          .strict()
          .optional(),
        reportDocument: z
          .object({
            version: z.literal(1),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            kind: z.enum(["done", "review", "ask"]),
            summary: z.string().max(reportLimits.summary),
            detail: z.string().max(reportLimits.document),
            verdict: z.enum(["APPROVE", "REQUEST_CHANGES"]).optional(),
            ask: z.string().max(reportLimits.ask).optional(),
            options: z
              .array(z.string().min(1))
              .max(reportLimits.options)
              .optional(),
          })
          .strict()
          .refine((d) => {
            try {
              return reportDocument(d).hash === d.hash;
            } catch {
              return false;
            }
          }, "Report document identity/content invalid")
          .optional(),
      })
      .strict()
      .optional(),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(240),
            content: z.string().max(1_000_000).nullable(),
            mode: z.enum(["100644", "100755"]).optional(),
          })
          .strict(),
      )
      .max(500)
      .default([]),
  })
  .strict();
export const outcome = z
  .object({
    kind: z.enum(["awaiting_input", "candidate", "paused", "failed"]),
    summary: z.string().min(1).max(4000),
    question: z.string().max(2000).default(""),
    /** Answers the owner can tap for a Pi ask (journal 192). */
    options: z.array(z.string().min(1)).max(reportLimits.options).optional(),
    checkpoint,
    /** Receipts from the legacy runtimes; a Pi coder runs the tests itself (journal 192). */
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
        findings: z.string().max(reportLimits.document),
        model: z.string().max(120),
        patchHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    /** The draft PR an agent-git worker pushed and opened; the host verifies it before recording. */
    published: z
      .object({
        url: z
          .string()
          .max(300)
          .regex(
            /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/,
          ),
        head: z.string().regex(/^[a-f0-9]{40}$/),
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

/** Catalog context windows snapshotted for a Pi job's selected models. */
export const codingContextWindows = z
  .record(
    z.string().min(1).max(120),
    z.number().int().min(1024).max(100_000_000),
  )
  .refine((value) => Object.keys(value).length <= 3, "Too many models");
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
    // Coder allowance (journal 156).
    maxOutputTokens: z
      .number()
      .int()
      .positive()
      .max(MAX_OUTPUT_TOKENS)
      .optional(),
    /** Reviewer allowance; defaults to the coder allowance capped at the earlier 16,000. */
    reviewerMaxOutputTokens: z
      .number()
      .int()
      .positive()
      .max(MAX_OUTPUT_TOKENS)
      .optional(),
    contextWindows: codingContextWindows.optional(),
    /** Host-only: Pi PRs collect GitHub/Devin feedback, then merge only after the owner confirms. */
    prWorkflow: z.literal("owner_merge").optional(),
    /** Host-only: the sandbox commits, pushes its branch and opens the draft PR with a scoped agent token. */
    agentGit: z.boolean().optional(),
    /** Host-only operator switch (default on): re-queue a job once after a classified transient pause. */
    autoRetryTransientOnce: z.boolean().optional(),
    limits: z
      .object({
        ms: z.number().int().positive().max(14_400_000),
        // Raised from 400 and 1000 when coding moved to EC2 boxes (no 45-minute CodeBuild cap).
        models: z.number().int().positive().max(2000),
        tools: z.number().int().positive().max(5000),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.maxOutputTokens !== undefined ||
        value.reviewerMaxOutputTokens !== undefined) &&
      value.runtime !== "pi"
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Explicit output allowance belongs to the Pi profile",
      });
    if (value.contextWindows !== undefined && value.runtime !== "pi")
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Model context windows belong to the Pi profile",
      });
    if (
      value.agentGit &&
      (value.runtime !== "pi" || value.prWorkflow !== "owner_merge")
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Agent git publication requires the Pi owner-merge profile",
      });
    if (value.prWorkflow !== undefined && value.runtime !== "pi")
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Owner-confirmed merge belongs to the Pi profile",
      });
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
/**
 * The host's time limit for one model call: at least 100 tokens a second of its allowance,
 * never below 5 minutes. The worker waits a minute longer for the reply.
 */
export function modelCallTimeoutMs(allowance: number) {
  return Math.max(300000, allowance * 10);
}
/** The output allowance for one model role of a job. */
export function outputAllowance(
  settings: Pick<CodingSettings, "maxOutputTokens" | "reviewerMaxOutputTokens">,
  role: "leader" | "coder" | "reviewer",
) {
  const coder = settings.maxOutputTokens ?? 8000;
  return role === "reviewer"
    ? (settings.reviewerMaxOutputTokens ?? Math.min(coder, 16000))
    : coder;
}
