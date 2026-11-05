import { z } from "zod";
import { LINK_TOPICS } from "./link-router.js";

// Study-resource tools (docs/study-resources.md). No tool accepts a model-supplied title or
// a self-declared confidence: the host reads the page and records Jev's own score. A topic
// stays in the closed list, and only an owner edit (study_update) may change one.
export const STUDY_TOPICS = LINK_TOPICS;
export const LINK_DESTINATIONS = ["study", "reader", "remove"] as const;
export const STUDY_STATUSES = ["to_study", "in_progress", "done"] as const;

const id = z.string().uuid();
const topic = z.enum(STUDY_TOPICS);
const studyStatus = z.enum(STUDY_STATUSES);
const tag = z.string().trim().min(1).max(40);
const tags = z.array(tag).min(1).max(10);
const note = z.string().trim().min(1).max(2000);
const url = z.string().url().max(2048);

export const linkSave = z
  .object({
    operation: z.literal("link_save"),
    url,
    /** An owner note to keep with the entry, when the owner gave one. */
    note: note.optional(),
  })
  .strict();

/** One tool for both corrections, plus removing it from the study list. */
export const linkMove = z
  .object({
    operation: z.literal("link_move"),
    id: id.optional(),
    url: url.optional(),
    to: z.enum(LINK_DESTINATIONS),
  })
  .strict();

export const studyList = z
  .object({
    operation: z.literal("study_list"),
    topic: topic.optional(),
    tag: tag.optional(),
    status: studyStatus.optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export const studyUpdate = z
  .object({
    operation: z.literal("study_update"),
    id,
    status: studyStatus.optional(),
    /** null clears the note; omitted keeps it. */
    notes: note.nullable().optional(),
    tags: tags.nullable().optional(),
    topic: topic.optional(),
  })
  .strict();

export const studyRemove = z
  .object({ operation: z.literal("study_remove"), id })
  .strict();

export type LinkSave = z.infer<typeof linkSave>;
export type LinkMove = z.infer<typeof linkMove>;
export type StudyList = z.infer<typeof studyList>;
export type StudyUpdate = z.infer<typeof studyUpdate>;
export type StudyRemove = z.infer<typeof studyRemove>;
export type StudyTopic = z.infer<typeof topic>;
export type StudyStatus = z.infer<typeof studyStatus>;
export type LinkDestination = z.infer<typeof linkMove>["to"];
