import { z } from "zod";
import { savableLink } from "./link-url.js";

const tag = z.string().min(1).max(40);
const status = z.enum(["to_study", "in_progress", "done"]);
// Refused before dispatch, so an unusable link is a validation error, never an uncertain write.
const link = z.string().url().max(2048).refine(savableLink, {
  message:
    "Use a public web link (https, or http that can be upgraded): no IP address, port, login or local hostname",
});

/** Save a link the owner shared: Chief classifies it first unless the owner named the place. */
export const linkSave = z
  .object({
    operation: z.literal("link_save"),
    url: link,
    destination: z.enum(["auto", "study", "reader", "both"]).default("auto"),
    sourceId: z.string().uuid().optional(),
    title: z.string().min(1).max(300).optional(),
    interests: z.array(z.string().min(1).max(100)).max(8).optional(),
    tags: z.array(tag).max(10).optional(),
    notes: z.string().min(1).max(2000).optional(),
  })
  .strict();
export const linkMove = z
  .object({
    operation: z.literal("link_move"),
    id: z.string().uuid().optional(),
    url: link.optional(),
    to: z.enum(["reader", "study"]),
  })
  .strict();
export const studyList = z
  .object({
    operation: z.literal("study_list"),
    topic: z.string().min(1).max(100).optional(),
    tag: tag.optional(),
    status: status.optional(),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).max(10000).default(0),
  })
  .strict();
export const studyUpdate = z
  .object({
    operation: z.literal("study_update"),
    id: z.string().uuid(),
    status: status.optional(),
    notes: z.string().max(2000).nullable().optional(),
    tags: z.array(tag).max(10).optional(),
    topic: z.string().min(1).max(100).optional(),
  })
  .strict();
export const studyRemove = z
  .object({ operation: z.literal("study_remove"), id: z.string().uuid() })
  .strict();
export const linkSchemas = [
  linkSave,
  linkMove,
  studyList,
  studyUpdate,
  studyRemove,
] as const;
export type LinkAction =
  | z.infer<typeof linkSave>
  | z.infer<typeof linkMove>
  | z.infer<typeof studyList>
  | z.infer<typeof studyUpdate>
  | z.infer<typeof studyRemove>;
export const LINK_OPERATIONS = new Set(
  linkSchemas.map((s) => s.shape.operation.value as string),
);
