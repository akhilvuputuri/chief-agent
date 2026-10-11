import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, realpath, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { TaskStore } from "./store.js";
import { Workspace, type Executor } from "./workspace.js";
import { tools } from "./tools.js";
import { documents } from "./documents.js";
import { reportLimits, reportDocument, type ReportDocument } from "./report.js";
import { resources } from "./resources.js";
import type { ModelFactory } from "./model.js";
import {
  defaultLimits,
  type Task,
  type StartRequest,
  type RuntimeEvent,
  type Report,
} from "./types.js";

export type RuntimeOptions = {
  store: TaskStore;
  model: ModelFactory;
  executor?: (task: Task) => Executor;
  onEvent?: (task: Task, event: RuntimeEvent) => Promise<void>;
  onCheckpoint?: (task: Task) => Promise<void>;
};
export function planHash(task: Task, text: string, revision = task.revision) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: task.id,
        revision,
        base: task.base,
        workspace: task.workspace,
        objective: task.objective,
        instructions: task.ownerInstructions,
        checks: task.checkCommands,
        text,
      }),
    )
    .digest("hex");
}
export class CodingRuntime {
  private active?: { id: string; stop: AbortController; cancelled: boolean };
  constructor(private options: RuntimeOptions) {}
  async start(request: StartRequest): Promise<Task> {
    const workspace = await realpath(request.workspace);
    await mkdir(this.options.store.root, { recursive: true, mode: 0o700 });
    const store = await realpath(this.options.store.root);
    const outside = (from: string, to: string) => {
      const path = relative(from, to);
      return path === ".." || path.startsWith("../");
    };
    if (!outside(workspace, store) || !outside(store, workspace))
      throw new Error("Private task storage and workspace must be disjoint");
    if (!request.objective.trim() || request.objective.length > 24000)
      throw new Error("Objective must be complete and bounded");
    if (
      request.instructions !== undefined &&
      typeof request.instructions !== "string"
    )
      throw new Error("Instructions must be text");
    if (
      request.checks !== undefined &&
      (!Array.isArray(request.checks) ||
        request.checks.length > 32 ||
        request.checks.some(
          (c) => typeof c !== "string" || !c.trim() || c.length > 1000,
        ))
    )
      throw new Error("Checks must be a bounded list of commands");
    if ((request.instructions?.length ?? 0) > 32000)
      throw new Error("Instructions exceed supported bound");
    documents(request.referenceDocuments ?? []);
    const base = (
      await promisify(execFile)("git", ["rev-parse", "HEAD"], {
        cwd: workspace,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      })
    ).stdout.trim();
    if (!/^[a-f0-9]{40}$/.test(base))
      throw new Error("Workspace needs a pinned Git commit");
    const limits = { ...defaultLimits, ...request.limits };
    if (Object.values(limits).some((v) => !Number.isSafeInteger(v) || v <= 0))
      throw new Error("Invalid allocation");
    const task: Task = {
      version: 1,
      id: randomUUID(),
      revision: 1,
      intent: request.intent ?? "plan",
      status: "ready",
      workspace,
      base,
      ownerInstructions: request.instructions ?? "",
      referenceDocuments: request.referenceDocuments,
      objective: request.objective,
      instructions: request.instructions ?? "",
      limits,
      used: { models: 0, tools: 0, ms: 0 },
      checkCommands: request.checks ?? [],
      summary: "Ready",
      checks: [],
      events: [],
    };
    await this.options.store.save(task);
    return task;
  }
  inspect(id: string) {
    return this.options.store.get(id);
  }
  private async event(task: Task, type: RuntimeEvent["type"], text: string) {
    const event: RuntimeEvent = {
      sequence: (task.events.at(-1)?.sequence ?? 0) + 1,
      type,
      text: text.slice(0, 4000),
    };
    task.events.push(event);
    if (task.events.length > 2000) task.events.shift();
    await this.options.store.save(task);
    await this.options.onEvent?.(task, event);
  }
  private async change(id: string, apply: (task: Task) => Promise<Task>) {
    if (this.active) throw new Error("Cannot change an active task");
    const unlock = await this.options.store.lock();
    try {
      return await apply(await this.inspect(id));
    } finally {
      await unlock();
    }
  }
  async approve(id: string, revision: number, hash: string) {
    return this.change(id, async (task) => {
      if (task.approved?.revision === revision && task.approved.hash === hash)
        return task;
      if (
        task.status !== "waiting_approval" ||
        task.plan?.revision !== revision ||
        task.plan.hash !== hash
      )
        throw new Error("Approval is stale or not bound to this plan");
      task.approved = { revision, hash };
      task.intent = "build";
      task.status = "ready";
      await this.event(task, "state", "Exact plan approved; build is ready");
      return task;
    });
  }
  async reply(id: string, revision: number, message: string) {
    return this.change(id, async (task) => {
      if (
        task.revision !== revision ||
        !["waiting_input", "waiting_approval", "completed", "paused"].includes(
          task.status,
        ) ||
        !message.trim() ||
        message.length > 8000 ||
        task.objective.length + message.length > 24000
      )
        throw new Error("Reply is stale or unavailable");
      task.objective += `\nOwner clarification:\n${message}`;
      task.revision++;
      task.intent = "plan";
      task.status = "ready";
      task.plan = undefined;
      task.approved = undefined;
      task.report = undefined;
      task.reportFailure = undefined;
      task.referenceDocuments = undefined;
      task.checks = [];
      await this.event(task, "state", "Scope revised; new plan required");
      return task;
    });
  }
  async cancel(id: string) {
    if (this.active?.id === id) {
      this.active.cancelled = true;
      this.active.stop.abort();
      return;
    }
    const task = await this.inspect(id);
    if (task.status === "running") {
      await this.options.store.requestCancel(id);
      return;
    }
    await this.change(id, async (current) => {
      current.status = "cancelled";
      await this.event(current, "state", "Cancelled");
      return current;
    });
  }
  async resume(id: string) {
    if (this.active) throw new Error("Runtime already has active work");
    const task = await this.inspect(id);
    if (task.status !== "paused")
      throw new Error(
        "Only an inspected paused task may be explicitly resumed",
      );
    await this.options.store.reconcileLock();
    return this.change(id, async (current) => {
      if (current.status !== "paused")
        throw new Error("Task changed before resume");
      current.status = "ready";
      await this.event(
        current,
        "state",
        "Explicit resume requested; reconcile uncertain workspace operations first",
      );
      return current;
    });
  }
  async run(id: string): Promise<Task> {
    if (this.active) throw new Error("Runtime already has active work");
    const unlock = await this.options.store.lock();
    const task = await this.inspect(id).catch(async (error) => {
      await unlock();
      throw error;
    });
    if (task.status !== "ready") {
      await unlock();
      throw new Error("Task is not ready; explicit action required");
    }
    let session:
      Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = new AbortController();
    this.active = { id, stop, cancelled: false };
    const started = performance.now();
    const poll = setInterval(() => {
      void this.options.store
        .cancellation(id)
        .then((cancel) => {
          if (cancel && this.active?.id === id) {
            this.active.cancelled = true;
            stop.abort();
          }
        })
        .catch(() => stop.abort());
    }, 250);
    poll.unref();
    try {
      if (task.status !== "ready")
        throw new Error("Task is not ready; explicit action required");
      if (
        task.intent === "build" &&
        (!task.plan ||
          task.approved?.hash !== task.plan.hash ||
          task.approved.revision !== task.plan.revision ||
          task.plan.hash !==
            planHash(task, task.plan.text, task.plan.revision) ||
          !task.checkCommands.length)
      )
        throw new Error(
          "Build requires exact approved requirements and configured checks",
        );
      task.activeRun = {
        startedAt: Date.now(),
        reservedMs: Math.max(0, task.limits.ms - (task.used.ms ?? 0)),
      };
      task.status = "running";
      task.runnerPid = process.pid;
      task.report = undefined;

      task.checks = [];
      await this.event(task, "state", `Running ${task.intent}`);
      await this.options.store.clearCancel(id);
      if ((task.used.ms ?? 0) >= task.limits.ms)
        throw new Error("Time allocation exhausted");
      timer = setTimeout(
        () => stop.abort(),
        task.limits.ms - (task.used.ms ?? 0),
      );
      timer.unref();
      // Planning is an evidence-gathering pass, not an open-ended repository audit.
      // End only at a settled tool boundary; never abort/replay an in-flight call.
      const planningUntil =
        performance.now() +
        Math.min(600_000, (task.limits.ms - (task.used.ms ?? 0)) * 0.75);
      let planningReads = 0;
      let planningHandoff = false;
      let finalizing = !!task.reportFailure;
      let finalTurns = 0;
      let pending = Promise.resolve();
      const admitModel = async () => {
        await pending;
        if (stop.signal.aborted || task.used.models >= task.limits.models)
          throw new Error("Model allocation unavailable");
        task.used.models++;
        await this.options.store.save(task);
      };
      const { runtime, model, reasoning, didRejectContextLocally } =
        await this.options.model(admitModel);
      const workspace = await new Workspace(task.workspace).initialize();
      const agentsFiles: Array<{ path: string; content: string }> = [];
      try {
        const data = await workspace.read("AGENTS.md");
        if (data.length > 64000)
          throw new Error("Project instructions exceed the supported bound");
        agentsFiles.push({
          path: join(task.workspace, "AGENTS.md"),
          content: new TextDecoder("utf-8", { fatal: true }).decode(data),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      let report: ReportDocument | undefined;
      const references = documents([
        ...(task.referenceDocuments ?? []),
        ...(task.intent === "build" && (task.plan?.text.length ?? 0) > 6000
          ? [
              {
                id: "approved_plan",
                title: "Complete owner-approved plan (scope authority)",
                text: task.plan!.text,
              },
            ]
          : []),
      ]);
      const approvedScope =
        task.intent === "build" &&
        references.description.includes("approved_plan:")
          ? "Read every page of approved_plan with read_document. The exact immutable plan remains the approved scope."
          : task.plan?.text;

      const execute = this.options.executor?.(task);
      const custom = tools(
        workspace,
        task.intent,
        execute,
        (r) => {
          report = reportDocument(r);
        },
        async (name) => {
          await pending;
          if (["edit", "write", "bash"].includes(name) || name === "report") {
            const missing = references.unread();
            if (missing.length)
              throw new Error(
                `Read all pages of required task documents first: ${missing.join(", ")}`,
              );
          }
          if (finalizing && name !== "report")
            throw new Error(
              "Investigation complete; only report execution is permitted",
            );
          if (stop.signal.aborted || task.used.tools >= task.limits.tools)
            throw new Error("Tool allocation unavailable");
          task.used.tools++;
          await this.options.store.save(task);
        },
      );
      if (references.description)
        custom.push({
          ...references.tool,
          executionMode: "sequential",
          execute: async (...args) => {
            await pending;
            if (stop.signal.aborted || task.used.tools >= task.limits.tools)
              throw new Error("Tool allocation unavailable");
            task.used.tools++;
            await this.options.store.save(task);
            return references.tool.execute(...args);
          },
        });
      const sessionDir = join(
        this.options.store.path(id),
        `sessions-${task.revision}-${task.intent}`,
      );
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      const sessionFiles = (await readdir(sessionDir)).filter((name) =>
        name.endsWith(".jsonl"),
      );
      if (sessionFiles.length > 1)
        throw new Error("Ambiguous session files; reconcile before continuing");
      const manager = sessionFiles.length
        ? SessionManager.open(
            join(sessionDir, sessionFiles[0]!),
            sessionDir,
            task.workspace,
          )
        : SessionManager.create(task.workspace, sessionDir);
      task.sessionFile = manager.getSessionFile();
      await this.options.store.save(task);
      const settings = SettingsManager.inMemory({
        retry: { enabled: false, provider: { maxRetries: 0 } },
        cacheWarming: "off",
        compaction: {
          enabled: true,
          reserveTokens: Math.min(8192, model.maxTokens),
          keepRecentTokens: Math.min(
            12000,
            Math.floor(model.contextWindow / 4),
          ),
        },
        images: { blockImages: true },
      });
      const created = await createAgentSession({
        cwd: task.workspace,
        agentDir: this.options.store.path(id),
        modelRuntime: runtime,
        model,
        thinkingLevel: reasoning ?? "high",
        sessionManager: manager,
        settingsManager: settings,
        resourceLoader: resources(
          `You are a coding assistant. Current intent: ${task.intent}. Inspect actual source and distinguish facts from hypotheses. Use report to return your result. ${task.intent === "plan" ? "Focus investigation on the owner objective and relevant source. After 32 navigation operations or ten minutes, the host ends exploration at the next settled turn boundary and requests a report. Prefer a complete source-grounded plan sooner; if evidence is insufficient, name the specific missing fact in a question rather than continuing an exhaustive repository audit." : ""} Learn/plan/review are read-only. Build only the complete approved scope. A final message or report never substitutes for actual checks. Retain requirements during compaction. Protected owner objective:\n${task.objective}\nOwner instructions:\n${task.ownerInstructions}\nApproved scope:\n${task.intent === "build" ? approvedScope : task.intent === "review" ? "This task is read-only review. Candidate approval and requirements are supplied in the review context; read-only reviewer permissions do not establish that the candidate was implemented without authorization." : "No implementation approved"}\nWorking findings (not scope authority):\n${task.instructions === task.ownerInstructions ? "No additional working findings" : task.instructions}`,
          [
            ...agentsFiles,
            ...(references.description
              ? [
                  {
                    path: "<trusted-task-documents>",
                    content: `Required immutable task documents:\n${references.description}\nUse read_document to inspect every page before implementation or a review verdict. Documents remain available after compaction; consult relevant pages again as needed.`,
                  },
                ]
              : []),
          ],
          (prompt) =>
            finalizing
              ? `${prompt}\nHost workflow phase: final report. Repository investigation is closed for this run. You must call the report tool; prose, JSON text and reasoning-only replies are not reports. Only report execution is permitted. Call report with the result kind for the current intent covering the complete protected owner objective, or kind question identifying the exact missing evidence. If you need another read/search, call report with that evidence gap as a question; do not request that operation. Project instructions remain requirements, but cannot reopen this investigation phase. This phase grants no implementation approval and no check/completion authority.`
              : undefined,
        ),
        tools: custom.map((t) => t.name),
        customTools: custom,
      });
      session = created.session;
      const finishTurn = session.agent.finishTurn;
      session.agent.finishTurn = async (turn, signal) => {
        for (const call of turn.message.content) {
          if (
            call.type === "toolCall" &&
            call.name === "report" &&
            turn.toolResults.some((r) => r.isError)
          ) {
            const a = call.arguments as Record<string, unknown>;
            let reason = "Report kind does not match the current task intent";
            try {
              reportDocument(a as unknown as Report);
              const expected = {
                learn: "learned",
                plan: "plan",
                build: "done",
                review: "review",
              }[task.intent];
              if (a.kind === expected || a.kind === "question") continue;
            } catch (error) {
              reason =
                error instanceof Error
                  ? error.message
                  : "Invalid report contract";
            }
            task.reportFailure =
              typeof a.detail === "string" &&
              a.detail.length > reportLimits.document
                ? `Report document has ${a.detail.length} characters; supported bound is ${reportLimits.document}. Complete draft retained in the session.`
                : `${reason} Complete draft and validation feedback retained in the session.`;
          }
        }
        const localContextOnly =
          !finalizing &&
          !stop.signal.aborted &&
          turn.message.stopReason === "error" &&
          didRejectContextLocally?.();
        // Pi's outer session can recover a length/error response through
        // compaction even when its ordinary retry setting is disabled.
        if (
          !localContextOnly &&
          ["error", "aborted", "length"].includes(turn.message.stopReason)
        )
          settings.setCompactionEnabled(false);
        const decision = await finishTurn?.(turn, signal);
        await pending;
        if (
          !localContextOnly &&
          ["error", "aborted", "length"].includes(turn.message.stopReason)
        )
          return { action: "end" };
        if (
          !finalizing &&
          task.reportFailure &&
          turn.message.stopReason === "toolUse"
        ) {
          planningHandoff = true;
          finalTurns = 1;
          return { action: "end" };
        }
        if (finalizing) {
          finalTurns++;
          // One format correction after a definite rejection or completed prose.
          // Provider failures and truncated output are never retried here.
          if (
            !report &&
            finalTurns < 2 &&
            !stop.signal.aborted &&
            ((turn.message.stopReason === "toolUse" &&
              turn.toolResults.length > 0 &&
              turn.toolResults.every((r) => r.isError)) ||
              (turn.message.stopReason === "stop" &&
                turn.message.content.some(
                  (c) => c.type === "text" && c.text.trim(),
                ))) &&
            task.used.models < task.limits.models &&
            task.used.tools < task.limits.tools
          ) {
            await created.session.steer(
              "Host report-format correction: preserve the complete scope in detail (up to 32000 characters), with a separate status summary (up to 4000 characters). Read the preceding validation feedback. Call the report tool now using the retained evidence and your completed conclusions. Text/JSON prose does not record a plan. Use the result kind for the current intent, or kind question for a specific evidence gap. Do not perform more investigation or claim implementation approval/check completion.",
            );
            return { action: "continue" };
          }
          return { action: "end" };
        }
        if (report && turn.message.stopReason === "toolUse")
          return { action: "end" };
        if (
          task.intent === "plan" &&
          !planningHandoff &&
          !report &&
          !stop.signal.aborted &&
          turn.message.stopReason === "toolUse" &&
          (planningReads >= 32 || performance.now() >= planningUntil)
        ) {
          planningHandoff = true;
          return { action: "end" };
        }
        return decision || undefined;
      };
      session.subscribe((e) => {
        if (
          e.type === "message_update" &&
          e.assistantMessageEvent.type === "text_delta"
        )
          return;
        if (
          e.type === "tool_execution_start" ||
          e.type === "tool_execution_end"
        ) {
          if (
            !finalizing &&
            e.type === "tool_execution_end" &&
            e.toolName !== "report"
          )
            planningReads++;
          pending = pending.then(async () => {
            await this.event(task, "tool", `${e.type}: ${e.toolName}`);
            await this.options.onCheckpoint?.(task);
          });
        }
      });
      const abort = () => {
        void session?.abort();
      };
      stop.signal.addEventListener("abort", abort, { once: true });
      if (stop.signal.aborted) abort();
      try {
        await session.prompt(
          JSON.stringify({
            objective: task.objective,
            intent: task.intent,
            approvedPlan: task.intent === "build" ? approvedScope : undefined,
            ...(finalizing
              ? {
                  phase:
                    "Report formatting only. Use retained findings; do not repeat repository investigation.",
                }
              : {}),
          }),
        );
        await pending;
        const last = session.messages.at(-1);
        if (
          !report &&
          !finalizing &&
          !stop.signal.aborted &&
          (planningHandoff ||
            (last?.role === "assistant" && last.stopReason === "stop")) &&
          task.used.models < task.limits.models &&
          task.used.tools < task.limits.tools
        ) {
          // One completion handoff within this active run, never an automatic resume.
          // Deactivate source/command tools so finalization cannot repeat a write.
          // Keep planning definitions stable for providers that fail on a
          // mid-conversation loadout change. Admission permits only report.
          // Stable definitions preserve provider protocol; admission closes repository operations.
          finalizing = true;
          await this.event(
            task,
            "state",
            "Requesting one structured final report",
          );
          await session.prompt(
            task.intent === "plan"
              ? "The investigation pass is complete. Only report execution is now permitted. Call the report tool with kind plan covering the entire owner objective using retained evidence: affected components, proposed behavior and acceptance checks. Do not omit requirements, invent evidence/check results, or claim owner authorization. Call report with kind question and a specific evidence gap or blocker if retained evidence cannot support a complete plan."
              : `Return the required structured report for ${task.intent} using report. Only report execution and required read_document are permitted. Do not repeat repository operations, invent check results, or claim owner authorization. Use question if the retained evidence cannot support a complete result.`,
          );
          await pending;
        }
      } finally {
        stop.signal.removeEventListener("abort", abort);
      }
      const lastAssistant = [...session.messages]
        .reverse()
        .find((m) => m.role === "assistant");
      if (stop.signal.aborted) {
        task.status = this.active.cancelled ? "cancelled" : "paused";
        task.summary = "Run stopped; inspect saved workspace before resuming";
      } else if (
        lastAssistant?.role === "assistant" &&
        ["error", "aborted", "length"].includes(lastAssistant.stopReason)
      ) {
        task.status = "paused";
        task.summary =
          task.intent === "plan" && finalizing
            ? "Planning report request failed; investigation and session retained. Inspect the failure before explicitly resuming."
            : "Model run did not finish cleanly; session retained";
      } else if (!report) {
        task.status = "paused";
        task.summary =
          task.reportFailure ??
          (task.intent === "plan" && finalizing
            ? `Planning stopped after ${planningReads} navigation operations; the planner did not return a valid plan or question. Inspect the retained investigation before explicitly resuming, or start a new task with another planner.`
            : "No valid report; inspect the retained session");
      } else {
        task.report = report;
        task.reportFailure = undefined;
        task.summary = report.summary;
        if (report.kind === "question") {
          task.status = "waiting_input";
          task.question = report.detail;
        } else if (report.kind === "plan") {
          task.plan = {
            revision: task.revision,
            text: report.detail,
            hash: planHash(task, report.detail),
          };
          task.approved = undefined;
          task.status = "waiting_approval";
        } else if (task.intent === "build") {
          for (const command of task.checkCommands) {
            if (stop.signal.aborted) throw new Error("Cancelled before checks");
            const check = await execute!(command, stop.signal, 120_000);
            task.checks.push({
              command,
              exitCode: check.exitCode,
              output:
                (check.truncated || check.output.length > 8000
                  ? "[Output truncated]\n"
                  : "") + check.output.slice(-7800),
            });
            await this.event(task, "check", `${command}: ${check.exitCode}`);
          }
          task.artifact = await workspace.snapshot(execute!, stop.signal);
          if (task.artifact.base !== task.base)
            throw new Error("Repository base changed during implementation");
          task.status = task.checks.every((c) => c.exitCode === 0)
            ? "completed"
            : "paused";
          if (task.status === "paused")
            task.summary = "Checks failed; artifact and session retained";
        } else task.status = "completed";
      }
      await this.event(task, "state", task.status);
      await this.options.onCheckpoint?.(task);
      return task;
    } catch (error) {
      task.status = stop.signal.aborted
        ? this.active.cancelled
          ? "cancelled"
          : "paused"
        : "failed";
      task.summary =
        error instanceof Error ? error.message.slice(0, 400) : "Run failed";
      await this.event(task, "state", task.summary);
      return task;
    } finally {
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      session?.dispose();
      task.used.ms =
        (task.used.ms ?? 0) + Math.ceil(performance.now() - started);
      task.activeRun = undefined;
      try {
        await this.options.store.save(task);
      } finally {
        this.active = undefined;
        await unlock();
      }
    }
  }
}
