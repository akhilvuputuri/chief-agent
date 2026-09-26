import { HistoryStore } from "./history.js";
import { scrubTrace } from "./trace-scrub.js";
import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { event } from "./db.js";
import type { Message } from "./model.js";
export type StopReason =
  | "answer"
  | "interrupted"
  | "awaiting_user"
  | "awaiting_approval"
  | "budget_exhausted"
  | "cancelled"
  | "failed";
export type Budget = { ms: number; models: number; tools: number };
export const defaultBudget: Budget = { ms: 900000, models: 40, tools: 100 };
export class Stop extends Error {
  constructor(readonly reason: StopReason) {
    super(reason);
  }
}
export const readOperations = new Set([
  "finish_turn",
  "conversation_search",
  "conversation_read",
  "canvas_list",
  "canvas_read",
  "research_delegate",
  "plugin_delegate",
  "research_report",
  "media_delegate",
  "media_report",
  "job_alignment_start",
  "job_alignment_resume",
  "job_alignment_read",
  "job_alignment_report",
  "job_alignment_input",
  "work_status",
  "item_list",
  "schedule_list",
  "routine_list",
  "routine_history",
  "watchlist_list",
  "calendar_list",
  "library_check",
  "library_availability",
  "library_shelf",
  "skill_list",
  "skill_read",
  "observation_read",
  "source_read",
  "skill_version_read",
  "skill_history",
  "prep_list",
  "prep_task_read",
  "gmail_accounts",
  "parcel_list",
  "parcel_match",
  "gmail_search",
  "gmail_read",
  "gmail_thread",
  "job_list",
  "job_analyze",
  "memory_list",
  "web_search",
  "web_read",
]);
export class Execution {
  private task?: string;
  get trackedTaskId() {
    return this.task;
  }
  private attaching?: Promise<void>;
  private checkpointMessages: string[] = [];
  private delegatedMs = 0;
  private used = { ms: 0, models: 0, tools: 0 };
  constructor(
    readonly db: Database,
    readonly user: string,
    readonly run: string,
    readonly signal: AbortSignal,
    private limits: Budget = defaultBudget,
    private parent?: Execution,
  ) {}
  async start() {
    await this.db.query("INSERT INTO runtime_runs(id,user_id) VALUES($1,$2)", [
      this.run,
      this.user,
    ]);
    await this.attach();
  }
  async attach(_force = false) {
    if (this.parent) return;
    if (this.attaching) return this.attaching;
    const pending = this.attachSelectedTask();
    this.attaching = pending;
    try {
      await pending;
    } finally {
      if (this.attaching === pending) this.attaching = undefined;
    }
  }
  private async attachSelectedTask() {
    // Foreground turns begin unbound. Only an explicit task created/selected by
    // work tools, or the exact background task, can own this run's allocation.
    const turn = (
      await this.db.query(
        `SELECT w.task_id,t.id AS owned_task FROM work_turns w LEFT JOIN work_tasks t ON t.id=w.task_id AND t.user_id=w.user_id WHERE w.run_id=$1 AND w.user_id=$2`,
        [this.run, this.user],
      )
    ).rows[0];
    const id = turn?.task_id;
    if (this.task && id !== this.task)
      throw new Error(
        "Execution task changed; refusing to switch its allocation",
      );
    if (id && !turn.owned_task)
      throw new Error("Task unavailable for this owner");
    if (id && !this.task) {
      const attached = await this.db.query(
        `WITH attached AS (
          UPDATE runtime_runs SET task_id=$1 WHERE id=$9 AND user_id=$8 AND task_id IS NULL RETURNING id
        ) UPDATE work_tasks SET budget_ms=CASE WHEN budget_initialized THEN budget_ms ELSE $2 END,budget_models=CASE WHEN budget_initialized THEN budget_models ELSE $3 END,budget_tools=CASE WHEN budget_initialized THEN budget_tools ELSE $4 END,budget_initialized=true,used_ms=used_ms+$5,used_models=used_models+$6,used_tools=used_tools+$7
        WHERE id=$1 AND user_id=$8 AND EXISTS(SELECT 1 FROM attached) RETURNING id`,
        [
          id,
          this.limits.ms,
          this.limits.models,
          this.limits.tools,
          this.used.ms,
          this.used.models,
          this.used.tools,
          this.user,
          this.run,
        ],
      );
      if (!attached.rows.length)
        throw new Error("Execution task unavailable or already assigned");
      this.task = id;
    }
  }
  async remaining(): Promise<Budget> {
    await this.attach();
    if (this.signal.aborted) throw new Stop("cancelled");
    if (this.parent) {
      const root = await this.parent.remaining();
      return {
        ms: Math.min(this.limits.ms - this.used.ms, root.ms),
        models: Math.min(this.limits.models - this.used.models, root.models),
        tools: Math.min(this.limits.tools - this.used.tools, root.tools),
      };
    }
    if (this.task) {
      const t = (
        await this.db.query(
          "SELECT * FROM work_tasks WHERE id=$1 AND user_id=$2",
          [this.task, this.user],
        )
      ).rows[0];
      if (!t) throw new Error("Task unavailable for this owner");
      if (t.status === "cancelled") throw new Stop("cancelled");
      return {
        ms: Number(t.budget_ms) - Number(t.used_ms),
        models: t.budget_models - t.used_models,
        tools: t.budget_tools - t.used_tools,
      };
    }
    return {
      ms: this.limits.ms - this.used.ms,
      models: this.limits.models - this.used.models,
      tools: this.limits.tools - this.used.tools,
    };
  }
  async consume(kind: "models" | "tools") {
    const left = await this.remaining();
    if (left.ms <= 0 || left[kind] <= 0) throw new Stop("budget_exhausted");
    if (this.parent) await this.parent.consume(kind);
    const column = kind === "models" ? "used_models" : "used_tools";
    if (this.task)
      await this.db.query(
        `UPDATE work_tasks SET ${column}=${column}+1,updated_at=now() WHERE id=$1`,
        [this.task],
      );
    this.used[kind]++;
    await this.db.query(
      `UPDATE runtime_runs SET ${column}=${column}+1,updated_at=now() WHERE id=$1`,
      [this.run],
    );
    return left.ms;
  }
  async elapsed(ms: number) {
    // Child time is charged durably as it is observed. The enclosing parent tool
    // later charges only its remaining overhead, never the same child time twice.
    ms = Math.max(0, Math.ceil(ms) - this.delegatedMs);
    if (this.parent) {
      await this.db.query(
        `WITH child_charge AS (
        UPDATE runtime_runs SET used_ms=used_ms+$2,updated_at=now() WHERE id=$1 AND user_id=$4 RETURNING id
      ), parent_charge AS (
        UPDATE runtime_runs SET used_ms=used_ms+$2,updated_at=now() WHERE id=$3 AND user_id=$4 AND EXISTS(SELECT 1 FROM child_charge) RETURNING task_id,user_id
      ) UPDATE work_tasks t SET used_ms=t.used_ms+$2,updated_at=now() FROM parent_charge p WHERE t.id=p.task_id AND t.user_id=p.user_id`,
        [this.run, ms, this.parent.run, this.user],
      );
      this.parent.used.ms += ms;
      this.parent.delegatedMs += ms;
    } else {
      await this.db.query(
        `WITH charge AS (
        UPDATE runtime_runs SET used_ms=used_ms+$2,updated_at=now() WHERE id=$1 AND user_id=$3 RETURNING task_id,user_id
      ) UPDATE work_tasks t SET used_ms=t.used_ms+$2,updated_at=now() FROM charge r WHERE t.id=r.task_id AND t.user_id=r.user_id`,
        [this.run, ms, this.user],
      );
    }
    this.used.ms += ms;
    this.delegatedMs = 0;
  }
  async checkpoint(messages: Message[], pendingDeliveryIndices: number[] = []) {
    const serialized = messages.map((m) => JSON.stringify(m));
    if (
      serialized.length < this.checkpointMessages.length ||
      this.checkpointMessages.some((m, i) => m !== serialized[i])
    )
      throw new Error("Checkpoint history is append-only");
    const delta = messages.slice(this.checkpointMessages.length);
    await new HistoryStore(this.db).append(
      this.user,
      this.run,
      this.checkpointMessages.length,
      delta,
      undefined,
      pendingDeliveryIndices,
    );
    this.checkpointMessages = serialized;
  }

  async trace(type: string, data: Record<string, unknown>) {
    if (type === "model.completed" || type === "model.started")
      await this.db.query("UPDATE runtime_runs SET model=$2 WHERE id=$1", [
        this.run,
        data.model ?? null,
      ]);
    await event(this.db, this.user, this.run, type, scrubTrace(data));
  }
  async beginCall(callId: string, operation: string, args: unknown) {
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO runtime_calls(id,run_id,call_id,operation,arguments,is_write) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
      [
        id,
        this.run,
        callId,
        operation,
        JSON.stringify(args),
        !readOperations.has(operation),
      ],
    );
    return id;
  }
  async endCall(id: string, result: unknown, state = "success") {
    await this.db.query(
      "UPDATE runtime_calls SET result=$2::jsonb,state=$3,finished_at=now() WHERE id=$1",
      [id, JSON.stringify(result), state],
    );
  }
  async finish(reason: StopReason) {
    await this.db.query(
      "UPDATE runtime_runs SET state='stopped',stop_reason=$2,updated_at=now() WHERE id=$1",
      [this.run, reason],
    );
    await this.trace("runtime.stopped", { stopReason: reason });
  }
}
// Startup recovery is deliberately conservative. No old invocation is replayed.
export async function recoverRuntime(db: Database) {
  // Charge interrupted active execution conservatively, capped at remaining allocation.
  await db.query(
    `UPDATE work_tasks t SET used_ms=LEAST(t.budget_ms,t.used_ms+COALESCE((SELECT sum(GREATEST(0,EXTRACT(EPOCH FROM now()-r.updated_at)*1000))::bigint FROM runtime_runs r WHERE r.task_id=t.id AND r.state='running'),0)) WHERE EXISTS(SELECT 1 FROM runtime_runs r WHERE r.task_id=t.id AND r.state='running')`,
  );
  await db.query(
    "UPDATE runtime_calls SET state=CASE WHEN is_write THEN 'uncertain' ELSE 'interrupted' END WHERE state='started'",
  );
  await db.query(
    `UPDATE work_tasks SET status='paused',lease=NULL,pause_reason=CASE WHEN EXISTS(SELECT 1 FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id WHERE r.task_id=work_tasks.id AND c.state='uncertain') THEN 'uncertain_write' ELSE 'restart' END WHERE status IN ('active','queued','running')`,
  );
  await db.query(
    "UPDATE runtime_runs SET state='stopped',stop_reason='failed' WHERE state='running'",
  );
  await db.query(
    "UPDATE conversation_inputs SET state='failed',finished_at=now() WHERE state IN ('queued','running')",
  );
}
