import { linkResolve } from "./link-schema.js";
import { mcpTools, mcpRead, mcpWrite, mcpOperation } from "./mcp-schema.js";
import {
  start as gatherStart,
  revise as gatherRevise,
  status as gatherStatus,
  progress as gatherProgress,
  search as gatherSearch,
  emailFiles as gatherEmailFiles,
  capture as gatherCapture,
  match as gatherMatch,
  check as gatherCheck,
  block as gatherBlock,
  finish as gatherFinish,
  browser as gatherBrowser,
} from "./gathering/schema.js";
import { TOOL_DOMAINS } from "./tool-domains.js";
import {
  canvasCreate,
  canvasUpdate,
  canvasRead,
  canvasList,
} from "./canvas-schema.js";
import type { Answer } from "./answer.js";
import {
  alignmentStart,
  alignmentResume,
  alignmentRead,
  alignmentInput,
  alignmentReport,
} from "./alignment-schema.js";
import { agentRun, agentReport } from "./agent-schema.js";
import { researchReport } from "./research-schema.js";
import { mediaReport } from "./media-schema.js";
import { calendarDraft } from "./calendar-draft.js";
import {
  subscriptionRecord,
  subscriptionList,
  subscriptionSettings,
} from "./subscription-schema.js";
import { parcelRecord, parcelList, parcelMatch } from "./parcel-schema.js";
import {
  responsibilityCreate,
  responsibilityUpdate,
  responsibilityList,
  responsibilityHistory,
  responsibilityReport,
} from "./responsibility-schema.js";
import {
  libraryAvailability,
  libraryCheck,
  libraryShelf,
} from "./library-schema.js";
import { z } from "zod";
import {
  codingStart,
  codingStatus,
  codingReply,
  codingCancel,
  codingResume,
  codingModels,
  codingModelSet,
} from "./coding/schema.js";
const id = z.string().uuid();
// Singapore-time monitoring window; end < start runs past midnight, 24:00 = end of day.
const monitoringWindow = z
  .object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/),
    days: z
      .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
      .min(1)
      .max(7)
      .nullable()
      .optional(),
  })
  .strict();
const text = z.string().min(1).max(20000);
export const status = z.enum([
  "saved",
  "interested",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "archived",
]);
const skillKey = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,49}(?:\/[a-z][a-z0-9-]{0,47})?$/);
const workKey = z.string().regex(/^[a-z0-9_-]{1,60}$/);
const workSteps = z
  .array(
    z
      .object({
        key: workKey,
        title: z.string().min(1).max(300),
        verification: z.enum(["evidence", "action", "analysis"]),
        expectedOperation: z
          .string()
          .regex(/^[a-z_]{1,60}$/)
          .optional(),
      })
      .strict(),
  )
  .min(1)
  .max(100)
  .refine(
    (steps) =>
      steps.every((s) => s.verification !== "action" || !!s.expectedOperation),
    "Action steps require expectedOperation",
  )
  .refine(
    (x) => new Set(x.map((s) => s.key)).size === x.length,
    "Unique step keys required",
  );
export const action = z.discriminatedUnion("operation", [
  linkResolve,
  mcpTools,
  mcpRead,
  mcpWrite,
  mcpOperation,
  z
    .object({
      operation: z.literal("conversation_search"),
      query: z.string().min(1).max(300),
    })
    .strict(),
  z
    .object({
      operation: z.literal("conversation_read"),
      id: z.string().uuid(),
      offset: z.number().int().min(0).max(10000000).default(0),
    })
    .strict(),
  canvasCreate,
  canvasUpdate,
  canvasRead,
  canvasList,
  alignmentStart,
  alignmentResume,
  alignmentRead,
  alignmentInput,
  alignmentReport,
  agentRun,
  agentReport,
  researchReport,
  mediaReport,
  calendarDraft.extend({ operation: z.literal("calendar_draft") }).strict(),
  libraryCheck,
  libraryAvailability,
  libraryShelf,
  z
    .object({
      operation: z.literal("observation_read"),
      id,
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  z
    .object({
      operation: z.literal("source_read"),
      id,
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  z
    .object({
      operation: z.literal("work_start"),
      objective: z.string().min(1).max(4000),
      steps: workSteps,
    })
    .strict(),
  z
    .object({
      operation: z.literal("work_revise"),
      id,
      objective: z.string().min(1).max(4000),
      steps: workSteps,
    })
    .strict(),
  z
    .object({
      operation: z.literal("work_status"),
      id: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("work_step"),
      id,
      key: workKey,
      status: z.enum(["pending", "done", "blocked"]),
      result: z.string().max(6000),
      proofs: z.array(id).max(30).default([]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("work_evidence"),
      id,
      sourceId: id,
      claim: z.string().min(1).max(2000),
      sourceQuote: z.string().min(1).max(4000),
      applicability: z.enum(["matched", "unverified", "mismatch"]),
      reason: z.string().min(1).max(2000),
    })
    .strict(),
  z.object({ operation: z.literal("work_yield"), id }).strict(),
  z.object({ operation: z.literal("work_cancel"), id }).strict(),
  z
    .object({
      operation: z.literal("item_save"),
      kind: z.enum(["task", "note"]),
      title: z.string().trim().min(1).max(300),
      content: z.string().max(6000).default(""),
      dueAt: z.string().datetime({ offset: true }).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("item_list"),
      kind: z.enum(["task", "note"]).optional(),
      status: z.enum(["open", "done", "archived"]).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("item_update"),
      id,
      title: z.string().trim().min(1).max(300).optional(),
      content: z.string().max(6000).optional(),
      status: z.enum(["open", "done", "archived"]).optional(),
      dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("schedule_create"),
      kind: z.enum(["reminder", "briefing"]),
      content: z.string().trim().min(1).max(2000),
      schedule: z.string().trim().min(1).max(150),
      includeEmail: z.boolean().default(false),
      includeCalendar: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      operation: z.literal("routine_create"),
      name: z.string().trim().min(1).max(150),
      instruction: z.string().trim().min(1).max(12000),
      schedule: z.string().trim().min(1).max(150),
      missedPolicy: z.enum(["latest", "skip"]).default("latest"),
    })
    .strict(),
  z.object({ operation: z.literal("routine_list") }).strict(),
  z.object({ operation: z.literal("routine_history"), id }).strict(),
  z
    .object({
      operation: z.literal("routine_update"),
      id,
      name: z.string().trim().min(1).max(150).optional(),
      instruction: z.string().trim().min(1).max(12000).optional(),
      schedule: z.string().trim().min(1).max(150).optional(),
      status: z.enum(["scheduled", "paused", "cancelled"]).optional(),
      missedPolicy: z.enum(["latest", "skip"]).optional(),
    })
    .strict(),
  z.object({ operation: z.literal("schedule_list") }).strict(),
  z
    .object({
      operation: z.literal("watchlist_add"),
      query: z.string().trim().min(1).max(100),
      exchange: z.string().trim().min(1).max(100).optional(),
      dropPct: z.number().min(0.1).max(50).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("watchlist_update"),
      id,
      dropPct: z.number().min(0.1).max(50).nullable().optional(),
      status: z.enum(["active", "paused"]).optional(),
      window: monitoringWindow.nullable().optional(),
    })
    .strict(),
  z.object({ operation: z.literal("watchlist_remove"), id }).strict(),
  z
    .object({
      operation: z.literal("news_source_add"),
      site: z.string().trim().min(3).max(300),
      name: z.string().trim().min(1).max(80).optional(),
    })
    .strict(),
  z.object({ operation: z.literal("news_source_remove"), id }).strict(),
  z
    .object({
      operation: z.literal("news_settings"),
      deliveryTime: z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
        .nullable()
        .optional(),
      topics: z
        .array(z.string().trim().min(1).max(60))
        .max(20)
        .nullable()
        .optional(),
      itemsPerEdition: z.number().int().min(1).max(8).optional(),
      enabled: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("feed_read"),
      kind: z.enum(["news", "markets", "updates"]),
      id: z.string().uuid(),
      offset: z.number().int().min(0).default(0),
    })
    .strict(),
  z.object({ operation: z.literal("news_status") }).strict(),
  z.object({ operation: z.literal("news_edition_now") }).strict(),
  z.object({ operation: z.literal("watchlist_list") }).strict(),
  z
    .object({
      operation: z.literal("stock_rule_add"),
      scope: z.enum(["item", "holdings", "watchlist"]),
      itemId: id.optional(),
      direction: z.enum(["below", "above"]),
      reference: z.enum([
        "prev_close",
        "avg_cost",
        "avg_12w",
        "avg_26w",
        "avg_52w",
        "low_12w",
        "low_26w",
        "low_52w",
        "high_12w",
        "high_26w",
        "high_52w",
        "all_time_low",
        "all_time_high",
      ]),
      marginPct: z.number().min(0).max(90).optional(),
      basis: z.enum(["intraday", "close"]),
      notify: z.enum(["cross", "daily"]).optional(),
      label: z.string().trim().min(1).max(200),
    })
    .strict(),
  z.object({ operation: z.literal("stock_rule_list") }).strict(),
  z
    .object({
      operation: z.literal("stock_rule_update"),
      id,
      status: z.enum(["active", "paused"]).optional(),
      marginPct: z.number().min(0).max(90).optional(),
      notify: z.enum(["cross", "daily"]).optional(),
      label: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  z.object({ operation: z.literal("stock_rule_remove"), id }).strict(),
  z
    .object({
      operation: z.literal("stock_lookup"),
      query: z.string().trim().min(1).max(100).optional(),
      exchange: z.string().trim().min(1).max(100).optional(),
      id: id.optional(),
    })
    .strict(),
  z.object({ operation: z.literal("portfolio_read") }).strict(),
  z.object({ operation: z.literal("portfolio_status") }).strict(),
  z.object({ operation: z.literal("portfolio_connect") }).strict(),
  z.object({ operation: z.literal("portfolio_disconnect") }).strict(),
  z
    .object({
      operation: z.literal("watchlist_settings"),
      defaultDropPct: z.number().min(0.1).max(50).optional(),
      paused: z.boolean().optional(),
      pollMinutes: z.number().int().min(5).max(240).optional(),
      includeExtended: z.boolean().optional(),
      window: monitoringWindow.nullable().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("schedule_update"),
      id,
      status: z.enum(["paused", "cancelled", "scheduled"]).optional(),
      schedule: z.string().trim().min(1).max(150).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("calendar_list"),
      start: z.string().datetime({ offset: true }),
      end: z.string().datetime({ offset: true }),
    })
    .strict(),
  z.object({ operation: z.literal("daily_sync") }).strict(),

  z.object({ operation: z.literal("skill_list") }).strict(),
  z
    .object({
      operation: z.literal("skill_read"),
      key: skillKey,
      offset: z.number().int().min(0).max(32000).optional(),
    })
    .strict(),
  z
    .object({ operation: z.literal("skill_version_read"), key: skillKey, id })
    .strict(),
  z.object({ operation: z.literal("skill_history"), key: skillKey }).strict(),
  z
    .object({
      operation: z.literal("skill_draft"),
      key: skillKey,
      content: z.string().trim().min(1).max(12000),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      operation: z.literal("skill_evaluate"),
      id,
      report: z.string().trim().min(40).max(6000),
    })
    .strict(),
  z.object({ operation: z.literal("skill_activate"), id }).strict(),
  z.object({ operation: z.literal("prep_list"), id: id.optional() }).strict(),
  z
    .object({
      operation: z.literal("prep_task_read"),
      id,
      offset: z.number().int().min(0).default(0),
      version: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("prep_save"),
      id,
      topic: z.string().trim().min(1).max(200),
      importance: z.enum(["required", "preferred", "inferred"]),
      sourceId: id.optional(),
      sourceQuote: z.string().min(1).max(2000),
      assessment: z.enum(["strength", "gap", "unknown"]),
      evidence: z.string().max(4000).default(""),
      question: z.string().max(1000).default(""),
    })
    .strict(),
  z
    .object({
      operation: z.literal("prep_task_save"),
      topic: z.string().trim().min(1).max(200),
      exercise: z.string().min(1).max(4000),
      completionCriteria: z.string().min(1).max(2000),
      priority: z.enum(["high", "medium", "low"]),
      status: z.enum(["todo", "doing", "done"]).optional(),
      links: z
        .array(
          z
            .object({
              scopeId: id,
              jobId: id,
              preparationId: z.string().trim().min(1).max(60),
            })
            .strict(),
        )
        .min(1)
        .max(16)
        .optional(),
    })
    .strict(),
  subscriptionRecord,
  subscriptionList,
  subscriptionSettings,
  gatherStart,
  gatherRevise,
  gatherStatus,
  gatherProgress,
  gatherSearch,
  gatherEmailFiles,
  gatherCapture,
  gatherMatch,
  gatherCheck,
  gatherBlock,
  gatherFinish,
  gatherBrowser,
  parcelRecord,
  codingStart,
  codingStatus,
  codingReply,
  codingCancel,
  codingResume,
  codingModels,
  codingModelSet,
  responsibilityCreate,
  responsibilityUpdate,
  responsibilityList,
  responsibilityHistory,
  responsibilityReport,
  parcelList,
  parcelMatch,
  z.object({ operation: z.literal("sheet_sync") }).strict(),
  z.object({ operation: z.literal("gmail_accounts") }).strict(),
  z
    .object({
      operation: z.literal("gmail_search"),
      account: z.string().min(1).max(254).optional(),
      query: z.string().min(1).max(500),
      pageToken: z.string().max(1000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("gmail_read"),
      account: z.string().min(1).max(254).optional(),
      messageId: z.string().regex(/^[a-f0-9]{1,64}$/i),
    })
    .strict(),
  z
    .object({
      operation: z.literal("gmail_thread"),
      account: z.string().min(1).max(254).optional(),
      threadId: z.string().regex(/^[a-f0-9]{1,64}$/i),
    })
    .strict(),
  z
    .object({
      operation: z.literal("job_save"),
      title: z.string().min(1).max(300),
      company: z.string().min(1).max(300),
      url: z.string().url().optional(),
      description: text.optional(),
    })
    .strict(),
  z
    .object({ operation: z.literal("job_list"), status: status.optional() })
    .strict(),
  z
    .object({
      operation: z.literal("job_update"),
      id,
      status: status.optional(),
      notes: text.optional(),
    })
    .strict(),
  z.object({ operation: z.literal("job_analyze"), id }).strict(),
  z.object({ operation: z.literal("job_delete"), id }).strict(),
  z
    .object({
      operation: z.literal("memory_set"),
      key: z.string().regex(/^[a-z_]{1,50}$/),
      value: z.string().min(1).max(4000),
    })
    .strict(),
  z.object({ operation: z.literal("memory_list") }).strict(),
  z
    .object({
      operation: z.literal("web_search"),
      query: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({ operation: z.literal("web_read"), url: z.string().url() })
    .strict(),
  z
    .object({
      operation: z.literal("tools_load"),
      domains: z.array(z.enum(TOOL_DOMAINS)).min(1).max(TOOL_DOMAINS.length),
    })
    .strict(),
]);
export type Action = z.infer<typeof action>;
/** An image supplied for the current turn only; bytes are never persisted in history or traces. */
export interface ImageAttachment {
  /** Per-turn attachment ID the media agent reads; invalid after the turn ends. */
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  data: string; // base64
  sha256?: string;
}
export interface AgentRequest {
  runId: string;
  /** Stable per-owner provider cache key. Provider prompt caches are partitioned by it. */
  cacheKey?: string;
  capability: string;
  message: string;
  images?: ImageAttachment[];
  history: unknown[];
  historyOmitted?: number;
  /** Stable start of this foreground exchange, including all absorbed follow-ups. */
  turnStart?: number;
  managedDelivery?: boolean;
  conversationSummary?: string;
  shouldYield?: () => boolean;
  /** Host-claimed ordered inputs at a safe boundary. No model-supplied identity. */
  steer?: () => Promise<Array<{ id: string; message: string }>>;
  afterTool?: (operation: string) => void;
  modelSignal?: AbortSignal;
  memories: { key: string; value: string }[];
  runtime?: {
    context: string;
    tools?: import("./model.js").ToolDefinition[];
    /** Every enabled definition, for specialist delegation, when tools are domain-limited. */
    allTools?: import("./model.js").ToolDefinition[];
  };
  /** Adds tool domains for the rest of this turn (issue #77). */
  loadTools?: (domains: string[]) => Promise<{
    loaded: string[];
    offered: number;
    unavailable?: string[];
    note?: string;
  }>;
  specialist?: "research" | "job_alignment" | "media" | "agent";
  systemInstructions?: string;
  /** Host-resolved model ID for a child run (from a model tier or a host override), never a raw tool argument. */
  childModel?: string;
  /**
   * A host-decided first step (Telegram topics, phase 2): the run starts by dispatching this
   * call instead of asking the model for it. It is journaled like any model-made call, so
   * history, approvals and later steps are unchanged; the model takes over from the result.
   */
  firstCall?: { name: "agent_run"; arguments: string; reason: string };
  /** Reasoning effort for this run's model calls; medium when unset. */
  effort?: import("./model.js").ReasoningEffort;
  executeResearch?: (run: string, input: unknown) => Promise<unknown>;
  /** Dispatches a domain agent's call under its child run, after the host checks that run's granted tools. */
  executeAgent?: (run: string, input: unknown) => Promise<unknown>;
  /** Current host state a domain agent needs (for example pending Calendar approvals), by agent ID. */
  agentState?: (agentId: string) => Promise<unknown>;
  refreshContext?: () => Promise<void>;
  execution?: import("./execution.js").Execution;
  execute?: (input: unknown) => Promise<unknown>;
  signal?: AbortSignal;
  progress?: (text: string) => Promise<void>;
}
export interface AgentResponse extends Answer {
  reply: string;
  history: unknown[];
  interrupted?: boolean;
  undeliveredMessageIndices?: number[];
  stopReason?: import("./execution.js").StopReason;
}
export const agentResponse = z.object({
  interrupted: z.boolean().optional(),
  reply: z.string().max(50000),
  history: z.array(z.unknown()).max(1000),
});
