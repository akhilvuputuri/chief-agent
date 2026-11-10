// Tool schemas for the study collection and link saving (docs/study-links.md). They live
// apart from src/study-links.ts so src/protocol.ts can add them to the action union without
// pulling in the store, the page fetcher or the Jev client.
import { z } from "zod";

export const STUDY_STATUSES = ["to_study", "in_progress", "done"] as const;
export type StudyStatus = (typeof STUDY_STATUSES)[number];
export const LINK_CHOICES = ["study", "reader", "both"] as const;
export type LinkChoice = (typeof LINK_CHOICES)[number];

const link = z.string().url().max(2048);
const uuid = z.string().uuid();
const tag = z.string().trim().min(1).max(40);
const topic = z.string().trim().min(1).max(80);

export const linkSave = z
  .object({
    operation: z.literal("link_save"),
    url: link,
    /** The owner's own words with the link; explicit cues decide the route. */
    ownerMessage: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export const studyList = z
  .object({
    operation: z.literal("study_list"),
    topic: topic.optional(),
    tag: tag.optional(),
    status: z.enum(STUDY_STATUSES).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export const studyUpdate = z
  .object({
    operation: z.literal("study_update"),
    id: uuid,
    status: z.enum(STUDY_STATUSES).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    tags: z.array(tag).max(12).optional(),
  })
  .strict();

export const studyRemove = z
  .object({ operation: z.literal("study_remove"), id: uuid })
  .strict();

export const linkMove = z
  .object({
    operation: z.literal("link_move"),
    /** A study entry to move to Reader. */
    id: uuid.optional(),
    /** The link to move from Reader into the study list. */
    url: link.optional(),
    to: z.enum(["reader", "study"]),
  })
  .strict();

/**
 * The writes that touch the study collection. Malformed input must be refused as
 * validation (a ToolValidationError) rather than recorded as an uncertain write, so a
 * shared `http://` link can never freeze every later write; and the agent's pending-MCP
 * gate lets these through because each one reconciles its own state.
 */
export const STUDY_WRITE_OPERATION_NAMES = [
  "link_save",
  "study_update",
  "study_remove",
  "link_move",
] as const;
export type StudyWriteOperation = (typeof STUDY_WRITE_OPERATION_NAMES)[number];
export const STUDY_WRITE_OPERATIONS: ReadonlySet<string> = new Set(
  STUDY_WRITE_OPERATION_NAMES,
);
