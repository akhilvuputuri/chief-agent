import { z } from "zod";

export const parcelStatus = z.enum([
  "unknown",
  "ordered",
  "label_created",
  "shipped",
  "in_transit",
  "out_for_delivery",
  "available_for_pickup",
  "delivered",
  "exception",
  "returned",
  "cancelled",
]);
const date = z
  .string()
  .max(40)
  .refine(
    (s) =>
      Number.isFinite(Date.parse(s)) &&
      (/^\d{4}-\d{2}-\d{2}$/.test(s)
        ? new Date(s).toISOString().slice(0, 10) === s
        : z.string().datetime({ offset: true }).safeParse(s).success),
    "Use an ISO date or timestamp with timezone",
  );
export const parcelData = z
  .object({
    label: z.string().max(160).nullable().default(null),
    merchant: z.string().max(160).nullable().default(null),
    orderReference: z.string().max(160).nullable().default(null),
    carrier: z.string().max(100).nullable().default(null),
    trackingReference: z.string().max(160).nullable().default(null),
    trackingUrl: z
      .string()
      .url()
      .max(2000)
      .regex(/^https?:\/\//i)
      .nullable()
      .default(null),
    status: parcelStatus.default("unknown"),
    rawStatus: z.string().max(200).nullable().default(null),
    etaText: z.string().max(200).nullable().default(null),
    etaStart: date.nullable().default(null),
    etaEnd: date.nullable().default(null),
    deliveredAt: date.nullable().default(null),
    notes: z.string().max(2000).nullable().default(null),
  })
  .strict();
export const parcelField = parcelData.keyof();
export const parcelClaim = z
  .object({
    field: parcelField,
    value: z.string().max(2000).nullable(),
    quote: z.string().min(1).max(500),
  })
  .strict();
export const parcelClaims = z
  .array(parcelClaim)
  .max(13)
  .refine(
    (claims) => new Set(claims.map((c) => c.field)).size === claims.length,
    "Provide each field once",
  );
export const parcelCandidate = z
  .object({
    claims: parcelClaims,
    effectiveAt: date.nullable(),
    effectiveAtQuote: z.string().min(1).max(500).optional(),
  })
  .strict();
export const parcelTargets = z
  .array(
    z
      .object({
        messageId: z.string().regex(/^[a-f0-9]{1,64}$/i),
        searchObservationId: z.string().uuid(),
      })
      .strict(),
  )
  .min(1)
  .max(6);
export const parcelReport = z
  .object({
    operation: z.literal("parcel_report"),
    targets: z
      .array(
        z
          .object({
            targetId: z.string().regex(/^[a-f0-9]{1,64}$/i),
            status: z.enum(["complete", "partial", "blocked"]),
            summary: z.string().min(1).max(600),
            candidates: z.array(parcelCandidate).max(6),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();
export const parcelEmailRead = z
  .object({
    operation: z.literal("parcel_email_read"),
    messageId: z.string().regex(/^[a-f0-9]{1,64}$/i),
    offset: z.number().int().min(0).max(24000).default(0),
  })
  .strict();
export const parcelList = z
  .object({
    operation: z.literal("parcel_list"),
    filter: z.enum(["waiting", "active", "archived", "all"]).default("waiting"),
    offset: z.number().int().min(0).max(10000).default(0),
  })
  .strict();
export const parcelRead = z
  .object({
    operation: z.literal("parcel_read"),
    id: z.string().uuid(),
    offset: z.number().int().min(0).max(10000).default(0),
  })
  .strict();
export const parcelSave = z
  .object({
    operation: z.literal("parcel_save"),
    requestKey: z.string().uuid(),
    id: z.string().uuid().optional(),
    baseRevision: z.number().int().positive().optional(),
    inputId: z.string().uuid().optional(),
    quote: z.string().min(1).max(500),
    mode: z
      .enum(["update", "correct", "confirm", "dispute", "archive", "reopen"])
      .default("update"),
    claims: parcelClaims,
  })
  .strict();
export const parcelApply = z
  .object({
    operation: z.literal("parcel_apply"),
    requestKey: z.string().uuid(),
    proposalId: z.string().uuid(),
    id: z.string().uuid().optional(),
    baseRevision: z.number().int().positive().optional(),
    selectionQuote: z.string().min(1).max(500).optional(),
  })
  .strict();
export type ParcelData = z.infer<typeof parcelData>;
export type ParcelCandidate = z.infer<typeof parcelCandidate>;
export type ParcelAction =
  | z.infer<typeof parcelList>
  | z.infer<typeof parcelRead>
  | z.infer<typeof parcelSave>
  | z.infer<typeof parcelApply>;
export const parcelSource = z
  .object({
    kind: z.enum(["user", "gmail"]),
    key: z.string(),
    text: z.string(),
    assertedAt: z.string().datetime().nullable(),
    observedAt: z.string().datetime(),
    originRun: z.string().uuid(),
    observationId: z.string().uuid().optional(),
    inputId: z.string().uuid().optional(),
    messageId: z.string().optional(),
    threadId: z.string().optional(),
    sender: z.string().optional(),
    subject: z.string().optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ParcelSource = z.infer<typeof parcelSource>;
