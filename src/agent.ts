import { WorkTools, renderWork } from "./work.js";
import { runtimeContext } from "./runtime.js";
import { SerialQueue } from "./security.js";
import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { ensureUser, event } from "./db.js";
import {
  agentResponse,
  type AgentRequest,
  type AgentResponse,
} from "./protocol.js";
import type { JobTools } from "./tools.js";
export interface Agent {
  run(request: AgentRequest): Promise<AgentResponse>;
}
export class Hermes implements Agent {
  constructor(
    private url: string,
    private token: string,
  ) {}
  async run(request: AgentRequest) {
    const res = await fetch(new URL("/v1/turn", this.url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error("Agent unavailable");
    return agentResponse.parse(await res.json());
  }
}
export class Assistant {
  private queue = new SerialQueue();
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
  ) {}
  async respond(user: string, message: string) {
    return this.queue.run(user, () => this.turn(user, message));
  }
  async resume(user: string, id: string) {
    return this.queue.run(user, async () => {
      const task = await new WorkTools(this.db).snapshot(user, id);
      if (!task || task.task.status === "cancelled") return "Task cancelled.";
      return this.turn(
        user,
        "Continue the existing task from its recorded steps and original request in runtime context. Do not expand its scope.",
        true,
      );
    });
  }
  async turn(user: string, message: string, background = false) {
    if (!message.trim() || message.length > 20000)
      throw new Error("Message must be between 1 and 20000 characters");
    await ensureUser(this.db, user);
    const run = randomUUID();
    const capability = randomBytes(32).toString("hex");
    this.capabilities.set(capability, {
      user,
      run,
      expires: Date.now() + 180000,
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
        ? []
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
      const output = await this.agent.run({
        runId: run,
        capability,
        message,
        history,
        memories,
        runtime: runtimeContext(this.availability, await work.snapshot(user)),
      });
      if (!background)
        await this.db.query(
          "INSERT INTO conversations(user_id,history) VALUES($1,$2::jsonb) ON CONFLICT(user_id) DO UPDATE SET history=$2::jsonb,updated_at=now()",
          [user, JSON.stringify(output.history)],
        );
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
            `SELECT 1 FROM events WHERE run_id=$1 AND type='tool.completed' AND data->>'operation' LIKE 'work_%' LIMIT 1`,
            [run],
          )
        ).rows.length > 0;
      const snapshot =
        linked && touched ? await work.snapshot(user, linked) : null;
      if (snapshot && !["done", "cancelled"].includes(snapshot.task.status))
        await this.db.query(
          `UPDATE work_tasks SET status=CASE WHEN passes<3 AND EXISTS(SELECT 1 FROM work_steps WHERE task_id=$1 AND status='pending') THEN 'queued' ELSE 'paused' END,next_run=now()+interval '15 seconds',updated_at=now() WHERE id=$1 AND revision=$2 AND status NOT IN ('done','cancelled')`,
          [linked, snapshot.task.revision],
        );
      // Tracked work reports its persisted state rather than an unconstrained completion narrative.
      return [
        snapshot ? renderWork(await work.snapshot(user, linked)) : output.reply,
        output.interrupted
          ? "This pass reached a runtime limit; unfinished work is not complete."
          : "",
        ...notices,
      ]
        .filter(Boolean)
        .join("\n\n");
    } catch (error) {
      await event(this.db, user, run, "turn.failed");
      throw error;
    } finally {
      this.capabilities.delete(capability);
    }
  }
  async call(capability: string, input: unknown) {
    const scope = this.capabilities.get(capability);
    if (!scope || scope.expires < Date.now())
      throw new Error("Invalid run capability");
    const turn = (
      await this.db.query(
        `SELECT t.status,t.revision,w.revision turn_revision FROM work_turns w JOIN work_tasks t ON t.id=w.task_id WHERE w.run_id=$1`,
        [scope.run],
      )
    ).rows[0];
    const op = (input as any)?.operation;
    if (
      turn &&
      (turn.status === "cancelled" || turn.revision !== turn.turn_revision) &&
      op !== "work_status"
    )
      throw new Error("Task scope changed; inspect current work");
    return this.tools.execute(scope.user, scope.run, input, true);
  }
}
