import { z } from "zod";
export const parcelStatus = z.enum([
  "ordered",
  "shipped",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "delayed",
  "returned",
  "cancelled",
  "unknown",
]);
export type ParcelStatus = z.infer<typeof parcelStatus>;
/**
 * Where a fact came from. An email carries the identifiers needed to re-open the exact
 * message; its text is never copied into the database. `observedAt` is the email's own
 * Date header, not the moment we read it, because precedence compares when a fact was
 * true rather than when we happened to learn it.
 */
export const parcelSource = {
  sourceKind: z.enum(["email", "user"]),
  messageId: z
    .string()
    .regex(/^[a-f0-9]{1,64}$/i)
    .optional(),
  threadId: z
    .string()
    .regex(/^[a-f0-9]{1,64}$/i)
    .optional(),
  // The Gmail mailbox the message lives in, as gmail_search named it; omitted means
  // primary. A message id alone cannot reopen a message from another mailbox.
  account: z.string().min(1).max(254).optional(),
  sender: z.string().max(200).optional(),
  subject: z.string().max(200).optional(),
  observedAt: z.string().datetime({ offset: true }).optional(),
};
export type ParcelSourceFields = {
  sourceKind: "email" | "user";
  messageId?: string;
  threadId?: string;
  sender?: string;
  subject?: string;
  observedAt?: string;
};
/** An email must name the message and the moment it describes; a user statement need not. */
export function checkSource(value: ParcelSourceFields) {
  return (
    value.sourceKind !== "email" || (!!value.messageId && !!value.observedAt)
  );
}
const ref = z.string().trim().max(120);
const fields = {
  carrier: z.string().trim().max(120).optional(),
  trackingRef: ref.optional(),
  orderRef: ref.optional(),
  status: parcelStatus.optional(),
  rawStatus: z.string().trim().max(200).optional(),
  eta: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  note: z.string().trim().max(2000).optional(),
};
/**
 * One write. Without `id` it creates a parcel, which needs a label; with `id` it appends
 * an observation to that parcel. Creating and updating share every field, so keeping them
 * as one operation halves the schema the model carries on every turn.
 */
export const parcelRecord = z
  .object({
    operation: z.literal("parcel_record"),
    id: z.string().uuid().optional(),
    label: z.string().trim().min(1).max(200).optional(),
    merchant: z.string().trim().max(120).optional(),
    ...fields,
    archive: z.boolean().optional(),
    ...parcelSource,
  })
  .strict();
export const parcelList = z
  .object({
    operation: z.literal("parcel_list"),
    id: z.string().uuid().optional(),
    status: parcelStatus.optional(),
    includeArchived: z.boolean().optional(),
    offset: z.number().int().min(0).max(10000).optional(),
  })
  .strict();
export const parcelMatch = z
  .object({
    operation: z.literal("parcel_match"),
    trackingRef: ref.optional(),
    orderRef: ref.optional(),
    merchant: z.string().trim().max(120).optional(),
    label: z.string().trim().max(200).optional(),
  })
  .strict();
