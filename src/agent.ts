import { alignmentContext } from "./alignment.js";
import {
  conversationState,
  saveConversationState,
} from "./conversation-state.js";
import { HistoryStore } from "./history.js";
import type { Message } from "./model.js";
import type { Delivery } from "./answer.js";
import { researchReads } from "./research-schema.js";
import { spending, Spending } from "./spending.js";
import { recordContext } from "./record-context.js";
import { compactWork } from "./observations.js";
import {
  Execution,
  defaultBudget,
  readOperations,
  type Budget,
} from "./execution.js";
import { SkillTools } from "./skills.js";
import { WorkTools } from "./work.js";
import { runtimeContext } from "./runtime.js";
import { SerialQueue } from "./security.js";
import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { ensureUser, event } from "./db.js";
import {
  type AgentRequest,
  type AgentResponse,
  type ImageAttachment,
} from "./protocol.js";
import type { JobTools } from "./tools.js";
export interface Agent {
  run(request: AgentRequest): Promise<AgentResponse>;
}
export type Incoming = {
  id?: string;
  updateId?: number;
  messageId?: number;
  replyToMessageId?: number;
  receivedAt?: string;
};
export class Assistant {
  private queue = new SerialQueue();
  private controllers = new Map<string, AbortController>();
  private foreground = new Map<
    string,
    {
      run: string;
      model: AbortController;
      yield: boolean;
      protectedMedia: boolean;
    }
  >();
  private commits = new SerialQueue();
  private taskRuns = new Map<string, string>();
  interruptForInput(user: string) {
    const active = this.foreground.get(user);
    if (active) {
      active.yield = true;
      if (!active.protectedMedia) active.model.abort();
    }
  }
  async recordInput(user: string, message: string, metadata: Incoming = {}) {
    await ensureUser(this.db, user);
    const id = metadata.id ?? randomUUID();
    await this.db.query(
      "INSERT INTO conversation_inputs(id,user_id,message,metadata) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING",
      [id, user, message, JSON.stringify(metadata)],
    );
    this.interruptForInput(user);
    return id;
  }
  async recordDelivery(user: string, run: string, reply: string) {
    if (!reply) return;
    await this.commits.run(user, () =>
      new HistoryStore(this.db).appendDelivery(user, run, reply),
    );
  }
  readonly capabilities = new Map<
    string,
    { user: string; run: string; expires: number }
  >();
  constructor(
    private db: Database,
    private agent: Agent,
    readonly tools: JobTools,
    private availability: Record<string, boolean> = {
      web: true,
      gmail: false,
      calendar: false,
      preparationSheet: false,
      dailySheet: false,
    },
    private budget: Budget = defaultBudget,
  ) {}
  shutdown() {
    for (const controller of this.controllers.values()) controller.abort();
  }
  async cancel(user: string, id?: string) {
    if (!id) {
      const active = this.foreground.get(user);
      if (active) {
        this.controllers.get(active.run)?.abort();
        return { cancelled: true };
      }
      return { cancelled: false };
    }
    const selected = (
      await this.db.query(
        "SELECT id FROM work_tasks WHERE user_id=$1 AND id=$2 AND status NOT IN ('done','cancelled')",
        [user, id],
      )
    ).rows[0];
    if (!selected) return { cancelled: false };
    const run =
      this.taskRuns.get(id) ??
      (
        await this.db.query(
          "SELECT id FROM runtime_runs WHERE task_id=$1 AND user_id=$2 AND state='running' ORDER BY started_at DESC LIMIT 1",
          [id, user],
        )
      ).rows[0]?.id;
    if (run) this.controllers.get(run)?.abort();
    await this.db.query(
      "UPDATE work_tasks SET status='cancelled',lease=NULL,pause_reason='cancelled' WHERE user_id=$1 AND id=$2 AND status NOT IN ('done','cancelled')",
      [user, id],
    );
    return { cancelled: true };
  }
  async grant(user: string, id?: string) {
    // A bare /continue is only unambiguous when exactly one job can be resumed.
    const candidates = (
      await this.db.query(
        "SELECT id FROM work_tasks WHERE user_id=$1 AND status IN ('paused','active') AND ($2::uuid IS NULL OR id=$2::uuid) ORDER BY created_at DESC LIMIT 2",
        [user, id ?? null],
      )
    ).rows;
    const chosen = candidates.length === 1 ? candidates[0] : undefined;
    if (!chosen) return { rows: [], ambiguous: !id && candidates.length > 1 };
    return this.db.query(
      `UPDATE work_tasks SET status='queued',budget_initialized=true,budget_ms=budget_ms+$2,budget_models=budget_models+$3,budget_tools=budget_tools+$4,pause_reason=NULL,next_run=now(),updated_at=now() WHERE user_id=$1 AND id=$5 AND status IN ('paused','active') AND lease IS NULL AND NOT EXISTS(SELECT 1 FROM runtime_runs r WHERE r.task_id=work_tasks.id AND r.state='running') AND NOT EXISTS(SELECT 1 FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id WHERE r.task_id=work_tasks.id AND c.state='uncertain') RETURNING id`,
      [user, this.budget.ms, this.budget.models, this.budget.tools, chosen.id],
    );
  }
  async respond(
    user: string,
    message: string,
    progress?: (text: string, runId?: string) => Promise<void>,
    images?: ImageAttachment[],
  ) {
    const out = await this.respondDetailed(user, message, progress, images);
    return [out.reply, ...(out.notices ?? [])].filter(Boolean).join("\n\n");
  }
  async respondDetailed(
    user: string,
    message: string,
    progress?: (text: string, runId?: string) => Promise<void>,
    images?: ImageAttachment[],
    incoming: Incoming = {},
  ) {
    const inputId =
      incoming.id ?? (await this.recordInput(user, message, incoming));
    return this.queue.run(user, () =>
      this.turn(user, message, false, progress, images, undefined, inputId),
    );
  }
  async resume(
    user: string,
    id: string,
    progress?: (text: string, runId?: string) => Promise<void>,
  ) {
    const out = await this.resumeDetailed(user, id, progress);
    return [out.reply, ...(out.notices ?? [])].filter(Boolean).join("\n\n");
  }
  async resumeDetailed(
    user: string,
    id: string,
    progress?: (text: string, runId?: string) => Promise<void>,
  ): Promise<Delivery> {
    return this.queue.run(`task:${id}`, async () => {
      const task = await new WorkTools(this.db).snapshot(user, id);
      if (!task || ["done", "cancelled"].includes(task.task.status))
        return { reply: "No runnable task." };
      if (task.task.pause_reason === "uncertain_write")
        return {
          reply:
            "A write has an uncertain outcome; operator inspection is required.",
        };
      return this.turn(
        user,
        "Continue the existing task from its recorded steps and original request in runtime context. Do not expand its scope.",
        true,
        progress,
        undefined,
        id,
      );
    });
  }
  async turn(
    user: string,
    message: string,
    background = false,
    progress?: (text: string, runId?: string) => Promise<void>,
    images?: ImageAttachment[],
    taskId?: string,
    inputId?: string,
  ) {
    if (!message.trim() || message.length > 20000)
      throw new Error("Message must be between 1 and 20000 characters");
    await ensureUser(this.db, user);
    const run = randomUUID();
    const controller = new AbortController();
    this.controllers.set(run, controller);
    const active = {
      run,
      model: new AbortController(),
      yield: false,
      protectedMedia: !!images?.length,
    };
    if (!background) this.foreground.set(user, active);
    if (taskId) this.taskRuns.set(taskId, run);
    const capability = randomBytes(32).toString("hex");
    this.capabilities.set(capability, {
      user,
      run,
      // In-process capability lives until this turn exits; task allocations may exceed one default budget.
      expires: Number.POSITIVE_INFINITY,
    });
    try {
      const work = new WorkTools(this.db);
      const current = taskId
        ? (await work.snapshot(user, taskId))?.task
        : undefined;
      if (background && !current)
        throw new Error("An exact background task is required");
      await this.db.query(
        "INSERT INTO work_turns(run_id,user_id,request,task_id,revision,background) VALUES($1,$2,$3,$4,$5,$6)",
        [
          run,
          user,
          message,
          current?.id ?? null,
          current?.revision ?? null,
          background,
        ],
      );
      await event(this.db, user, run, "turn.started");
      const histories = new HistoryStore(this.db);
      const previousRun = background
        ? (
            await this.db.query(
              "SELECT id FROM runtime_runs WHERE task_id=$1 AND user_id=$2 ORDER BY started_at DESC,id DESC LIMIT 1",
              [current?.id, user],
            )
          ).rows[0]?.id
        : undefined;
      const stored =
        background && !previousRun
          ? { messages: [], omitted: 0, total: 0 }
          : await histories.recent(user, previousRun);
      let history = stored.messages;
      if (background && previousRun) {
        const previousTurn = (
          await this.db.query(
            "SELECT request,background FROM work_turns WHERE run_id=$1 AND user_id=$2",
            [previousRun, user],
          )
        ).rows[0];
        if (previousTurn && !previousTurn.background) {
          const anchor = history.findLastIndex(
            (m) => m.role === "user" && m.content === previousTurn.request,
          );
          history = anchor >= 0 ? history.slice(anchor) : [];
        }
      }
      await event(this.db, user, run, "history.loaded", {
        storageVersion: 2,
        source: background ? "task_run" : "conversation",
        loaded: history.length,
        omitted: stored.omitted,
        total: stored.total,
      });
      const memories = (
        await this.db.query(
          "SELECT key,value FROM memories WHERE user_id=$1 ORDER BY key",
          [user],
        )
      ).rows;
      const execution = new Execution(
        this.db,
        user,
        run,
        controller.signal,
        this.budget,
      );
      await execution.start();
      if (inputId)
        await this.db.query(
          "UPDATE conversation_inputs SET state='running',run_id=$3,started_at=now() WHERE id=$1 AND user_id=$2",
          [inputId, user, run],
        );
      const conversation = background
        ? {
            summary: "",
            pendingReply: null,
            previousId: undefined,
            replyTarget: null,
          }
        : await conversationState(this.db, user, inputId);
      await event(this.db, user, run, "conversation.routed", {
        lane: background ? "job" : "foreground",
        taskId: current?.id ?? null,
        inputId: inputId ?? null,
        previousContextId: conversation.previousId ?? null,
      });
      const runtime = runtimeContext(
        this.availability,
        current ? await work.snapshot(user, current.id) : null,
      );
      const catalogue = await new SkillTools(this.db).call(user, run, {
        operation: "skill_list",
      });
      runtime.context = JSON.stringify({
        ...JSON.parse(runtime.context),
        skillCatalogue: catalogue,
        alignmentScopes: await alignmentContext(this.db, user, run),
        conversation: {
          lane: background ? "job" : "foreground",
          pendingReply: conversation.pendingReply,
          replyTarget: conversation.replyTarget,
          delivery: background
            ? "This is a separate background job. Your reply arrives amid the rolling chat; identify which job the update concerns in natural language."
            : "Answer the current user message; saved jobs are independent and must be explicitly selected.",
        },
        calendarApprovals: (
          await this.db.query(
            "SELECT id,status,expires_at,payload->'draft' AS draft,payload->>'execution' AS execution,payload->'result' AS result FROM approvals WHERE user_id=$1 AND operation='calendar_create' AND status='pending' AND expires_at>now() ORDER BY created_at DESC LIMIT 3",
            [user],
          )
        ).rows,
      });
      const output = await spending.run(new Spending(this.db, user, run), () =>
        this.agent.run({
          runId: run,
          capability,
          message,
          ...(images?.length ? { images } : {}),
          history,
          historyOmitted: stored.omitted,
          conversationSummary: conversation.summary,
          shouldYield: background
            ? undefined
            : () => active.yield && !active.protectedMedia,
          afterTool: (operation) => {
            if (operation === "media_delegate") active.protectedMedia = false;
          },
          modelSignal: background ? undefined : active.model.signal,
          memories,
          runtime,
          progress: progress ? (text) => progress(text, run) : undefined,
          execution,
          signal: controller.signal,
          execute: (input) => this.call(capability, input),
          executeResearch: async (childRun, input) => {
            const op = (input as any)?.operation;
            if (!researchReads.has(op))
              throw new Error("Operation unavailable");
            const child = await this.db.query(
              "SELECT 1 FROM runtime_runs r JOIN events e ON e.run_id=r.id AND e.user_id=r.user_id WHERE r.id=$1 AND r.user_id=$2 AND r.state='running' AND e.type='research.child_started' AND e.data->>'parentRunId'=$3",
              [childRun, user, run],
            );
            if (!child.rows.length)
              throw new Error("Research scope unavailable");
            return this.call(capability, input, childRun);
          },
          refreshContext: async () => {
            runtime.context = JSON.stringify({
              ...JSON.parse(runtime.context),
              work: await (async () => {
                const bound = (
                  await this.db.query(
                    "SELECT task_id FROM work_turns WHERE run_id=$1 AND user_id=$2",
                    [run, user],
                  )
                ).rows[0]?.task_id;
                return bound
                  ? compactWork(await work.snapshot(user, bound))
                  : null;
              })(),
              costUsage: await spending.getStore()!.summary(),
              alignmentScopes: await alignmentContext(this.db, user, run),
              retrievedCollections: await recordContext(this.db, user, run),
            });
          },
        }),
      );
      if (
        (
          await this.db.query("SELECT state FROM runtime_runs WHERE id=$1", [
            run,
          ])
        ).rows[0]?.state === "running"
      )
        await execution.finish(output.stopReason ?? "answer");
      // Only new turn messages enter the conversation. Earlier context is already stored.
      if (!background) {
        const next = output.history as Message[];
        if (
          history.some((m, i) => JSON.stringify(m) !== JSON.stringify(next[i]))
        )
          throw new Error("Agent changed prior conversation history");
        await this.commits.run(user, () =>
          histories.appendConversation(user, run, next.slice(history.length)),
        );
        if (output.stopReason !== "interrupted")
          await saveConversationState(
            this.db,
            user,
            run,
            conversation.summary,
            message,
            output.reply,
            output.stopReason,
          );
        if (inputId)
          await this.db.query(
            "UPDATE conversation_inputs SET state=$3,finished_at=now() WHERE id=$1 AND user_id=$2",
            [
              inputId,
              user,
              output.stopReason === "interrupted"
                ? "interrupted"
                : output.stopReason === "failed"
                  ? "failed"
                  : "completed",
            ],
          );
      }
      await execution.attach();
      await event(this.db, user, run, "turn.responded", {
        interrupted: output.interrupted ?? false,
      });
      const approvals = (
        await this.db.query(
          "SELECT id,operation,payload FROM approvals WHERE user_id=$1 AND run_id=$2 AND status='pending' AND expires_at>now() ORDER BY created_at",
          [user, run],
        )
      ).rows;
      // Render the authoritative preview ourselves; never rely on model wording.
      const notices = approvals
        .filter((a) => a.operation !== "calendar_create")
        .map(
          (a) =>
            `Approval required — saved action\n${a.operation === "skill_activate" ? a.payload.preview + "\nAgent evaluation: " + a.payload.evaluation : `Delete role ${a.payload.id}: ${JSON.stringify(a.payload.title)} at ${JSON.stringify(a.payload.company)}`}\nWithin 15 minutes, send /approve ${a.id} or /deny ${a.id}`,
        );
      const linked = (
        await this.db.query("SELECT task_id FROM work_turns WHERE run_id=$1", [
          run,
        ])
      ).rows[0]?.task_id;
      const touched =
        background ||
        (
          await this.db.query(
            `SELECT 1 FROM events WHERE run_id=$1 AND type='tool.completed' AND data->>'operation' IN ('work_start','work_revise','work_step','work_evidence','work_yield') LIMIT 1`,
            [run],
          )
        ).rows.length > 0;
      const snapshot =
        linked && touched ? await work.snapshot(user, linked) : null;
      if (snapshot && !["done", "cancelled"].includes(snapshot.task.status)) {
        const reason = approvals.length
          ? "awaiting_approval"
          : (output.stopReason ?? "answer");
        await this.db.query(
          `UPDATE work_tasks SET status=CASE WHEN ($3 IN ('answer','interrupted') OR ($3 IN ('awaiting_user','awaiting_approval') AND EXISTS(SELECT 1 FROM work_steps WHERE task_id=$1 AND status='blocked'))) AND used_ms<budget_ms AND used_models<budget_models AND used_tools<budget_tools AND EXISTS(SELECT 1 FROM work_steps WHERE task_id=$1 AND status='pending') THEN 'queued' ELSE 'paused' END,pause_reason=CASE WHEN $3 IN ('answer','interrupted') THEN NULL ELSE $3 END,next_run=now()+interval '15 seconds',updated_at=now() WHERE id=$1 AND revision=$2 AND status NOT IN ('done','cancelled')`,
          [linked, snapshot.task.revision, reason],
        );
      }
      return {
        reply: output.reply,
        canvases: output.canvases,
        records: output.records,
        numbers: output.numbers,
        sections: output.sections,
        sources: output.sources,
        runId: run,
        // Approval notices also get their own always-visible delivery; views never authorize them.
        notices,
      };
    } catch (error) {
      await this.db.query(
        "UPDATE runtime_runs SET state='stopped',stop_reason='failed' WHERE id=$1",
        [run],
      );
      if (inputId)
        await this.db.query(
          "UPDATE conversation_inputs SET state='failed',finished_at=now() WHERE id=$1 AND user_id=$2",
          [inputId, user],
        );
      await event(this.db, user, run, "turn.failed");
      throw error;
    } finally {
      this.capabilities.delete(capability);
      this.controllers.delete(run);
      if (this.foreground.get(user)?.run === run) this.foreground.delete(user);
      if (taskId && this.taskRuns.get(taskId) === run)
        this.taskRuns.delete(taskId);
    }
  }
  async call(capability: string, input: unknown, childRun?: string) {
    const scope = this.capabilities.get(capability);
    if (scope && this.controllers.get(scope.run)?.signal.aborted)
      throw new Error("Task cancelled");
    if (!scope || scope.expires < Date.now())
      throw new Error("Invalid run capability");
    const turn = (
      await this.db.query(
        `SELECT t.status,t.pause_reason,t.revision,w.revision turn_revision FROM work_turns w JOIN work_tasks t ON t.id=w.task_id WHERE w.run_id=$1`,
        [scope.run],
      )
    ).rows[0];
    const op = (input as any)?.operation;
    if (
      turn?.status === "paused" &&
      ["runtime_cutover", "restart"].includes(turn.pause_reason) &&
      typeof op === "string" &&
      op.startsWith("work_") &&
      !["work_status", "work_cancel", "work_revise"].includes(op)
    )
      throw new Error("Task paused for cutover/restart; use /continue first");
    if (
      turn &&
      (turn.status === "cancelled" || turn.revision !== turn.turn_revision) &&
      op !== "work_status"
    )
      throw new Error("Task scope changed; inspect current work");
    if (!readOperations.has(op)) {
      const uncertain = await this.db.query(
        "SELECT 1 FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id WHERE r.user_id=$1 AND c.state='uncertain' LIMIT 1",
        [scope.user],
      );
      if (uncertain.rows.length)
        throw new Error(
          "An uncertain write requires inspection before further writes",
        );
    }
    const result = await this.tools.execute(
      scope.user,
      childRun ?? scope.run,
      input,
      true,
    );
    if (op === "work_cancel") {
      const run = this.taskRuns.get((input as any).id);
      if (run) this.controllers.get(run)?.abort();
    }
    return result;
  }
}
