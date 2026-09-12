import { z } from "zod";
const uuid = z.string().uuid();
export const mediaAssignment = z
  .object({
    operation: z.literal("media_delegate"),
    objective: z.string().min(1).max(2000),
    context: z.string().max(2000),
    attachmentIds: z.array(uuid).max(4),
    sourceIds: z.array(uuid).max(4),
  })
  .strict();
const bounded = (max: number) => z.string().max(max);
export const mediaTarget = z
  .object({
    targetId: uuid,
    kind: z.enum(["image", "document"]),
    status: z.enum(["complete", "partial", "blocked"]),
    summary: z.string().min(1).max(1500),
    facts: z
      .array(
        z
          .object({
            text: z.string().min(1).max(400),
            reference: bounded(120),
            confidence: z.enum(["high", "medium", "low"]),
          })
          .strict(),
      )
      .max(16),
    quotes: z
      .array(
        z
          .object({ sourceId: uuid, quote: z.string().min(1).max(300) })
          .strict(),
      )
      .max(6),
    omissions: bounded(600),
    uncertainty: bounded(600),
  })
  .strict();
export const mediaReport = z
  .object({
    operation: z.literal("media_report"),
    targets: z.array(mediaTarget).min(1).max(8),
  })
  .strict();
export type MediaTarget = z.infer<typeof mediaTarget>;
/** The media specialist reads stored text only; it has no web or write access. */
export const mediaReads = new Set(["source_read"]);
