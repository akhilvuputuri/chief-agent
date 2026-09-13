import { InputInbox } from "./input-inbox.js";
import { ContextLimitError } from "./context.js";
import { NotDispatchedError } from "./tool-errors.js";
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
  Stop,
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
  preparing?: boolean;
  voiceReply?: boolean;
};
export class Assistant {
  private queue = new SerialQueue();
  private controllers = new Map<string, AbortController>();
  private foreground = new Map<
    string,
    {
      run: string;
      yield: boolean;
      revision: number;
    }
  >();
  private commits = new SerialQueue();
  private taskRuns = new Map<string, string>();
  private inbox: InputInbox;
  private outgoing = new Map<string, { run: string; cancelled: boolean }>();
  interruptForInput(user: string) {
    const active = this.foreground.get(user);
    if (active) {
      active.yield = true;
    }
  }
  async recordInput(user: string, message: string, metadata: Incoming = {}) {
    await ensureUser(this.db, user);
    const id = metadata.id ?? randomUUID();
    const inserted = await this.db.query(
      "INSERT INTO conversation_inputs(id,user_id,message,metadata,preparation) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING RETURNING id",
      [
        id,
        user,
        message,
        JSON.stringify(metadata),
        metadata.preparing ? "pending" : "ready",
      ],
    );
    if (inserted.rows.length) {
      this.inbox.wake(user);
      this.interruptForInput(user);
    }
    return id;
  }
  async prepareInput(
    user: string,
    id: string,
    message: string,
    images?: ImageAttachment[],
  ) {
    try {
      await this.inbox.ready(user, id, message, images);
    } catch (error) {
      await this.inbox.fail(user, id);
      throw error;
    }
  }
  async failInput(user: string, id: string) {
    await this.inbox.fail(user, id);
  }
  async isCurrentRun(user: string, run: string) {
    const active = this.foreground.get(user);
    if (active?.run === run)
      return (
        !active.yield &&
        !this.controllers.get(run)?.signal.aborted &&
        this.isCurrentDelivery(user, {
          reply: "",
          runId: run,
          inputRevision: active.revision,
        })
      );
    return (
      (
        await this.db.query(
          "SELECT 1 FROM work_turns w JOIN runtime_runs r ON r.id=w.run_id AND r.user_id=w.user_id WHERE w.user_id=$1 AND w.run_id=$2 AND w.background AND r.state='running'",
          [user, run],
        )
      ).rows.length > 0
    );
  }
  resetConversation(user: string) {
    // Serialize behind earlier foreground commits, as reset did before intake was decoupled.
    return this.queue.run(user, () =>
      this.db.query(
        "WITH contexts AS (DELETE FROM conversation_contexts WHERE user_id=$1) DELETE FROM conversations WHERE user_id=$1",
        [user],
      ),
    );
  }
  finishDelivery(user: string, run: string) {
    if (this.outgoing.get(user)?.run === run) this.outgoing.delete(user);
  }
  async isCurrentDelivery(user: string, delivery: Delivery) {
    if (
      this.outgoing.get(user)?.run === delivery.runId &&
      this.outgoing.get(user)?.cancelled
    )
      return false;
    if (delivery.inputRevision === undefined) return true;
    const version = this.inbox.version(user);
    const current = (
      await this.db.query(
        "SELECT coalesce(max(ordinal),0) AS revision FROM conversation_inputs WHERE user_id=$1",
        [user],
      )
    ).rows[0];
    const active = this.foreground.get(user);
    const valid =
      Number(current.revision) === delivery.inputRevision &&
      version === this.inbox.version(user) &&
      !(
        this.outgoing.get(user)?.run === delivery.runId &&
        this.outgoing.get(user)?.cancelled
      ) &&
      !(
        active &&
        active.run === delivery.runId &&
        (active.yield || this.controllers.get(active.run)?.signal.aborted)
      );
    if (!valid && delivery.runId)
      await event(
        this.db,
        user,
        delivery.runId,
        "conversation.delivery_withheld",
        {
          inputRevision: delivery.inputRevision,
          currentRevision: Number(current.revision),
        },
      );
    return valid;
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
  ) {
    this.inbox = new InputInbox(db);
  }
  shutdown() {
    for (const controller of this.controllers.values()) controller.abort();
  }
  async cancel(user: string, id?: string) {
    if (!id) {
      const active = this.foreground.get(user);
      if (active) this.controllers.get(active.run)?.abort();
      const outgoing = this.outgoing.get(user);
      if (outgoing) outgoing.cancelled = true;
      const pending = await this.db.query(
        "UPDATE conversation_inputs SET state='failed',finished_at=now(),metadata=metadata || jsonb_build_object('parkedReason','cancelled') WHERE user_id=$1 AND state='queued' RETURNING id",
        [user],
      );
      this.inbox.release(pending.rows.map((x) => x.id));
      this.inbox.wake(user);
      if (outgoing)
        await event(
          this.db,
          user,
          outgoing.run,
          "conversation.delivery_cancelled",
          {},
        );
      return { cancelled: Boolean(active || outgoing || pending.rows.length) };
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
    const outgoing = this.outgoing.get(user);
    if (
      outgoing &&
      (
        await this.db.query(
          "SELECT 1 FROM runtime_runs WHERE user_id=$1 AND id=$2 AND task_id=$3",
          [user, outgoing.run, id],
        )
      ).rows.length
    ) {
      outgoing.cancelled = true;
      this.inbox.wake(user);
      await event(
        this.db,
        user,
        outgoing.run,
        "conversation.delivery_cancelled",
        { taskId: id },
      );
    }
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
  ): Promise<Delivery> {
    const inputId =
      incoming.id ?? (await this.recordInput(user, message, incoming));
    await this.prepareInput(user, inputId, message, images);
    return this.queue.run(user, async () => {
      const requested = (
        await this.db.query(
          "SELECT state FROM conversation_inputs WHERE user_id=$1 AND id=$2",
          [user, inputId],
        )
      ).rows[0];
      // Another foreground run may already have absorbed this handler's input.
      if (requested?.state !== "queued") return { reply: "" };
      const ready = await this.inbox.waitReady(user);
      if (!ready.length) return { reply: "" };
      const first = ready[0]!;
      return this.turn(
        user,
        first.message,
        false,
        progress,
        first.images,
        undefined,
        first.id,
      );
    });
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
  ): Promise<Delivery> {
    if (!message.trim() || message.length > 20000)
      throw new Error("Message must be between 1 and 20000 characters");
    await ensureUser(this.db, user);
    const run = randomUUID();
    const controller = new AbortController();
    this.controllers.set(run, controller);
    const active = {
      run,
      yield: false,
      revision: 0,
    };
    if (!background) this.foreground.set(user, active);
    if (taskId) this.taskRuns.set(taskId, run);
    const consumedIds: string[] = inputId ? [inputId] : [];
    let currentInputId = inputId;
    let requestSnapshot = message;
    let voiceReply = false;
    let managedDelivery = false;
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
      const initialIndex =
        background && previousRun
          ? (
              await this.db.query(
                "SELECT message_index FROM conversation_inputs WHERE user_id=$1 AND run_id=$2 ORDER BY ordinal LIMIT 1",
                [user, previousRun],
              )
            ).rows[0]?.message_index
          : undefined;
      const stored =
        background && !previousRun
          ? { messages: [], omitted: 0, total: 0 }
          : await histories.recent(user, previousRun, initialIndex ?? 0);
      // Stable ordinal boundaries distinguish repeated identical user text. Legacy
      // runs without an input anchor retain bounded history rather than guessing.
      const history = stored.messages;
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
      if (inputId) {
        const claimed = await this.db.query(
          "UPDATE conversation_inputs SET state='running',run_id=$3,started_at=now(),consumed_at=now(),message_index=$4 WHERE id=$1 AND user_id=$2 AND state='queued' RETURNING ordinal,metadata",
          [inputId, user, run, history.length],
        );
        if (!claimed.rows.length) throw new Error("Input already consumed");
        active.revision = Number(claimed.rows[0].ordinal);
        voiceReply = claimed.rows[0].metadata.voiceReply === true;
        managedDelivery = claimed.rows[0].metadata.updateId !== undefined;
      }
      const initialVersion = this.inbox.version(user);
      active.yield =
        !background &&
        ((await this.inbox.pending(user)).length > 0 ||
          initialVersion !== this.inbox.version(user));
      const conversation = background
        ? {
            summary: "",
            pendingReply: null,
            previousId: undefined,
            replyTarget: null,
            interruptedJob: null,
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
          interruptedJob: conversation.interruptedJob,
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
      const request: AgentRequest = {
        runId: run,
        capability,
        message,
        ...(images?.length ? { images } : {}),
        history,
        historyOmitted: stored.omitted,
        turnStart: history.length,
        managedDelivery,
        conversationSummary: conversation.summary,
        shouldYield: background ? undefined : () => active.yield,
        steer: background
          ? undefined
          : async () => {
              if (controller.signal.aborted) throw new Stop("cancelled");
              const bound = (
                await this.db.query(
                  "SELECT task_id FROM work_turns WHERE user_id=$1 AND run_id=$2",
                  [user, run],
                )
              ).rows[0]?.task_id;
              if (bound && (await this.inbox.pending(user)).length) {
                await execution.trace("conversation.task_handoff", {
                  taskId: bound,
                });
                throw new Stop("interrupted");
              }
              const ready = await this.inbox.waitReady(user, controller.signal);
              const adopted: Array<{ id: string; message: string }> = [];
              for (const input of ready) {
                const claim = await this.db.query(
                  "UPDATE conversation_inputs SET state='running',run_id=$3,started_at=now(),consumed_at=now() WHERE user_id=$1 AND id=$2 AND state='queued' AND preparation='ready' RETURNING id",
                  [user, input.id, run],
                );
                if (!claim.rows.length) continue;
                consumedIds.push(input.id);
                currentInputId = input.id;
                active.revision = input.ordinal;
                voiceReply = input.metadata.voiceReply === true;
                adopted.push({ id: input.id, message: input.message });
                request.message = input.message;
                if (input.images?.length)
                  request.images = [...(request.images ?? []), ...input.images];
                requestSnapshot += `\n\nUser follow-up (${input.id}):\n${input.message}`;
              }
              // Do not overwrite a wakeup that arrives during an awaited state read.
              const version = this.inbox.version(user);
              const pending = await this.inbox.pending(user);
              active.yield =
                pending.length > 0 || version !== this.inbox.version(user);
              if (adopted.length) {
                await this.db.query(
                  "UPDATE work_turns SET request=$3 WHERE user_id=$1 AND run_id=$2",
                  [user, run, requestSnapshot],
                );
                const updated = await conversationState(
                  this.db,
                  user,
                  currentInputId,
                );
                runtime.context = JSON.stringify({
                  ...JSON.parse(runtime.context),
                  conversation: {
                    ...JSON.parse(runtime.context).conversation,
                    replyTarget: updated.replyTarget,
                    latestInputId: currentInputId,
                    consumedInputIds: consumedIds,
                  },
                });
                await execution.trace("conversation.inputs_consumed", {
                  inputIds: adopted.map((x) => x.id),
                  inputRevision: active.revision,
                });
              }
              return adopted;
            },
        memories,
        runtime,
        progress: progress ? (text) => progress(text, run) : undefined,
        execution,
        signal: controller.signal,
        execute: (input) => this.call(capability, input),
        executeResearch: async (childRun, input) => {
          const op = (input as any)?.operation;
          if (!researchReads.has(op)) throw new Error("Operation unavailable");
          const child = await this.db.query(
            "SELECT 1 FROM runtime_runs r JOIN events e ON e.run_id=r.id AND e.user_id=r.user_id WHERE r.id=$1 AND r.user_id=$2 AND r.state='running' AND e.type='research.child_started' AND e.data->>'parentRunId'=$3",
            [childRun, user, run],
          );
          if (!child.rows.length) throw new Error("Research scope unavailable");
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
      };
      const output = await spending.run(new Spending(this.db, user, run), () =>
        this.agent.run(request),
      );
      if (
        (
          await this.db.query("SELECT state FROM runtime_runs WHERE id=$1", [
            run,
          ])
        ).rows[0]?.state === "running"
      )
        await execution.finish(output.stopReason ?? "answer");
      if (
        !background &&
        ["budget_exhausted", "cancelled", "failed"].includes(
          output.stopReason ?? "",
        )
      ) {
        const bound = (
          await this.db.query(
            "SELECT task_id FROM work_turns WHERE user_id=$1 AND run_id=$2",
            [user, run],
          )
        ).rows[0]?.task_id;
        if (!bound) {
          // Inputs already waiting at stop time must not turn into free fresh allocations.
          const parked = await this.db.query(
            "UPDATE conversation_inputs SET state='failed',finished_at=now(),metadata=metadata || jsonb_build_object('parkedReason',$2::text,'parkedByRun',$3::text) WHERE user_id=$1 AND state='queued' RETURNING id,ordinal",
            [user, output.stopReason, run],
          );
          if (parked.rows.length) {
            active.revision = Math.max(
              active.revision,
              ...parked.rows.map((x) => Number(x.ordinal)),
            );
            this.inbox.release(parked.rows.map((x) => x.id));
            this.inbox.wake(user);
            await execution.trace("conversation.inputs_parked", {
              inputIds: parked.rows.map((x) => x.id),
              reason: output.stopReason,
            });
            output.reply +=
              " Additional queued messages were saved but not executed. Send them again when you want to start another request.";
          }
        }
      }
      // Only new turn messages enter the conversation. Earlier context is already stored.
      if (!background) {
        const next = output.history as Message[];
        if (
          history.some((m, i) => JSON.stringify(m) !== JSON.stringify(next[i]))
        )
          throw new Error("Agent changed prior conversation history");
        await this.commits.run(user, () =>
          histories.appendConversation(
            user,
            run,
            next
              .slice(history.length)
              .filter(
                (_, index) =>
                  !output.undeliveredMessageIndices?.includes(
                    index + history.length,
                  ),
              ),
            managedDelivery
              ? { pending: true, reply: output.reply }
              : undefined,
          ),
        );
        if (output.stopReason !== "interrupted")
          await saveConversationState(
            this.db,
            user,
            run,
            conversation.summary,
            requestSnapshot,
            output.reply,
            output.stopReason,
          );
        if (inputId)
          await this.db.query(
            "UPDATE conversation_inputs SET state=$3,finished_at=now() WHERE id=ANY($1::uuid[]) AND user_id=$2",
            [
              consumedIds,
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
          `UPDATE work_tasks SET status=CASE WHEN ($3='answer' OR ($3 IN ('awaiting_user','awaiting_approval') AND EXISTS(SELECT 1 FROM work_steps WHERE task_id=$1 AND status='blocked'))) AND used_ms<budget_ms AND used_models<budget_models AND used_tools<budget_tools AND EXISTS(SELECT 1 FROM work_steps WHERE task_id=$1 AND status='pending') THEN 'queued' ELSE 'paused' END,pause_reason=CASE WHEN $3='answer' THEN NULL ELSE $3 END,next_run=now()+interval '15 seconds',updated_at=now() WHERE id=$1 AND revision=$2 AND status NOT IN ('done','cancelled')`,
          [linked, snapshot.task.revision, reason],
        );
      }
      if (!background && managedDelivery && output.reply)
        this.outgoing.set(user, { run, cancelled: controller.signal.aborted });
      return {
        reply: output.reply,
        canvases: output.canvases,
        records: output.records,
        numbers: output.numbers,
        sections: output.sections,
        sources: output.sources,
        runId: run,
        ...(!background ? { inputRevision: active.revision, voiceReply } : {}),
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
          "UPDATE conversation_inputs SET state='failed',finished_at=now() WHERE id=ANY($1::uuid[]) AND user_id=$2",
          [consumedIds, user],
        );
      await event(this.db, user, run, "turn.failed");
      if (taskId)
        await this.db.query(
          "UPDATE work_tasks SET status='paused',lease=NULL,pause_reason=$3,updated_at=now() WHERE id=$1 AND user_id=$2 AND status NOT IN ('done','cancelled')",
          [
            taskId,
            user,
            error instanceof ContextLimitError ? "context_limit" : "failed",
          ],
        );
      if (error instanceof ContextLimitError) {
        await event(this.db, user, run, "context.failed", {
          sizes: error.sizes,
          beforeModel: true,
        });
        return {
          reply:
            "I could not load the preceding exchange within the context limit, so I stopped before asking the model. Your original messages and saved results are retained; this needs context inspection.",
          runId: run,
        };
      }
      throw error;
    } finally {
      this.inbox.release(consumedIds);
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
      throw new NotDispatchedError("cancelled");
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
    // Authorization awaits above may overlap new input. This is the actual dispatcher boundary.
    if (this.controllers.get(scope.run)?.signal.aborted)
      throw new NotDispatchedError("cancelled");
    const active = this.foreground.get(scope.user);
    if (active?.run === scope.run && active.yield)
      throw new NotDispatchedError("interrupted");
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
