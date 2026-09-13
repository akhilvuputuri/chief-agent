import { canvasRef } from "./canvas-schema.js";
import { z } from "zod";

// Optional presentation data, never an instruction to fetch, mutate or approve records.
export const recordRef = z
  .object({
    kind: z.enum(["role", "item", "schedule", "calendar_draft"]),
    id: z.string().uuid(),
  })
  .strict();
export const answerFields = {
  canvases: z.array(canvasRef).max(10).optional(),
  records: z.array(recordRef).max(200).optional(),
  numbers: z
    .array(
      z
        .object({
          label: z.string().min(1).max(120),
          value: z.string().min(1).max(120),
        })
        .strict(),
    )
    .max(20)
    .optional(),
  sections: z
    .array(
      z
        .object({
          title: z.string().min(1).max(120),
          body: z.string().min(1).max(20000),
        })
        .strict(),
    )
    .max(30)
    .optional(),
  sources: z
    .array(
      z
        .object({
          label: z.string().min(1).max(200),
          url: z
            .string()
            .url()
            .max(2000)
            .regex(/^https?:\/\//i),
        })
        .strict(),
    )
    .max(50)
    .optional(),
};
export const answerSchema = z
  .object({ reply: z.string().min(1).max(50000), ...answerFields })
  .strict();
export const finishSchema = answerSchema.extend({
  reason: z.enum(["answer", "awaiting_user", "awaiting_approval"]),
});
export type Answer = z.infer<typeof answerSchema>;
export type RecordRef = z.infer<typeof recordRef>;
export type Delivery = Answer & {
  runId?: string;
  notices?: string[];
  /** Host-only delivery fence; never accepted from a model answer. */
  inputRevision?: number;
  voiceReply?: boolean;
};
