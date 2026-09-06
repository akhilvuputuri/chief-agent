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
import { type AgentRequest, type AgentResponse } from "./protocol.js";
import type { JobTools } from "./tools.js";
export interface Agent {
  run(request: AgentRequest): Promise<AgentResponse>;
}
export class Assistant {
  private queue = new SerialQueue();
  private controllers = new Map<string, AbortController>();
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
  async cancel(user: string) {
    this.controllers.get(user)?.abort();
    await this.db.query(
      "UPDATE work_tasks SET status='cancelled',lease=NULL,pause_reason='cancelled' WHERE user_id=$1 AND status NOT IN ('done','cancelled')",
      [user],
    );
  }
  async grant(user: string) {
    return this.queue.run(user, async () =>
      this.db.query(
        `UPDATE work_tasks SET status='queued',budget_initialized=true,budget_ms=budget_ms+$2,budget_models=budget_models+$3,budget_tools=budget_tools+$4,pause_reason=NULL,next_run=now(),updated_at=now() WHERE user_id=$1 AND status IN ('paused','active') AND NOT EXISTS(SELECT 1 FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id WHERE r.task_id=work_tasks.id AND c.state='uncertain') RETURNING id`,
        [user, this.budget.ms, this.budget.models, this.budget.tools],
      ),
    );
  }
  async respond(
    user: string,
    message: string,
    progress?: (text: string) => Promise<void>,
  ) {
    return this.queue.run(user, () =>
      this.turn(user, message, false, progress),
    );
  }
  async resume(user: string, id: string) {
    return this.queue.run(user, async () => {
      const task = await new WorkTools(this.db).snapshot(user, id);
      if (!task || ["done", "cancelled"].includes(task.task.status))
        return "No runnable task.";
      if (task.task.pause_reason === "uncertain_write")
        return "A write has an uncertain outcome; operator inspection is required.";
      return this.turn(
        user,
        "Continue the existing task from its recorded steps and original request in runtime context. Do not expand its scope.",
        true,
      );
    });
  }
  async turn(
    user: string,
    message: string,
    background = false,
    progress?: (text: string) => Promise<void>,
  ) {
    if (!message.trim() || message.length > 20000)
      throw new Error("Message must be between 1 and 20000 characters");
    await ensureUser(this.db, user);
    const run = randomUUID();
    const controller = new AbortController();
    this.controllers.set(user, controller);
    const capability = randomBytes(32).toString("hex");
    this.capabilities.set(capability, {
      user,
      run,
      expires: Date.now() + this.budget.ms + 60000,
    });
    try {
      const work = new WorkTools(this.db);
      const current = await work.current(user);
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
      const history = background
        ? ((
            await this.db.query(
              "SELECT messages FROM runtime_runs WHERE task_id=$1 AND user_id=$2 ORDER BY started_at DESC LIMIT 1",
              [current?.id, user],
            )
          ).rows[0]?.messages ?? [])
        : ((
            await this.db.query(
              "SELECT history FROM conversations WHERE user_id=$1",
              [user],
            )
          ).rows[0]?.history ?? []);
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
      const runtime = runtimeContext(
        this.availability,
        await work.snapshot(user),
      );
      const catalogue = await new SkillTools(this.db).call(user, run, {
        operation: "skill_list",
      });
      runtime.context = JSON.stringify({
        ...JSON.parse(runtime.context),
        skillCatalogue: catalogue,
      });
      const output = await this.agent.run({
        runId: run,
        capability,
        message,
        history,
        memories,
        runtime,
        progress,
        execution,
        signal: controller.signal,
        execute: (input) => this.call(capability, input),
      });
      if (!background)
        await this.db.query(
          "INSERT INTO conversations(user_id,history,runtime_version) VALUES($1,$2::jsonb,1) ON CONFLICT(user_id) DO UPDATE SET history=$2::jsonb,runtime_version=1,updated_at=now()",
          [user, JSON.stringify(output.history)],
        );
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
      const notices = approvals.map(
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
      return [output.reply, ...notices].filter(Boolean).join("\n\n");
    } catch (error) {
      await this.db.query(
        "UPDATE runtime_runs SET state='stopped',stop_reason='failed' WHERE id=$1",
        [run],
      );
      await event(this.db, user, run, "turn.failed");
      throw error;
    } finally {
      this.capabilities.delete(capability);
      this.controllers.delete(user);
    }
  }
  async call(capability: string, input: unknown) {
    const scope = this.capabilities.get(capability);
    if (scope && this.controllers.get(scope.user)?.signal.aborted)
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
    return this.tools.execute(scope.user, scope.run, input, true);
  }
}
