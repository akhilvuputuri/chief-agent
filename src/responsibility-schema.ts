import { z } from "zod";
import { parcelStatus } from "./parcel-schema.js";

const id = z.string().uuid();
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const responsibilitySpec = z
  .object({
    title: z.string().trim().min(1).max(150),
    outcome: z.string().trim().min(1).max(3000),
    parcelIds: z.array(id).max(30).default([]),
    gmail: z
      .object({
        account: z.enum(["primary", "secondary"]),
        query: z.string().trim().min(1).max(1000),
        minutes: z.number().int().min(15).max(240).default(30),
      })
      .strict()
      .optional(),
    calendar: z
      .object({
        leadHours: z.number().min(0.25).max(24),
        internalDomains: z
          .array(
            z
              .string()
              .max(253)
              .regex(
                /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
              ),
          )
          .max(10),
      })
      .strict()
      .optional(),
    schedule: z.string().trim().min(1).max(150).optional(),
    publicQuery: z.string().trim().min(1).max(500).optional(),
    notifyWhen: z.string().trim().min(1).max(1000),
    urgentWhen: z.string().trim().min(1).max(1000).optional(),
    notifyStatuses: z
      .array(parcelStatus)
      .max(10)
      .default(["delayed", "out_for_delivery", "delivered"]),
    deliveryTime: clock.optional(),
    monitoringWindow: z
      .object({
        start: clock,
        end: z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/),
        days: z
          .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
          .max(7)
          .optional(),
      })
      .strict()
      .optional(),
    quietHours: z
      .object({ start: clock, end: clock })
      .strict()
      .default({ start: "23:00", end: "08:00" }),
    end: z.enum([
      "all_parcels_terminal",
      "first_match",
      "until_cancelled",
      "date",
    ]),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    silentClosing: z.boolean().default(false),
  })
  .strict();
export type ResponsibilitySpec = z.infer<typeof responsibilitySpec>;
export const responsibilityCreate = z
  .object({
    operation: z.literal("responsibility_create"),
    spec: responsibilitySpec,
  })
  .strict();
export const responsibilityUpdate = z
  .object({
    operation: z.literal("responsibility_update"),
    id,
    baseRevision: z.number().int().positive(),
    spec: responsibilitySpec.optional(),
    status: z.enum(["active", "paused", "cancelled", "resolved"]).optional(),
  })
  .strict();
export const responsibilityList = z
  .object({
    operation: z.literal("responsibility_list"),
    offset: z.number().int().min(0).max(10000).default(0),
  })
  .strict();
export const responsibilityHistory = z
  .object({
    operation: z.literal("responsibility_history"),
    id,
    offset: z.number().int().min(0).max(10000).default(0),
  })
  .strict();
export const responsibilityFinding = z
  .object({
    changed: z.string().max(2000),
    matters: z.string().max(2000),
    nextAction: z.string().max(1000).optional(),
    understanding: z.string().min(1).max(3000),
    reply: z.string().min(1).max(3000),
    evidence: z.array(z.string().min(1).max(2000)).max(30),
    factKey: z.string().min(1).max(300),
    proposedAttention: z.enum(["now", "briefing", "quiet", "drop"]),
    actionRequired: z.boolean().default(false),
    resolved: z.boolean().default(false),
  })
  .strict();
export const responsibilityReport = z
  .object({
    operation: z.literal("responsibility_report"),
    finding: responsibilityFinding,
  })
  .strict();
