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
import { NotDispatchedError } from "./tool-errors.js";

import { plugins } from "./plugin-registry.js";
import type { PluginAgent } from "./plugins.js";
import { pinPlugin } from "./plugin-execution.js";

export async function delegateResearch(
  req: AgentRequest,
  raw: unknown,
  runAgent: (req: AgentRequest) => Promise<AgentResponse>,
  selected?: PluginAgent,
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
  if (definition.contract !== "public-research/v1")
    invalid("public research requires the public research contract");
  return runResearchSpecialist(req, runAgent, {
    a,
    targets,
    plugin: definition,
  });
}

export type ResearchProfile = {
  role: "job_alignment" | "media" | "parcel";
  instructions: string;
  reportSchema: z.AnyZodObject;
  reportName: string;
  limits: Budget;
  metadata: Record<string, unknown>;
  validate: (
    candidate: unknown,
    childRun: string,
  ) => Promise<void | { targets: unknown[] }>;
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
        name !== profile?.inputTool?.name &&
        !(req.runtime?.tools ?? []).some((t) => t.name === name),
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
    const toolset = (req.runtime?.tools ?? []).filter((t) => reads.has(t.name));
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
        ...(plugin?.model ? { pluginModel: plugin.model } : {}),
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
              invalid("report exactly the assigned target set");
            if (profile)
              report =
                (await profile.validate(candidate, childRun)) ?? candidate;
            else
              for (const item of candidate.targets) {
                if (item.status === "complete" && !item.evidence.length)
                  invalid("complete targets require observed source evidence");
                for (const e of item.evidence)
                  await checkResearchQuote(req, childRun, e.sourceId, e.quote);
              }
            checkDispatch();
            if (!profile) report = candidate;
            return { recorded: true, targets: report.targets };
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
    const status =
      output.stopReason === "answer" && report ? "reported" : "incomplete";
    const observedSources =
      status === "incomplete"
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
      targets:
        report?.targets ??
        targets.map((t) => ({
          targetId: t.targetId,
          status: "blocked",
          summary:
            output?.stopReason === "interrupted"
              ? "Specialist paused for newer input; completed source reads remain available"
              : "Specialist stopped without a validated report",
          evidence: [],
        })),
      notice:
        "Evidence checks establish recorded source access and exact quotes, not semantic correctness. Only complete targets are reported complete; consult each target status. Full observations remain stored in the child run.",
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

export async function checkResearchQuote(
  req: AgentRequest,
  childRun: string,
  sourceId: string,
  quote: string,
) {
  const { db, user } = req.execution!;
  const source = (
    await db.query(
      `SELECT s.content,s.url FROM research_sources s WHERE s.id=$1 AND s.user_id=$2 AND EXISTS(SELECT 1 FROM runtime_calls c WHERE c.run_id=$3 AND c.state='success' AND c.operation IN ('web_read','source_read') AND COALESCE(c.result->'result'->>'sourceId',c.result->>'sourceId')=$1::text)`,
      [sourceId, user, childRun],
    )
  ).rows[0];
  if (!source || !source.content.includes(quote))
    throw new Error(
      "Research validation: evidence must quote an owner-scoped source read by this specialist",
    );
  return source;
}
