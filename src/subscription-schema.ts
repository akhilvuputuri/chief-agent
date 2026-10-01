import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = z.string().trim().min(1).max(100);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const subscriptionFields = z
  .object({
    label: text.optional(),
    merchant: text.nullable().optional(),
    plan: text.nullable().optional(),
    accountLabel: text.nullable().optional(),
    category: z
      .enum([
        "streaming",
        "software",
        "cloud",
        "utilities",
        "insurance",
        "membership",
        "news",
        "other",
      ])
      .optional(),
    amount: z
      .string()
      .regex(/^\d{1,12}(?:\.\d{1,6})?$/)
      .nullable()
      .optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .optional(),
    amountType: z.enum(["fixed", "variable", "unknown"]).optional(),
    cadence: z
      .enum(["weekly", "monthly", "quarterly", "annual", "days", "unknown"])
      .optional(),
    intervalDays: z.number().int().min(1).max(3660).nullable().optional(),
    status: z
      .enum(["trial", "active", "paused", "cancelling", "cancelled", "unknown"])
      .optional(),
    nextChargeDate: date.nullable().optional(),
    nextChargeEstimated: z.boolean().optional(),
    trialEndDate: date.nullable().optional(),
    cancellationDeadline: date.nullable().optional(),
    paidThroughDate: date.nullable().optional(),
    reminderEnabled: z.boolean().nullable().optional(),
    reminderDays: z.number().int().min(0).max(365).nullable().optional(),
    reminderTime: time.nullable().optional(),
  })
  .strict();
export type SubscriptionFields = z.infer<typeof subscriptionFields>;
export const subscriptionRecord = z
  .object({
    operation: z.literal("subscription_record"),
    requestKey: z.string().uuid(),
    id: z.string().uuid().optional(),
    baseRevision: z.number().int().positive().optional(),
    fields: subscriptionFields,
  })
  .strict();
export const subscriptionList = z
  .object({
    operation: z.literal("subscription_list"),
    id: z.string().uuid().optional(),
    includeInactive: z.boolean().optional(),
    merchant: text.optional(),
    plan: text.optional(),
    accountLabel: text.optional(),
    offset: z.number().int().min(0).max(10000).optional(),
  })
  .strict();
export const subscriptionSettings = z
  .object({
    operation: z.literal("subscription_settings"),
    id: z.string().uuid(),
    requestKey: z.string().uuid().optional(),
    baseRevision: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
    daysBefore: z.number().int().min(0).max(365).nullable().optional(),
    time: time.optional(),
  })
  .strict();
