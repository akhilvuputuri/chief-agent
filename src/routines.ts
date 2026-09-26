import { errorFields, opsLog } from "./ops-log.js";
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type { Database } from "./db.js";
import type { Action } from "./protocol.js";
import type { Delivery } from "./answer.js";
import { ScheduleParser } from "./schedule.js";
import { ToolValidationError } from "./tool-errors.js";

type RoutineAction = Extract<Action, { operation: `routine_${string}` }>;
export class RoutineTools {
  constructor(
    private db: Database,
    private parser = new ScheduleParser(),
  ) {}
  async call(user: string, run: string, a: RoutineAction): Promise<any> {
    if (a.operation === "routine_list")
      return (
        await this.db.query(
          "SELECT * FROM agent_routines WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",
          [user],
        )
      ).rows;
    if (a.operation === "routine_history")
      return (
        await this.db.query(
          `SELECT o.*,t.status AS task_status,t.pause_reason,t.used_models,t.used_tools,t.used_ms,
        (SELECT jsonb_agg(jsonb_build_object('id',d.id,'runId',d.run_id,'state',d.state,'result',d.payload,'sentAt',d.sent_at) ORDER BY d.created_at)
         FROM routine_deliveries d WHERE d.occurrence_id=o.id AND d.user_id=$1) AS deliveries
       FROM routine_occurrences o LEFT JOIN work_tasks t ON t.id=o.task_id AND t.user_id=o.user_id
       WHERE o.user_id=$1 AND o.routine_id=$2 ORDER BY o.created_at DESC LIMIT 10`,
          [user, a.id],
        )
      ).rows;
    const turn = (
      await this.db.query(
        "SELECT background FROM work_turns WHERE run_id=$1 AND user_id=$2",
        [run, user],
      )
    ).rows[0];
    if (!turn || turn.background)
      throw new ToolValidationError(
        "Only a foreground user request may change routines",
      );
    let old: any;
    if (a.operation === "routine_update") {
      old = (
        await this.db.query(
          "SELECT * FROM agent_routines WHERE id=$1 AND user_id=$2",
          [a.id, user],
        )
      ).rows[0];
      if (!old) throw new ToolValidationError("Routine unavailable");
    }
    let timing;
    try {
      timing =
        a.operation === "routine_create" ||
        a.schedule ||
        a.status === "scheduled"
          ? await this.parser.next(
              a.schedule ?? old.schedule,
              a.schedule ? undefined : old?.parsed,
            )
          : { parsed: old.parsed, next: old.next_run };
      if (
        !timing.next &&
        (a.operation === "routine_create" ||
          a.status === "scheduled" ||
          a.schedule)
      )
        throw new Error("Choose a future time for this routine");
    } catch (error) {
      throw new ToolValidationError(
        error instanceof Error ? error.message : "Invalid schedule",
      );
    }
    if (a.operation === "routine_create") {
      const row = (
        await this.db.query(
          `INSERT INTO agent_routines(id,user_id,name,instruction,schedule,parsed,next_run,missed_policy)
         SELECT $1,$2,$3,$4,$5,$6::jsonb,$7,$8 WHERE (SELECT count(*) FROM agent_routines WHERE user_id=$2 AND status IN ('scheduled','paused'))<50 RETURNING *`,
          [
            randomUUID(),
            user,
            a.name,
            a.instruction,
            a.schedule,
            JSON.stringify(timing.parsed),
            timing.next,
            a.missedPolicy,
          ],
        )
      ).rows[0];
      if (!row)
        throw new ToolValidationError(
          "Maximum 50 active routines; cancel an unused routine first",
        );
      return row;
    }
    const row = (
      await this.db.query(
        `UPDATE agent_routines SET name=$3,instruction=$4,schedule=$5,parsed=$6::jsonb,next_run=$7,status=$8,
       missed_policy=$9,revision=revision+1,updated_at=now() WHERE id=$1 AND user_id=$2 AND revision=$10 AND next_run IS NOT DISTINCT FROM $11::timestamptz AND status=$12 RETURNING *`,
        [
          a.id,
          user,
          a.name ?? old.name,
          a.instruction ?? old.instruction,
          a.schedule ?? old.schedule,
          JSON.stringify(timing.parsed),
          timing.next,
          a.status ?? old.status,
          a.missedPolicy ?? old.missed_policy,
          old.revision,
          old.next_run,
          old.status,
        ],
      )
    ).rows[0];
    if (!row)
      throw new ToolValidationError(
        "Routine changed concurrently; read it again",
      );
    return {
      ...row,
      notice:
        "Changes affect future occurrences only. Existing task IDs remain independently cancellable.",
    };
  }
}

/** Coalesce downtime to one occurrence, retaining the interval's original phase. */
export function dueWindow(parsed: any, first: Date, now: Date) {
  if (parsed.kind === "once") return { due: first, next: null };
  if (parsed.kind === "interval") {
    const duration = parsed.minutes * 60000;
    const due = new Date(
      first.getTime() +
        Math.floor((now.getTime() - first.getTime()) / duration) * duration,
    );
    return { due, next: new Date(due.getTime() + duration) };
  }
  const due = CronExpressionParser.parse(parsed.expr, {
    currentDate: new Date(now.getTime() + 1),
    tz: "Asia/Singapore",
  })
    .prev()
    .toDate();
  const next = CronExpressionParser.parse(parsed.expr, {
    currentDate: now,
    tz: "Asia/Singapore",
  })
    .next()
    .toDate();
  return { due: due < first ? first : due, next };
}

export class RoutineScheduler {
  constructor(
    private db: Database,
    private allowed: (user: string) => boolean,
    private clock = () => new Date(),
  ) {}
  async tick() {
    const now = this.clock();
    const rows = (
      await this.db.query(
        "SELECT * FROM agent_routines WHERE status='scheduled' AND next_run<=$1 ORDER BY next_run LIMIT 20",
        [now],
      )
    ).rows;
    for (const r of rows) {
      if (!this.allowed(r.user_id)) {
        // Revoked owners must not monopolize the bounded due scan forever.
        await this.db.query(
          "UPDATE agent_routines SET status='paused',revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$2 AND status='scheduled'",
          [r.id, r.revision],
        );
        continue;
      }
      const { due, next } = dueWindow(r.parsed, new Date(r.next_run), now);
      const missed =
        r.missed_policy === "skip" && now.getTime() - due.getTime() > 300000;
      const task = randomUUID();
      // The locked CAS, occurrence, task and schedule advancement commit together.
      const result = await this.db.query(
        `WITH selected AS (
        SELECT * FROM agent_routines WHERE id=$1 AND revision=$2 AND next_run=$3 AND status='scheduled' FOR UPDATE
      ), classified AS (
        SELECT s.*, CASE WHEN $6::boolean THEN 'missed' WHEN EXISTS(
          SELECT 1 FROM routine_occurrences o JOIN work_tasks t ON t.id=o.task_id
          WHERE o.routine_id=s.id AND t.status NOT IN ('done','cancelled')) THEN 'overlap' ELSE 'launched' END AS disposition FROM selected s
      ), occurrence AS (
        INSERT INTO routine_occurrences(id,routine_id,user_id,revision,scheduled_at,instruction,disposition,task_id)
        SELECT $4,id,user_id,revision,$5,instruction,disposition,CASE WHEN disposition='launched' THEN $7::uuid ELSE NULL END
        FROM classified ON CONFLICT DO NOTHING RETURNING *
      ), task AS (
        INSERT INTO work_tasks(id,user_id,objective,request,status)
        SELECT $7,o.user_id,'Scheduled: '||s.name,
          'Scheduled routine: '||s.name||E'\nOccurrence: '||$5::text||E' (Asia/Singapore display timezone).\n'||o.instruction,
          'queued' FROM occurrence o JOIN selected s ON s.id=o.routine_id WHERE o.disposition='launched' RETURNING id
      ), revision AS (
        INSERT INTO work_revisions(task_id,revision,request,objective)
        SELECT $7,1,'Scheduled routine: '||s.name||E'\n'||s.instruction,'Scheduled: '||s.name FROM selected s,task
      ) UPDATE agent_routines SET next_run=$8,status=CASE WHEN $8::timestamptz IS NULL THEN 'completed' ELSE 'scheduled' END,updated_at=now()
        WHERE id=$1 AND EXISTS(SELECT 1 FROM occurrence)
        RETURNING (SELECT id FROM occurrence) AS occurrence,(SELECT disposition FROM occurrence) AS disposition,(SELECT task_id FROM occurrence) AS task`,
        [r.id, r.revision, r.next_run, randomUUID(), due, missed, task, next],
      );
      const o = result.rows[0];
      if (o)
        opsLog("routine.occurrence", "info", {
          ref: o.occurrence,
          state: o.disposition,
          taskId: o.task ?? undefined,
        });
    }
  }
}

/** Save completed passes before delivery. Never rerun work to recover Telegram sends. */
export class RoutineDelivery {
  private busy = false;
  constructor(
    private db: Database,
    private send: (user: string, delivery: Delivery) => Promise<unknown>,
  ) {}
  async capture(
    user: string,
    task: string,
    payload: Delivery,
  ): Promise<boolean> {
    const o = (
      await this.db.query(
        "SELECT id FROM routine_occurrences WHERE task_id=$1 AND user_id=$2",
        [task, user],
      )
    ).rows[0];
    if (!o) return false;
    await this.db.query(
      `WITH saved AS (
      INSERT INTO routine_deliveries(id,occurrence_id,user_id,run_id,payload) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT(run_id) DO NOTHING RETURNING id
    ) UPDATE work_tasks SET status='done',pause_reason=NULL WHERE id=$6 AND user_id=$3
      AND status NOT IN ('cancelled','done') AND pause_reason IS NULL AND NOT EXISTS(SELECT 1 FROM work_steps WHERE task_id=$6)
      AND EXISTS(SELECT 1 FROM runtime_runs WHERE id=$4 AND user_id=$3 AND task_id=$6 AND stop_reason='answer')`,
      [
        randomUUID(),
        o.id,
        user,
        payload.runId ?? null,
        JSON.stringify(payload),
        task,
      ],
    );
    return true;
  }
  async recover() {
    await this.db.query(
      "UPDATE routine_deliveries SET state='uncertain' WHERE state='sending'",
    );
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const d = (
        await this.db
          .query(`UPDATE routine_deliveries SET state='sending' WHERE id=(
        SELECT id FROM routine_deliveries WHERE state='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)
      ).rows[0];
      if (!d) return;
      try {
        await this.send(d.user_id, d.payload);
        await this.db.query(
          "UPDATE routine_deliveries SET state='sent',sent_at=now() WHERE id=$1",
          [d.id],
        );
        opsLog("routine.delivery", "info", {
          ref: d.id,
          runId: d.run_id ?? undefined,
          state: "sent",
        });
      } catch (error) {
        opsLog("routine.delivery", "error", {
          ref: d.id,
          runId: d.run_id ?? undefined,
          state: "uncertain",
          ...errorFields(error),
        });
        await this.db.query(
          "UPDATE routine_deliveries SET state='uncertain' WHERE id=$1",
          [d.id],
        );
      }
    } finally {
      this.busy = false;
    }
  }
}
