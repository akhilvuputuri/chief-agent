import { ValidationError } from "./tool-errors.js";
import { createHash } from "node:crypto";
import type { Database } from "./db.js";
export class TaskScope {
  constructor(private db: Database) {}
  async view(user: string, task: string) {
    const scope = (
      await this.db.query(
        "SELECT revision,targets FROM task_scopes WHERE task_id=$1 AND user_id=$2",
        [task, user],
      )
    ).rows[0];
    if (!scope) return null;
    const findings = (
      await this.db.query(
        "SELECT target_id,target_hash,status,summary,observation_ids FROM task_findings WHERE task_id=$1",
        [task],
      )
    ).rows;
    return {
      ...scope,
      findings: findings.filter((f) =>
        scope.targets.some(
          (t: any) => t.id === f.target_id && t.hash === f.target_hash,
        ),
      ),
    };
  }
  async bind(
    user: string,
    run: string,
    task: string,
    observation: string,
    ids: string[],
  ) {
    const turn = (
      await this.db.query(
        "SELECT * FROM work_turns WHERE run_id=$1 AND user_id=$2 AND task_id=$3",
        [run, user, task],
      )
    ).rows[0];
    if (!turn) throw new ValidationError("Active task required");
    const prior = (
      await this.db.query(
        "SELECT * FROM task_scopes WHERE task_id=$1 AND user_id=$2",
        [task, user],
      )
    ).rows[0];
    const call = (
      await this.db.query(
        "SELECT c.result,c.operation FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id WHERE c.id=$1 AND r.user_id=$2 AND c.state='success'",
        [observation, user],
      )
    ).rows[0];
    if (!call || !["job_list", "item_list"].includes(call.operation))
      throw new ValidationError(
        "Scope needs a trusted record-list observation",
      );
    const records = call.result?.result;
    if (!Array.isArray(records))
      throw new ValidationError("Collection observation required");
    const targets = ids.map((id) => {
      const x = records.find((r: any) => r.id === id);
      if (!x) throw new ValidationError("Target absent from source collection");
      return {
        id: x.id,
        title: x.title,
        company: x.company,
        url: x.url,
        hash: createHash("sha256").update(JSON.stringify(x)).digest("hex"),
      };
    });
    if (prior) {
      const oldIds = prior.targets
          .map((x: any) => x.id)
          .sort()
          .join(","),
        newIds = targets
          .map((x) => x.id)
          .sort()
          .join(",");
      if (oldIds === newIds) return this.view(user, task);
      if (turn.background || prior.bound_run === run)
        throw new ValidationError(
          "Scope membership is fixed for this user turn; wait for a genuine user correction",
        );
    }
    await this.db.query(
      `INSERT INTO task_scopes(task_id,user_id,source_call_id,bound_run,targets) VALUES($1,$2,$3,$4,$5) ON CONFLICT(task_id) DO UPDATE SET history=task_scopes.history||jsonb_build_array(jsonb_build_object('revision',task_scopes.revision,'targets',task_scopes.targets)),revision=task_scopes.revision+1,source_call_id=EXCLUDED.source_call_id,bound_run=EXCLUDED.bound_run,targets=EXCLUDED.targets,updated_at=now()`,
      [task, user, observation, run, JSON.stringify(targets)],
    );
    return this.view(user, task);
  }
  async finding(
    user: string,
    task: string,
    targetId: string,
    summary: string,
    status: string,
    observations: string[],
  ) {
    const scope = await this.view(user, task),
      target = scope?.targets.find((x: any) => x.id === targetId);
    if (!target)
      throw new ValidationError("Target is outside the recorded scope");
    for (const id of observations) {
      const c = (
        await this.db.query(
          "SELECT c.result,c.operation FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id WHERE c.id=$1 AND r.user_id=$2 AND c.state='success'",
          [id, user],
        )
      ).rows[0];
      if (!c)
        throw new ValidationError("Observation unavailable for this owner");
      const r = c.result?.result;
      const matches =
        r?.role?.id === targetId ||
        r?.id === targetId ||
        (target.url && (r?.sourceUrl === target.url || r?.url === target.url));
      if (!matches)
        throw new ValidationError(
          "Observation does not identify this target. Use the original job_analyze or web_read observationId, not an observation_read page ID or receiptId",
        );
    }
    if (status === "complete" && !observations.length)
      throw new ValidationError(
        "Completed findings require target-linked observations",
      );
    await this.db.query(
      "INSERT INTO task_findings(task_id,target_id,target_hash,summary,status,observation_ids) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(task_id,target_id) DO UPDATE SET target_hash=EXCLUDED.target_hash,summary=EXCLUDED.summary,status=EXCLUDED.status,observation_ids=EXCLUDED.observation_ids,updated_at=now()",
      [task, targetId, target.hash, summary, status, observations],
    );
    return {
      targetId,
      status,
      saved: true,
      notice: "Recorded support does not certify semantic correctness",
    };
  }
  async validate(user: string, task: string, refs: string[]) {
    const scope = await this.view(user, task);
    if (!scope) {
      const collection = (
        await this.db.query(
          "SELECT 1 FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id WHERE r.task_id=$1 AND r.user_id=$2 AND c.operation IN ('job_list','item_list') AND c.state='success' LIMIT 1",
          [task, user],
        )
      ).rows.length;
      if (collection)
        throw new ValidationError(
          "Collection completion requires a recorded scope and findings",
        );
      return;
    }
    if (refs.some((id) => !scope.targets.some((t: any) => t.id === id)))
      throw new ValidationError(
        "Final answer references a target outside scope",
      );
    if (
      scope.targets.some(
        (t: any) =>
          !refs.includes(t.id) ||
          !scope.findings.some((f: any) => f.target_id === t.id),
      )
    )
      throw new ValidationError(
        "Missing target outcomes; save findings or explicit blockers before claiming completion",
      );
  }
}
