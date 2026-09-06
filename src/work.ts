import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { Action } from "./protocol.js";
export type WorkAction = Extract<Action, { operation: `work_${string}` }>;
export class WorkTools {
  constructor(private db: Database) {}
  async current(user: string) {
    return (
      await this.db.query(
        `SELECT * FROM work_tasks WHERE user_id=$1 AND status NOT IN ('done','cancelled') ORDER BY created_at DESC LIMIT 1`,
        [user],
      )
    ).rows[0];
  }
  async snapshot(user: string, id?: string) {
    const task = id
      ? (
          await this.db.query(
            "SELECT * FROM work_tasks WHERE id=$1 AND user_id=$2",
            [id, user],
          )
        ).rows[0]
      : await this.current(user);
    if (!task) return null;
    const steps = (
      await this.db.query(
        "SELECT * FROM work_steps WHERE task_id=$1 ORDER BY key",
        [task.id],
      )
    ).rows;
    const evidence = (
      await this.db.query(
        `SELECT e.*,s.url FROM work_evidence e JOIN research_sources s ON s.id=e.source_id WHERE e.task_id=$1 ORDER BY e.created_at DESC LIMIT 100`,
        [task.id],
      )
    ).rows;
    const receipts = (
      await this.db.query(
        `SELECT id,operation,status,details FROM tool_receipts WHERE task_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 100`,
        [task.id, user],
      )
    ).rows;
    return {
      task,
      steps,
      evidence,
      receipts,
      counts: {
        total: steps.length,
        done: steps.filter((s) => s.status === "done").length,
        blocked: steps.filter((s) => s.status === "blocked").length,
        pending: steps.filter((s) => s.status === "pending").length,
      },
    };
  }
  async call(user: string, run: string, a: WorkAction): Promise<any> {
    if (a.operation === "work_status") return this.snapshot(user);
    const turn = (
      await this.db.query(
        "SELECT * FROM work_turns WHERE run_id=$1 AND user_id=$2",
        [run, user],
      )
    ).rows[0];
    if (!turn) throw new Error("Work needs an active authenticated turn");
    if (a.operation === "work_start") {
      const id = randomUUID();
      await this.db.query(
        `WITH made AS (INSERT INTO work_tasks(id,user_id,objective,request) VALUES($1,$2,$3,$4) RETURNING id), steps AS (INSERT INTO work_steps(task_id,key,title,verification,expected_operation) SELECT made.id,x.key,x.title,x.verification,x."expectedOperation" FROM made,jsonb_to_recordset($5::jsonb) x(key text,title text,verification text,"expectedOperation" text)) INSERT INTO work_revisions(task_id,revision,request,objective) SELECT id,1,$4,$3 FROM made`,
        [id, user, a.objective, turn.request, JSON.stringify(a.steps)],
      );
      await this.db.query(
        "UPDATE work_turns SET task_id=$2,revision=1 WHERE run_id=$1",
        [run, id],
      );
      return this.snapshot(user, id);
    }
    const task = (
      await this.db.query(
        "SELECT * FROM work_tasks WHERE id=$1 AND user_id=$2",
        [a.id, user],
      )
    ).rows[0];
    if (!task || ["cancelled", "done"].includes(task.status))
      throw new Error("Task unavailable");
    if (a.operation === "work_cancel") {
      await this.db.query(
        `UPDATE work_tasks SET status='cancelled',lease=NULL,updated_at=now() WHERE id=$1 AND user_id=$2`,
        [a.id, user],
      );
      return { cancelled: true };
    }
    if (a.operation === "work_revise") {
      if (turn.background)
        throw new Error("Only a user follow-up can revise scope");
      // Preserve audit history, conservatively invalidate prior completion against revised scope.
      await this.db.query(
        `WITH revised AS (UPDATE work_tasks SET objective=$3,request=request || E'\nFollow-up: ' || $4,revision=revision+1,status='active',passes=0,lease=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *), removed AS (DELETE FROM work_steps USING revised WHERE work_steps.task_id=revised.id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($5::jsonb) x WHERE x->>'key'=work_steps.key)), added AS (INSERT INTO work_steps(task_id,key,title,verification,expected_operation) SELECT revised.id,x.key,x.title,x.verification,x."expectedOperation" FROM revised,jsonb_to_recordset($5::jsonb) x(key text,title text,verification text,"expectedOperation" text) ON CONFLICT(task_id,key) DO UPDATE SET title=EXCLUDED.title,verification=EXCLUDED.verification,expected_operation=EXCLUDED.expected_operation,status='pending',result='',proofs='{}') INSERT INTO work_revisions(task_id,revision,request,objective) SELECT id,revision,request,objective FROM revised`,
        [a.id, user, a.objective, turn.request, JSON.stringify(a.steps)],
      );
      await this.db.query(
        "UPDATE work_turns SET task_id=$2,revision=(SELECT revision FROM work_tasks WHERE id=$2) WHERE run_id=$1",
        [run, a.id],
      );
      return this.snapshot(user, a.id);
    }
    if (turn.task_id !== task.id || turn.revision !== task.revision)
      throw new Error("Task scope changed; inspect current work");
    if (a.operation === "work_evidence") {
      const source = (
        await this.db.query(
          "SELECT content FROM research_sources WHERE id=$1 AND user_id=$2",
          [a.sourceId, user],
        )
      ).rows[0];
      if (!source) throw new Error("Source not found");
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      if (
        !norm(a.sourceQuote) ||
        !norm(source.content).includes(norm(a.sourceQuote))
      )
        throw new Error("Quote must appear in retrieved source");
      return (
        await this.db.query(
          `INSERT INTO work_evidence(id,task_id,source_id,claim,quote,applicability,reason) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            randomUUID(),
            a.id,
            a.sourceId,
            a.claim,
            a.sourceQuote,
            a.applicability,
            a.reason,
          ],
        )
      ).rows[0];
    }
    if (a.operation === "work_yield") {
      await this.db.query(
        `UPDATE work_tasks SET status='queued',next_run=now()+interval '15 seconds',updated_at=now() WHERE id=$1 AND status!='done'`,
        [a.id],
      );
      return { checkpointed: true, automaticPassLimit: 3 };
    }
    const step = (
      await this.db.query(
        "SELECT * FROM work_steps WHERE task_id=$1 AND key=$2",
        [a.id, a.key],
      )
    ).rows[0];
    if (!step) throw new Error("Step not found");
    if (a.status === "done") {
      if (!a.result.trim()) throw new Error("Result required");
      const e = (
        await this.db.query(
          `SELECT id FROM work_evidence WHERE task_id=$1 AND id=ANY($2::uuid[]) AND applicability='matched'`,
          [a.id, a.proofs],
        )
      ).rows;
      const r = (
        await this.db.query(
          `SELECT id,operation FROM tool_receipts WHERE task_id=$1 AND user_id=$2 AND id=ANY($3::uuid[]) AND status='success'`,
          [a.id, user, a.proofs],
        )
      ).rows;
      if (step.verification === "evidence" && !e.length)
        throw new Error(
          "Matched source evidence required; search discovery alone is incomplete",
        );
      if (
        step.verification === "action" &&
        !r.some(
          (x) =>
            x.operation === step.expected_operation &&
            /(_save|_update|_sync|_set|_create)$/.test(x.operation),
        )
      )
        throw new Error("Successful action receipt required");
      if (step.verification === "analysis" && !a.proofs.length)
        throw new Error(
          "Analysis must link evidence or receipts; otherwise leave it pending",
        );
      if (
        a.proofs.some(
          (x) => !e.some((y) => y.id === x) && !r.some((y) => y.id === x),
        )
      )
        throw new Error("Proof does not belong to this task or is unverified");
    }
    await this.db.query(
      "UPDATE work_steps SET status=$3,result=$4,proofs=$5 WHERE task_id=$1 AND key=$2",
      [a.id, a.key, a.status, a.result, a.proofs],
    );
    await this.db.query(
      `UPDATE work_tasks SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM work_steps WHERE task_id=$1 AND status!='done') THEN 'done' ELSE 'active' END,updated_at=now() WHERE id=$1`,
      [a.id],
    );
    return this.snapshot(user, a.id);
  }
}
export function renderWork(s: any) {
  if (!s) return "No active tracked task.";
  const c = s.counts;
  const state =
    s.task.status === "cancelled"
      ? "Cancelled"
      : c.done === c.total
        ? "Recorded steps complete"
        : `Incomplete: ${c.done}/${c.total} steps recorded complete, ${c.blocked} blocked, ${c.pending} pending`;
  const rows = s.steps
    .filter((x: any) => x.result)
    .slice(-6)
    .map((x: any) => `• ${x.title} [${x.status}]: ${x.result.slice(0, 450)}`);
  return [
    `${state}.`,
    s.task.objective,
    ...rows,
    "Counts refer to recorded steps; source assessments remain agent judgments.",
    `Execution used: ${s.task.used_models ?? 0}/${s.task.budget_models ?? 40} model calls, ${s.task.used_tools ?? 0}/${s.task.budget_tools ?? 100} tool calls, ${Math.ceil(Number(s.task.used_ms ?? 0) / 1000)}/${Math.ceil(Number(s.task.budget_ms ?? 900000) / 1000)} active seconds.`,
    s.task.status === "queued"
      ? "Continuing automatically."
      : `State: ${s.task.status}${s.task.pause_reason ? " (" + s.task.pause_reason + ")" : ""}.`,
    s.task.status === "paused"
      ? "Use /continue to grant another allocation after resolving any blocker. Uncertain writes require operator inspection."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
