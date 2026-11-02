import { z } from "zod";

// The study list: durable saved links the owner studies from, with the classification that
// put them there. A shared link is never assumed to be either destination.
export const STUDY_STATUSES = ["to_study", "in_progress", "done"] as const;
export type StudyStatus = (typeof STUDY_STATUSES)[number];

const topic = z.string().min(1).max(80);
const tag = z.string().min(1).max(40);
const tags = z.array(tag).max(6);
const notes = z.string().max(1000);
const url = z.string().url().max(2048);

export const linkSave = z
  .object({
    operation: z.literal("link_save"),
    url,
    // The owner's own words when they shared it; the explicit-cue signal.
    ownerMessage: z.string().max(600).optional(),
    topic: topic.optional(),
    tags: tags.optional(),
    notes: notes.optional(),
  })
  .strict();

export const studySave = z
  .object({
    operation: z.literal("study_save"),
    url,
    ownerMessage: z.string().max(600).optional(),
    topic: topic.optional(),
    tags: tags.optional(),
    notes: notes.optional(),
  })
  .strict();

export const studyList = z
  .object({
    operation: z.literal("study_list"),
    topic: topic.optional(),
    tag: tag.optional(),
    status: z.enum(STUDY_STATUSES).optional(),
    limit: z.number().int().min(1).max(10).optional(),
  })
  .strict();

export const studyUpdate = z
  .object({
    operation: z.literal("study_update"),
    id: z.string().uuid(),
    status: z.enum(STUDY_STATUSES).optional(),
    // An empty string clears the owner's note; omitted leaves it unchanged.
    notes: notes.optional(),
    tags: tags.optional(),
    topic: topic.optional(),
  })
  .strict();

export const studyRemove = z
  .object({ operation: z.literal("study_remove"), id: z.string().uuid() })
  .strict();

export const studyMove = z
  .object({
    operation: z.literal("study_move"),
    to: z.enum(["reader", "study"]),
    // Moving an item out of the study list names it; moving into it needs the link.
    id: z.string().uuid().optional(),
    url: url.optional(),
    ownerMessage: z.string().max(600).optional(),
  })
  .strict();

export const studySchemas = [
  linkSave,
  studySave,
  studyList,
  studyUpdate,
  studyRemove,
  studyMove,
];
