import { z } from "zod";
import { publicHttps } from "../security.js";
const id = z.string().uuid();
const key = z.string().regex(/^[a-z0-9_-]{1,60}$/);
const requestKey = z.string().min(1).max(100);
const label = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (s) =>
      !/\b(?:sk-|ghp_|github_pat_|AKIA)[A-Za-z0-9_-]{8,}|\b(?:\d[ -]?){13,19}\b|[\r\n]/.test(
        s,
      ),
    "Use a short label without credentials or payment numbers",
  );
const origin = z
  .string()
  .max(300)
  .refine((s) => {
    try {
      return new URL(publicHttps(s)).origin === s;
    } catch {
      return false;
    }
  }, "Use a public HTTPS origin without path, query or credentials");
export const target = z
  .object({
    key,
    label,
    month: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
    accountLabel: label.optional(),
    dateBasis: z
      .enum(["invoice_date", "service_period"])
      .default("invoice_date"),
    browserOrigins: z.array(origin).max(8).default([]),
  })
  .strict();
export const scopeSchema = z
  .object({
    objective: z.string().trim().min(1).max(2000),
    targets: z
      .array(target)
      .min(1)
      .max(36)
      .refine(
        (x) => new Set(x.map((t) => t.key)).size === x.length,
        "Use unique target keys",
      ),
    sources: z
      .array(z.enum(["provided", "browser", "email"]))
      .min(1)
      .max(3)
      .refine(
        (x) => new Set(x).size === x.length,
        "Source order must be unique",
      ),
    mailboxes: z
      .array(z.enum(["primary", "secondary"]))
      .max(2)
      .default([]),
    providedFiles: z.array(id).max(50).default([]),
  })
  .strict()
  .refine(
    (s) => s.sources.includes("email") === s.mailboxes.length > 0,
    "Select exact mailboxes when email is allowed",
  );
export const start = z
  .object({
    operation: z.literal("gather_start"),
    requestKey,
    objective: z.string().trim().min(1).max(2000),
    targets: z.array(target).min(1).max(36),
    sources: z
      .array(z.enum(["provided", "browser", "email"]))
      .min(1)
      .max(3),
    mailboxes: z
      .array(z.enum(["primary", "secondary"]))
      .max(2)
      .default([]),
    providedFiles: z.array(id).max(50).default([]),
  })
  .strict();
export const revise = start
  .omit({ operation: true })
  .extend({
    operation: z.literal("gather_revise"),
    id,
    baseRevision: z.number().int().positive(),
  })
  .strict();
export const status = z
  .object({
    operation: z.literal("gather_status"),
    id: id.optional(),
    offset: z.number().int().min(0).max(10000).default(0),
  })
  .strict();
export const progress = z
  .object({
    operation: z.literal("gather_progress"),
    id,
    targetKey: key,
    offset: z.number().int().min(0).max(10000).default(0),
  })
  .strict();
export const search = z
  .object({
    operation: z.literal("gather_search"),
    id,
    targetKey: key,
    account: z.enum(["primary", "secondary"]),
    query: z
      .string()
      .trim()
      .max(100)
      .regex(/^[\p{L}\p{N} ._-]*$/u)
      .default(""),
    pageToken: z.string().max(1000).optional(),
  })
  .strict();
export const capture = z
  .object({
    operation: z.literal("gather_capture"),
    id,
    targetKey: key,
    requestKey,
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("provided"), artifactId: id }).strict(),
      z
        .object({
          kind: z.literal("email"),
          searchId: id,
          messageId: z.string().regex(/^[a-f0-9]{1,64}$/i),
          partKey: z
            .string()
            .regex(/^\d+(?:\.\d+)*$/)
            .max(80),
        })
        .strict(),
      z
        .object({
          kind: z.literal("browser"),
          sessionId: id,
          snapshotId: id,
          linkId: id,
        })
        .strict(),
    ]),
  })
  .strict();
export const emailFiles = z
  .object({
    operation: z.literal("gather_email_files"),
    id,
    targetKey: key,
    searchId: id,
    messageId: z.string().regex(/^[a-f0-9]{1,64}$/i),
  })
  .strict();
export const match = z
  .object({
    operation: z.literal("gather_match"),
    id,
    targetKey: key,
    requestKey,
    artifactId: id,
    date: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])(?:-\d{2})?$/),
    dateBasis: z.enum(["invoice_date", "service_period"]),
  })
  .strict();
export const check = z
  .object({
    operation: z.literal("gather_check"),
    id,
    targetKey: key,
    requestKey,
    source: z.enum(["provided", "browser", "email"]),
  })
  .strict();
export const block = z
  .object({
    operation: z.literal("gather_block"),
    id,
    targetKey: key,
    requestKey,
    reason: z.enum([
      "login_needed",
      "source_unavailable",
      "no_matching_file",
      "unreadable_file",
      "needs_owner_verification",
      "unsupported_source",
    ]),
    attemptId: id.optional(),
  })
  .strict();
export const finish = z
  .object({ operation: z.literal("gather_finish"), id, requestKey })
  .strict();
export const browser = z
  .object({
    operation: z.literal("gather_browser"),
    id,
    targetKey: key,
    command: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("open"), url: z.string().max(2000) }).strict(),
      z.object({ kind: z.literal("observe"), sessionId: id }).strict(),
      z
        .object({
          kind: z.literal("follow"),
          sessionId: id,
          snapshotId: id,
          linkId: id,
        })
        .strict(),
      z.object({ kind: z.literal("handoff"), sessionId: id }).strict(),
    ]),
  })
  .strict();
export const action = z.discriminatedUnion("operation", [
  start,
  revise,
  status,
  progress,
  search,
  emailFiles,
  capture,
  match,
  check,
  block,
  finish,
  browser,
]);
export type GatherAction = z.infer<typeof action>;
export type GatherScope = z.infer<typeof scopeSchema>;
export type GatherTarget = z.infer<typeof target>;
