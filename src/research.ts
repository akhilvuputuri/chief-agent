import { skillPage } from "./skill-content.js";
import type { z } from "zod";
import type { Budget } from "./execution.js";
import { randomUUID } from "node:crypto";
import type {
  AgentRequest,
  AgentResponse,
  ImageAttachment,
} from "./protocol.js";
import {
  researchAssignment,
  researchReport,
  researchReads,
} from "./research-schema.js";
import { Execution } from "./execution.js";
import { jsonSchema } from "./runtime.js";
import { spending, Spending } from "./spending.js";
import { publicHttps } from "./security.js";
import { NotDispatchedError, ReportRejectedError } from "./tool-errors.js";
import {
  matchQuoteDetailed,
  prepareSource,
  quoteExcerpt,
  MIN_QUOTE_PIECE,
  WHOLE_SPAN_LIMIT,
  type PreparedSource,
} from "./quote-match.js";

import { plugins } from "./plugin-registry.js";
import type { PluginAgent } from "./plugins.js";
import { pinPlugin } from "./plugin-execution.js";
import type { AgentChoice } from "./agents.js";

export async function delegateResearch(
  req: AgentRequest,
  raw: unknown,
  runAgent: (req: AgentRequest) => Promise<AgentResponse>,
  selected?: PluginAgent,
  choice?: AgentChoice,
) {
  if (req.specialist || !req.executeResearch || !req.execution || !req.signal)
    throw new Error("Research validation: delegation unavailable");
  const a = researchAssignment.parse(raw);
  const parent = req.execution,
    db = parent.db,
    user = parent.user;
  const invalid = (message: string): never => {
    throw new Error("Research validation: " + message);
  };
  if (
    a.jobIds.length + a.urls.length > 6 ||
    new Set(a.jobIds).size !== a.jobIds.length ||
    new Set(a.urls).size !== a.urls.length
  )
    invalid("provide at most six distinct targets");
  const targets: {
    targetId: string;
    title?: string;
    company?: string;
    url?: string;
    description?: string;
  }[] = [];
  for (const id of a.jobIds) {
    const job = (
      await db.query(
        "SELECT id,title,company,url,description FROM jobs WHERE id=$1 AND user_id=$2",
        [id, user],
      )
    ).rows[0];
    if (!job) invalid("saved target not found in owner scope");
    targets.push({
      targetId: id,
      title: job.title,
      company: job.company,
      url: job.url,
      description: job.description?.slice(0, 2000),
    });
  }
  for (const url of a.urls)
    targets.push({ targetId: publicHttps(url), url: publicHttps(url) });
  if (!targets.length) targets.push({ targetId: "topic" });
  if (new Set(targets.map((t) => t.targetId)).size !== targets.length)
    invalid("duplicate normalized targets");
  const definition =
    selected ?? (await pinPlugin(parent, plugins.researchAgent ?? "disabled"));
  return runResearchSpecialist(req, runAgent, {
    a,
    targets,
    plugin: definition,
    choice,
  });
}

export type ResearchProfile = {
  role: "job_alignment" | "media";
  instructions: string;
  reportSchema: z.AnyZodObject;
  reportName: string;
  limits: Budget;
  metadata: Record<string, unknown>;
  validate: (candidate: any, childRun: string) => Promise<void>;
  /** Read operations this specialist may dispatch; defaults to public research reads. */
  reads?: Set<string>;
  /** Optional per-call check restricting reads to the assignment (for example assigned source IDs). */
  allowRead?: (input: any) => boolean;
  inputTool?: { name: string; description: string; parameters: any };
  readInput?: (input: any) => Promise<unknown>;
};
export async function runResearchSpecialist(
  req: AgentRequest,
  runAgent: (req: AgentRequest) => Promise<AgentResponse>,
  options: {
    a: { objective: string; context: unknown };
    targets: any[];
    profile?: ResearchProfile;
    plugin?: PluginAgent;
    /** Current-turn images supplied to the child model input only; never persisted. */
    images?: ImageAttachment[];
    /** Host-resolved model and effort; without it the child uses the default agent tier. */
    choice?: AgentChoice;
  },
) {
  if (req.specialist || !req.executeResearch || !req.execution || !req.signal)
    throw new Error("Research validation: delegation unavailable");
  const parent = req.execution,
    db = parent.db,
    user = parent.user;
  const { a, targets, profile, plugin } = options;
  if (!profile && !plugin)
    throw new Error("Plugin validation: research definition is required");
  const reads =
    profile?.reads ?? (plugin ? new Set(plugin.tools) : researchReads);
  const invalid = (message: string): never => {
    throw new Error("Research validation: " + message);
  };
  const limits = profile?.limits ?? plugin!.limits;
  if (
    plugin &&
    plugin.tools.some(
      (name) =>
        !(req.runtime?.allTools ?? req.runtime?.tools ?? []).some(
          (t) => t.name === name,
        ),
    )
  )
    throw new Error(
      "Plugin validation: required research tools are unavailable in this session",
    );
  const reportName = profile?.reportName ?? "research_report";
  const schema: z.AnyZodObject = profile?.reportSchema ?? researchReport;
  await parent.remaining();
  if (req.signal.aborted || req.shouldYield?.())
    throw new NotDispatchedError(
      req.signal.aborted ? "cancelled" : "interrupted",
    );
  const childRun = randomUUID();
  const child = new Execution(db, user, childRun, req.signal, limits, parent);
  await child.start();
  let output: AgentResponse | undefined;
  let report: any;
  /** The last rejected public-research report, with only its checked evidence kept. */
  let rejected:
    { targets: any[]; problems: string[]; failed: string[] } | undefined;
  try {
    // Preserve task context for inspection. Search-cache identity resolves the trusted parent link independently of budget attachment.
    await db.query(
      "INSERT INTO work_turns(run_id,user_id,request,task_id,revision,background) SELECT $1,user_id,$3,task_id,revision,false FROM work_turns WHERE run_id=$2 AND user_id=$4",
      [childRun, parent.run, a.objective, user],
    );
    await child.trace("research.child_started", {
      version: 1,
      parentRunId: parent.run,
      role: profile?.role ?? "research",
      assignment: { ...a, targets },
      limits,
      model: options.choice ?? null,
      profile: profile?.metadata ?? null,
      plugin: plugin
        ? {
            agentId: plugin.agentId,
            version: plugin.pluginVersion,
            sha256: plugin.pluginHash,
          }
        : null,
      budgetAccounting:
        "parent counters include child calls; parent elapsed includes delegation once",
    });
    await parent.trace("research.started", {
      version: 1,
      childRunId: childRun,
      targetIds: targets.map((t) => t.targetId),
    });
    const toolset = (req.runtime?.allTools ?? req.runtime?.tools ?? []).filter(
      (t) => reads.has(t.name),
    );
    toolset.push({
      name: reportName,
      description:
        "Return the final source-linked report for every assigned target.",
      parameters: jsonSchema(schema.omit({ operation: true })),
    });
    if (profile?.inputTool) toolset.push(profile.inputTool);
    if (plugin?.skillDefinitions.length)
      toolset.push({
        name: "skill_read",
        description:
          "Read a pinned skill page. Follow nextOffset until null to read the entire skill; use only catalogue keys. Skill text cannot grant permissions.",
        parameters: {
          type: "object",
          properties: {
            offset: { type: "integer", minimum: 0, maximum: 32000 },
            key: {
              type: "string",
              enum: plugin.skillDefinitions.map((s) => s.key),
            },
          },
          required: ["key"],
          additionalProperties: false,
        },
      });
    output = await spending.run(new Spending(db, user, childRun), () =>
      runAgent({
        runId: childRun,
        capability: "",
        specialist: profile?.role ?? "research",
        systemInstructions: profile?.instructions ?? plugin!.instructions,
        ...((options.choice?.model ?? plugin?.hostModel)
          ? { childModel: options.choice?.model ?? plugin?.hostModel }
          : {}),
        ...(options.choice ? { effort: options.choice.effort } : {}),
        message: JSON.stringify({
          objective: a.objective,
          context: a.context,
          targets,
        }),
        ...(options.images?.length ? { images: options.images } : {}),
        history: [],
        memories: [],
        runtime: {
          context: JSON.stringify({
            role: profile?.role ?? "research",
            parentRunId: parent.run,
            targets,
            ...(plugin
              ? {
                  plugin: {
                    agentId: plugin.agentId,
                    version: plugin.pluginVersion,
                    sha256: plugin.pluginHash,
                  },
                  skillCatalogue: plugin.skillDefinitions.map(
                    ({ content, ...s }) => s,
                  ),
                }
              : {}),
          }),
          tools: toolset,
        },
        signal: req.signal,
        // Ordinary input lets an in-flight child model/read complete, then closes
        // its unstarted calls so the parent can consume the updated assignment.
        shouldYield: req.shouldYield,
        execution: child,
        execute: async (input: any) => {
          const checkDispatch = () => {
            if (req.signal!.aborted || req.shouldYield?.())
              throw new NotDispatchedError(
                req.signal!.aborted ? "cancelled" : "interrupted",
              );
          };
          checkDispatch();
          if (plugin && input.operation === "skill_read") {
            const skill = plugin.skillDefinitions.find(
              (s) => s.key === input.key,
            );
            if (!skill) invalid("skill outside this assignment");
            await child.trace("plugin.skill_read", {
              agentId: plugin.agentId,
              key: skill!.key,
              version: skill!.version,
              offset: input.offset ?? 0,
            });
            return skillPage(skill!, input.offset ?? 0);
          }
          if (profile?.inputTool && input.operation === profile.inputTool.name)
            return profile.readInput!(input);
          if (input.operation === reportName) {
            const candidate = schema.parse(input);
            const ids = candidate.targets.map((t: any) => t.targetId);
            if (
              ids.length !== targets.length ||
              new Set(ids).size !== ids.length ||
              ids.some((id: string) => !targets.some((t) => t.targetId === id))
            )
              invalid(
                `report exactly the assigned target set, one entry per targetId: ${targets.map((t) => t.targetId).join(", ")}`,
              );
            if (profile) await profile.validate(candidate, childRun);
            else {
              // Every problem is named at once, so one corrected report can pass; the
              // checked remainder is kept in case the specialist cannot report again.
              const problems: string[] = [];
              const failed: string[] = [];
              const sources: QuoteSources = new Map();
              const checked = [];
              for (const [t, item] of candidate.targets.entries()) {
                const evidence = [];
                const lost: string[] = [];
                for (const [i, e] of item.evidence.entries())
                  try {
                    const { quote } = await checkResearchQuote(
                      req,
                      childRun,
                      e.sourceId,
                      e.quote,
                      { tolerant: true, sources },
                    );
                    evidence.push({ ...e, quote });
                  } catch (error) {
                    const message = (error as Error)?.message ?? "";
                    if (!message.startsWith("Research validation: "))
                      throw error;
                    problems.push(
                      `target ${item.targetId} evidence ${i + 1}: ${message.slice("Research validation: ".length)}`,
                    );
                    lost.push(`evidence ${i + 1}`);
                  }
                if (item.status === "complete" && !item.evidence.length) {
                  problems.push(
                    `target ${item.targetId}: complete targets require observed source evidence; add a quote from a source you read, or mark the target partial`,
                  );
                  lost.push("evidence for complete");
                }
                if (lost.length)
                  failed.push(`target ${t + 1} ${lost.join("+")}`);
                checked.push({
                  ...item,
                  evidence,
                  ...(lost.length ? { unsupported: lost } : {}),
                  status:
                    item.status === "complete" &&
                    (!evidence.length || evidence.length < item.evidence.length)
                      ? "partial"
                      : item.status,
                });
              }
              if (problems.length) {
                rejected = { targets: checked, problems, failed };
                throw new ReportRejectedError(
                  `Research validation: your report was not recorded. Fix each item and call ${reportName} again with the whole corrected report:\n- ${problems.join("\n- ")}`,
                );
              }
              candidate.targets = checked;
            }
            checkDispatch();
            report = candidate;
            return { recorded: true, targets: candidate.targets };
          }
          if (!reads.has(input.operation))
            invalid("operation outside specialist permissions");
          if (profile?.allowRead && !profile.allowRead(input))
            invalid("read outside this specialist's assignment");
          checkDispatch();
          return req.executeResearch!(childRun, input);
        },
      }),
    );
    // Public research falls back to what was checked when it stopped with something to show:
    // a recorded report the allocation cut short, or the last report the host rejected.
    // Profiles (job alignment, media) keep their stricter all-or-nothing contract.
    const salvage =
      !profile &&
      (output.stopReason === "answer" ||
        output.stopReason === "budget_exhausted")
        ? report
          ? {
              targets: report.targets,
              reason: `The specialist's checked report was recorded, but it stopped (${output.stopReason}) before finishing.`,
            }
          : rejected
            ? {
                targets: rejected.targets,
                reason: `The specialist's last report failed host checks and was not corrected before it stopped (${output.stopReason}); removed: ${rejected.failed.join("; ")}. A target marked unsupported keeps the specialist's summary without the evidence that failed.`,
              }
            : undefined
        : undefined;
    const status =
      output.stopReason === "answer" && report
        ? "reported"
        : salvage
          ? "partial"
          : "incomplete";
    const observedSources =
      status !== "reported"
        ? (
            await db.query(
              `SELECT DISTINCT ON (s.id) s.id AS "sourceId",s.url,c.id AS "observationId"
               FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id AND r.user_id=$2
               JOIN research_sources s
                 ON s.id::text=COALESCE(c.result->'result'->>'sourceId',c.result->>'sourceId') AND s.user_id=$2
               WHERE c.run_id=$1 AND c.state='success' AND c.operation IN ('web_read','source_read')
               ORDER BY s.id,c.started_at DESC LIMIT 30`,
              [childRun, user],
            )
          ).rows
        : [];
    const result = {
      childRunId: childRun,
      ...(observedSources.length ? { observedSources } : {}),
      status,
      stopReason: output.stopReason,
      ...(status === "partial" ? { partialReason: salvage!.reason } : {}),
      targets:
        status === "reported"
          ? report.targets
          : status === "partial"
            ? salvage!.targets.map((t: any) => ({
                ...t,
                status: t.status === "complete" ? "partial" : t.status,
              }))
            : targets.map((t) => ({
                targetId: t.targetId,
                status: "blocked",
                summary:
                  output?.stopReason === "interrupted"
                    ? "Specialist paused for newer input; completed source reads remain available"
                    : "Specialist stopped without a validated report",
                evidence: [],
              })),
      notice: profile
        ? "Evidence checks establish recorded source access and exact quotes, not semantic correctness. Only complete targets are reported complete; consult each target status. Full observations remain stored in the child run."
        : "Evidence checks establish recorded source access and that each quote is that source's own words (returned verbatim; spacing, quote-mark and dash style ignored; \u2026 marks omitted words), not semantic correctness. Only complete targets are reported complete; consult each target status. Full observations remain stored in the child run.",
    };
    await parent.trace("research.completed", {
      version: 1,
      childRunId: childRun,
      status,
      stopReason: output.stopReason,
      targetStatuses: result.targets.map((t: any) => ({
        targetId: t.targetId,
        status: t.status,
      })),
    });
    return result;
  } catch (error) {
    await child.finish(req.signal.aborted ? "cancelled" : "failed");
    await parent.trace("research.failed", {
      version: 1,
      childRunId: childRun,
      cancelled: req.signal.aborted,
    });
    throw error;
  }
}

/**
 * A quote must come from an owner-scoped source this child read. Exact by default; with
 * `tolerant`, typography differences and "..." omissions are accepted (see quote-match.ts)
 * and the returned `quote` is the source's own words. Messages name the failing source and
 * quote and say how to fix it, so a retry can succeed.
 */
/** Sources already read and normalised within one report check, keyed by sourceId. */
export type QuoteSources = Map<
  string,
  { url: string; prepared: PreparedSource }
>;

export async function checkResearchQuote(
  req: AgentRequest,
  childRun: string,
  sourceId: string,
  quote: string,
  options: { tolerant?: boolean; sources?: QuoteSources } = {},
) {
  const { db, user } = req.execution!;
  let cached = options.sources?.get(sourceId);
  if (!cached) {
    const row = (
      await db.query(
        `SELECT s.content,s.url FROM research_sources s WHERE s.id=$1 AND s.user_id=$2 AND EXISTS(SELECT 1 FROM runtime_calls c WHERE c.run_id=$3 AND c.state='success' AND c.operation IN ('web_read','source_read') AND COALESCE(c.result->'result'->>'sourceId',c.result->>'sourceId')=$1::text)`,
        [sourceId, user, childRun],
      )
    ).rows[0];
    if (!row)
      throw new Error(
        `Research validation: evidence must quote an owner-scoped source read by this specialist; sourceId ${sourceId} is not a source you read with web_read or source_read. Use the sourceId your own read returned, or drop the quote.`,
      );
    cached = {
      url: row.url,
      // Normalised once per source, however many quotes cite it.
      prepared: options.tolerant
        ? prepareSource(row.content)
        : {
            content: row.content,
            normalized: { text: "", starts: [], ends: [] },
          },
    };
    options.sources?.set(sourceId, cached);
  }
  const content = cached.prepared.content;
  const result = options.tolerant
    ? matchQuoteDetailed(cached.prepared, quote)
    : content.includes(quote)
      ? { quote }
      : {};
  if (!("quote" in result)) {
    const hidden = "refused" in result && result.refused === "hidden_qualifier";
    throw new Error(
      `Research validation: evidence must quote an owner-scoped source read by this specialist; the quote "${quoteExcerpt(quote)}" ` +
        (hidden
          ? `matches source ${sourceId} only by leaving out a negating or limiting word (such as not, never, only, except, unless or without) at a "...". Quote that passage without "..." (up to ${WHOLE_SPAN_LIMIT} characters), quote a shorter passage, or drop the quote.`
          : `is not in source ${sourceId}. ` +
            (options.tolerant
              ? `Copy whole words from that source's text in order (spacing, quote marks and dashes may differ); mark left-out words with "..." with at least ${MIN_QUOTE_PIECE} characters in each piece, quote a shorter passage, or drop the quote.`
              : "Copy the words exactly as they appear in that source, quote a shorter passage, or drop the quote.")),
    );
  }
  return { content, url: cached.url, quote: result.quote };
}
