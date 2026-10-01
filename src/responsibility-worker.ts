import { randomUUID, createHash } from "node:crypto";
import type { Database } from "./db.js";
import type { Delivery } from "./answer.js";
import { Responsibilities, attention, type Scope } from "./responsibilities.js";
import { responsibilityFinding } from "./responsibility-schema.js";
import { dueWindow } from "./routines.js";
import type { GmailTools } from "./gmail.js";
import type { CalendarTools } from "./calendar.js";
import { inWindow } from "./watch-window.js";
import { withResponsibilityOwner } from "./responsibility-transaction.js";

const day = (now: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
type Change = { key: string; payload: any };
/** Cheap source checks have no model dependency. Work and sends remain separate. */
export class ResponsibilityWorker {
  private busy = false;
  constructor(
    private service: Responsibilities,
    private allowed: (user: string) => boolean,
    private sources: {
      gmail?: Pick<GmailTools, "poll">;
      calendar?: Pick<CalendarTools, "list">;
    } = {},
    private clock = () => new Date(),
  ) {}
  private get db() {
    return this.service.db;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const activeOwnerRows = (
        await this.db.query(
          "SELECT DISTINCT user_id FROM responsibilities WHERE status='active'",
        )
      ).rows;
      const permitted: string[] = [];
      for (const { user_id } of activeOwnerRows) {
        if (this.allowed(user_id)) permitted.push(user_id);
        else {
          const paused = (
            await this.db.query(
              "UPDATE responsibilities SET status='paused' WHERE user_id=$1 AND status='active' RETURNING id",
              [user_id],
            )
          ).rows;
          for (const row of paused)
            await this.service.onInactive?.(user_id, row.id);
        }
      }
      await this.sweep(permitted, true);
      await this.completeReady();
      const paused = (
        await this.db.query(
          `SELECT i.user_id,i.task_id,t.pause_reason FROM responsibility_investigations i JOIN work_tasks t ON t.id=i.task_id JOIN responsibilities r ON r.id=i.responsibility_id AND r.revision=i.revision WHERE r.status='active' AND i.state='running' AND t.status='paused' AND NOT EXISTS(SELECT 1 FROM responsibility_findings f WHERE f.notice_task_id=i.task_id) LIMIT 20`,
        )
      ).rows;
      for (const p of paused)
        if (this.allowed(p.user_id))
          await this.capture(p.user_id, p.task_id, {
            reply: "Investigation paused.",
            reason: p.pause_reason ?? "paused",
          });
      const rows = (
        await this.db.query(
          `SELECT t.*,v.spec FROM responsibility_triggers t JOIN responsibilities r ON r.id=t.responsibility_id AND r.revision=t.revision
        JOIN responsibility_revisions v ON v.responsibility_id=t.responsibility_id AND v.revision=t.revision
        WHERE r.status='active' AND t.user_id=ANY($2::text[]) AND (v.spec->>'expiresAt' IS NULL OR (v.spec->>'expiresAt')::timestamptz>$1) AND t.next_check<=$1 AND (t.lease_until IS NULL OR t.lease_until<$1) ORDER BY t.next_check LIMIT 20`,
          [this.clock(), permitted],
        )
      ).rows;
      for (const t of rows) {
        if (!this.allowed(t.user_id)) {
          await this.db.query(
            `UPDATE responsibilities SET status='paused' WHERE id=$1 AND user_id=$2`,
            [t.responsibility_id, t.user_id],
          );
          continue;
        }
        if (
          t.spec.monitoringWindow &&
          !inWindow(t.spec.monitoringWindow, this.clock())
        ) {
          await this.db.query(
            "UPDATE responsibility_triggers SET next_check=$2 WHERE id=$1",
            [t.id, new Date(this.clock().getTime() + 900000)],
          );
          continue;
        }
        const lease = randomUUID();
        const claimed = (
          await this.db.query(
            `UPDATE responsibility_triggers SET lease=$2,lease_until=$3 WHERE id=$1 AND (lease_until IS NULL OR lease_until<$4) RETURNING id`,
            [
              t.id,
              lease,
              new Date(this.clock().getTime() + 120000),
              this.clock(),
            ],
          )
        ).rows;
        if (!claimed.length) continue;
        try {
          await this.check(t, lease);
        } catch {
          await this.degraded(t, lease);
        }
      }
      for (const user of new Set<string>(rows.map((t) => t.user_id)))
        if (this.allowed(user)) await this.launch(user);
      // Budget rollover can make a queued batch runnable even when no source is due.
      const owners = (
        await this.db.query(
          `SELECT DISTINCT c.user_id FROM responsibility_candidates c JOIN responsibilities r ON r.id=c.responsibility_id AND r.revision=c.revision WHERE r.status='active' AND c.task_id IS NULL LIMIT 20`,
        )
      ).rows;
      for (const { user_id } of owners)
        if (this.allowed(user_id)) await this.launch(user_id);
      await this.sweep(permitted);
    } finally {
      this.busy = false;
    }
  }
  private async check(t: any, lease: string) {
    const now = this.clock();
    let changes: Change[] = [],
      cursor = { ...t.cursor },
      next = new Date(now.getTime() + 300000);
    if (t.kind === "parcel") {
      const rows = (
        await this.db.query(
          `SELECT e.* FROM responsibility_events e WHERE e.user_id=$1 AND e.parcel_id=ANY($2::uuid[]) AND e.created_at>=$3
        AND NOT EXISTS(SELECT 1 FROM runtime_runs r JOIN responsibility_investigations i ON i.task_id=r.task_id WHERE r.id=e.run_id AND i.responsibility_id=$4)
        AND NOT EXISTS(SELECT 1 FROM responsibility_candidates c WHERE c.responsibility_id=$4 AND c.revision=$5 AND c.source_key='parcel-event:'||e.id)
        ORDER BY e.created_at,e.id LIMIT 100`,
          [
            t.user_id,
            t.config.ids,
            cursor.activatedAt,
            t.responsibility_id,
            t.revision,
          ],
        )
      ).rows;
      changes = rows.map((e) => ({
        key: `parcel-event:${e.id}`,
        payload: e.payload,
      }));
      next = new Date(now.getTime() + 15000);
    } else if (t.kind === "gmail") {
      if (!this.sources.gmail) throw new Error("Source unavailable");
      const end = cursor.scanEnd ?? now.toISOString();
      const start = Math.max(
        Date.parse(cursor.activatedAt),
        Date.parse(cursor.watermark) - 300000,
      );
      const q = `(${t.config.query}) after:${Math.floor(start / 1000)} before:${Math.ceil(Date.parse(end) / 1000) + 1}`;
      const result = await this.sources.gmail.poll(
        t.user_id,
        t.config.account,
        t.config.email,
        q,
        cursor.pageToken,
        `responsibility-check:${lease}`,
      );
      changes = result.messages.map((m) => ({
        key: `gmail:${t.config.account}:${m.id}`,
        payload: {
          kind: "gmail",
          account: t.config.account,
          email: t.config.email,
          id: m.id,
          threadId: m.threadId,
        },
      }));
      cursor = result.nextPageToken
        ? { ...cursor, scanEnd: end, pageToken: result.nextPageToken }
        : { activatedAt: cursor.activatedAt, watermark: end };
      next = new Date(
        now.getTime() +
          (result.nextPageToken ? 15000 : t.config.minutes * 60000),
      );
    } else if (t.kind === "calendar") {
      if (!this.sources.calendar) throw new Error("Source unavailable");
      const r = await this.sources.calendar.list(
        t.user_id,
        now.toISOString(),
        new Date(now.getTime() + t.config.leadHours * 3600000).toISOString(),
        true,
      );
      if (r.truncated || r.events.some((e: any) => e.attendeesOmitted))
        throw new Error("Incomplete calendar scan");
      changes = r.events
        .filter(
          (e: any) =>
            e.status !== "cancelled" &&
            e.start?.dateTime &&
            Date.parse(e.start.dateTime) > now.getTime() &&
            e.attendees?.some(
              (a: any) =>
                !a.self &&
                !a.resource &&
                a.responseStatus !== "declined" &&
                a.email &&
                !t.config.internalDomains.includes(
                  a.email.split("@")[1]?.toLowerCase(),
                ),
            ),
        )
        .map((e: any) => ({
          key: `calendar:primary:${e.recurringEventId ?? e.id}:${e.originalStartTime?.dateTime ?? e.originalStartTime?.date ?? e.id}`,
          payload: {
            kind: "calendar",
            event: {
              id: e.id,
              title: String(e.title).slice(0, 300),
              start: e.start,
              end: e.end,
              location: String(e.location ?? "").slice(0, 300),
              url: e.url,
              status: e.status,
            },
          },
        }));
    } else {
      const { due, next: following } = dueWindow(
        t.config.parsed,
        new Date(t.next_check),
        now,
      );
      changes = [
        {
          key: `schedule:${due.toISOString()}`,
          payload: { kind: "schedule", scheduledAt: due.toISOString() },
        },
      ];
      next = following as Date;
    }
    await this.db.query(
      `WITH live AS (SELECT t.id FROM responsibility_triggers t JOIN responsibilities r ON r.id=t.responsibility_id AND r.revision=t.revision WHERE t.id=$1 AND t.lease=$2 AND r.status='active' FOR UPDATE OF t),
      saved AS (INSERT INTO responsibility_candidates(id,user_id,responsibility_id,revision,source_key,payload)
        SELECT gen_random_uuid(),$3,$4,$5,c->>'key',c->'payload' FROM jsonb_array_elements($6::jsonb)c,live ON CONFLICT DO NOTHING RETURNING id),
      checked AS (INSERT INTO responsibility_checks(id,user_id,trigger_id,outcome,candidates) SELECT gen_random_uuid(),$3,$1,'success',(SELECT count(*) FROM saved) FROM live)
      UPDATE responsibility_triggers SET cursor=$7::jsonb,next_check=$8,last_check=$9,last_success=$9,health='healthy',lease=NULL,lease_until=NULL WHERE id=$1 AND EXISTS(SELECT 1 FROM live)`,
      [
        t.id,
        lease,
        t.user_id,
        t.responsibility_id,
        t.revision,
        JSON.stringify(changes),
        JSON.stringify(cursor),
        next,
        now,
      ],
    );
  }
  private async degraded(t: any, lease: string) {
    const now = this.clock();
    await this.db.query(
      `WITH failed AS (UPDATE responsibility_triggers SET health='degraded',last_check=$3,next_check=$4,lease=NULL,lease_until=NULL WHERE id=$1 AND lease=$2 RETURNING *),
      checked AS (INSERT INTO responsibility_checks(id,user_id,trigger_id,outcome) SELECT gen_random_uuid(),user_id,id,'source_unavailable' FROM failed)
      INSERT INTO responsibility_findings(id,user_id,responsibility_id,revision,payload,decision,reason,fact_key,due_at,state)
      SELECT gen_random_uuid(),user_id,responsibility_id,revision,jsonb_build_object('reply','A source for "'||$5||'" is unavailable. Monitoring is degraded; inspect its history or reconnect the source.','changed','source unavailable','matters','Updates may be missed','evidence','[]'::jsonb),'now','source_degraded','source:'||id,$3,'pending'
      FROM failed WHERE $6::boolean AND EXISTS(SELECT 1 FROM responsibilities r WHERE r.id=failed.responsibility_id AND r.revision=failed.revision AND r.status='active')`,
      [
        t.id,
        lease,
        now,
        new Date(now.getTime() + Math.max(30, t.config.minutes ?? 30) * 60000),
        t.spec.title,
        t.health !== "degraded",
      ],
    );
  }
  async launch(user: string) {
    if (!this.allowed(user)) return { rows: [] };
    const now = this.clock(),
      task = randomUUID();
    // One owner row serializes the two daily caps across every responsibility.
    return withResponsibilityOwner(this.db, user, (tx) =>
      tx.query(
        `WITH owner_lock AS (SELECT id FROM users WHERE id=$1 FOR UPDATE),
      selected AS (SELECT r.*,v.spec FROM responsibilities r JOIN responsibility_revisions v ON v.responsibility_id=r.id AND v.revision=r.revision,owner_lock
        WHERE r.user_id=$1 AND r.status='active' AND (v.spec->>'expiresAt' IS NULL OR (v.spec->>'expiresAt')::timestamptz>$4)
        AND EXISTS(SELECT 1 FROM responsibility_candidates c WHERE c.responsibility_id=r.id AND c.revision=r.revision AND c.task_id IS NULL)
        AND NOT EXISTS(SELECT 1 FROM responsibility_investigations i JOIN work_tasks t ON t.id=i.task_id WHERE i.responsibility_id=r.id AND t.status NOT IN ('done','cancelled'))
        AND (SELECT count(*) FROM responsibility_investigations i WHERE i.user_id=$1 AND (i.created_at AT TIME ZONE 'Asia/Singapore')::date=$2::date)<25
        AND (SELECT count(*) FROM responsibility_investigations i WHERE i.responsibility_id=r.id AND (i.created_at AT TIME ZONE 'Asia/Singapore')::date=$2::date)<6
        ORDER BY (SELECT min(created_at) FROM responsibility_candidates c WHERE c.responsibility_id=r.id AND c.task_id IS NULL) LIMIT 1 FOR UPDATE OF r),
      task AS (INSERT INTO work_tasks(id,user_id,objective,request,status,budget_initialized,budget_ms,budget_models,budget_tools,delivery_context)
        SELECT $3,$1,'Monitoring: '||(spec->>'title'),'Investigate the saved responsibility and exact candidate changes. Record responsibility_report then finish.','queued',true,300000,10,30,'{"source":"responsibility"}' FROM selected RETURNING id),
      v AS (INSERT INTO work_revisions(task_id,revision,request,objective) SELECT $3,1,'Investigate saved responsibility','Monitoring: '||(spec->>'title') FROM selected,task),
      i AS (INSERT INTO responsibility_investigations(task_id,user_id,responsibility_id,revision) SELECT $3,$1,s.id,s.revision FROM selected s,task RETURNING task_id),
      batch AS (SELECT c.id FROM responsibility_candidates c,selected s WHERE c.responsibility_id=s.id AND c.revision=s.revision AND c.task_id IS NULL ORDER BY c.created_at,c.id LIMIT (SELECT CASE WHEN spec ? 'calendar' THEN 1 ELSE 30 END FROM selected))
      UPDATE responsibility_candidates SET task_id=$3 WHERE id IN (SELECT id FROM batch) AND EXISTS(SELECT 1 FROM i) RETURNING id`,
        [user, day(now), task, now],
      ),
    );
  }
  /** Always capture responsibility passes, including pauses: no generic work send. */
  async capture(user: string, task: string, payload: Delivery) {
    const s = await this.service.scope(user, task);
    if (!s) return false;
    if (payload.runId) await this.finalize(s, payload.runId);
    const paused = (
      await this.db.query(
        "SELECT status,pause_reason FROM work_tasks WHERE id=$1 AND user_id=$2",
        [task, user],
      )
    ).rows[0];
    if (
      paused?.status === "paused" &&
      s.status === "active" &&
      s.current_revision === s.revision &&
      !(await this.terminal(s))
    ) {
      if (!s.finding && payload.reason === "answer")
        await this.db.query(
          "UPDATE work_tasks SET pause_reason='finding_missing' WHERE id=$1 AND status='paused'",
          [task],
        );
      const d = attention(s.spec, "now", this.clock());
      await this.db.query(
        `INSERT INTO responsibility_findings(id,user_id,responsibility_id,revision,notice_task_id,payload,decision,reason,fact_key,due_at,state)
        VALUES(gen_random_uuid(),$1,$2,$3,$4,$5::jsonb,$6,'investigation_paused',$7,$8,'pending') ON CONFLICT DO NOTHING`,
        [
          user,
          s.responsibility_id,
          s.revision,
          task,
          JSON.stringify({
            reply: `An investigation for “${s.spec.title}” paused (${paused.pause_reason ?? "finding missing"}). Pending changes are saved. Inspect /status, then explicitly continue or cancel task ${task}; no paused work is resumed automatically.`,
            evidence: [],
          }),
          d.decision,
          `paused:${task}`,
          d.due,
        ],
      );
    }
    return true;
  }
  private async completeReady() {
    const rows = (
      await this.db.query(
        `SELECT i.user_id,i.task_id,i.report_run FROM responsibility_investigations i JOIN runtime_runs r ON r.id=i.report_run WHERE i.state='running' AND i.finding IS NOT NULL AND r.state='stopped' AND r.stop_reason='answer' LIMIT 20`,
      )
    ).rows;
    for (const r of rows) {
      const s = await this.service.scope(r.user_id, r.task_id);
      if (s) await this.finalize(s, r.report_run);
    }
  }
  private async terminal(
    s: Scope,
    finding?: {
      resolved: boolean;
      changed: string;
      evidence: string[];
      proposedAttention: string;
    },
  ) {
    if (s.spec.end === "all_parcels_terminal") {
      const rows = (
        await this.db.query(
          "SELECT id,status,eta,archived_at FROM parcels WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",
          [s.user_id, s.spec.parcelIds],
        )
      ).rows;
      return (
        rows.length === new Set(s.spec.parcelIds).size &&
        rows.every(
          (p) => p.archived_at || ["delivered", "cancelled"].includes(p.status),
        )
      );
    }
    return (
      s.spec.end === "first_match" &&
      !!finding?.resolved &&
      !!finding.changed.trim() &&
      finding.evidence.length > 0 &&
      finding.proposedAttention !== "drop"
    );
  }
  private async finalize(s: Scope, run: string) {
    const finished = (
      await this.db.query(
        `SELECT 1 FROM runtime_runs r JOIN work_tasks t ON t.id=r.task_id WHERE r.id=$1 AND r.user_id=$2 AND r.task_id=$3 AND r.state='stopped' AND r.stop_reason='answer' AND t.status<>'cancelled'`,
        [run, s.user_id, s.task_id],
      )
    ).rows.length;
    const approvals = (
      await this.db.query(
        `SELECT 1 FROM approvals WHERE user_id=$1 AND run_id=$2 AND status='pending'`,
        [s.user_id, run],
      )
    ).rows.length;
    if (!finished || approvals || !s.finding) return;
    if (s.state !== "running") return;
    const f = responsibilityFinding.parse(s.finding),
      now = this.clock();
    const resolved = await this.terminal(s, f);
    const key = hash([
      s.spec.parcelIds.length ? "parcels" : "finding",
      s.spec.parcelIds.length
        ? (
            await this.db.query(
              "SELECT id,status,eta,archived_at FROM parcels WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",
              [s.user_id, s.spec.parcelIds],
            )
          ).rows
        : [
            s.spec.schedule
              ? s.spec.outcome.trim().toLowerCase()
              : s.candidates.map((c) => c.source_key).sort(),
            f.factKey.trim().toLowerCase(),
          ],
      ...(f.actionRequired ? [f.factKey.trim().toLowerCase()] : []),
    ]);
    const duplicate = (
      await this.db.query(
        `SELECT 1 FROM responsibility_findings WHERE user_id=$1 AND fact_key=$2 AND created_at>$3 AND decision NOT IN ('drop','quiet') AND state<>'suppressed' LIMIT 1`,
        [s.user_id, key, new Date(now.getTime() - 86400000)],
      )
    ).rows.length;
    const urgent = s.candidates.some(
      (c) =>
        c.payload.kind === "calendar" &&
        Date.parse(c.payload.event.start.dateTime) > now.getTime() &&
        Date.parse(c.payload.event.start.dateTime) - now.getTime() <= 7200000,
    );
    let decision = attention(
      s.spec,
      !f.changed.trim() ? "quiet" : duplicate ? "drop" : f.proposedAttention,
      now,
      urgent,
      f.actionRequired && !!s.spec.urgentWhen,
    );
    if (s.spec.parcelIds.length && !f.actionRequired) {
      const written = (
        await this.db.query(
          `SELECT c.result FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id WHERE r.task_id=$1 AND r.user_id=$2 AND c.operation='parcel_record' AND c.state='success'`,
          [s.task_id, s.user_id],
        )
      ).rows.map((c) => c.result?.result ?? c.result);
      const affected = [
        ...new Set([
          ...s.candidates
            .filter((c) => c.payload.kind === "parcel")
            .map((c) => c.payload.parcelId),
          ...written
            .filter((c) => c.statusApplied || c.etaApplied)
            .map((c) => c.id),
        ]),
      ];
      const statuses = (
        await this.db.query(
          "SELECT status FROM parcels WHERE user_id=$1 AND id=ANY($2::uuid[])",
          [s.user_id, affected],
        )
      ).rows;
      if (!statuses.some((p) => s.spec.notifyStatuses.includes(p.status)))
        decision = {
          decision: "quiet",
          reason: "parcel_status_not_actionable",
          due: null,
        };
    }
    if (duplicate)
      decision = { decision: "drop", reason: "duplicate_fact", due: null };
    if (resolved) {
      decision = attention(
        s.spec,
        s.spec.silentClosing ? "quiet" : "now",
        now,
        urgent,
      );
      f.reply += "\nI’ve stopped watching; the end condition is met.";
    }
    const expired =
      s.spec.expiresAt && Date.parse(s.spec.expiresAt) <= now.getTime();
    if (s.status !== "active" || s.current_revision !== s.revision || expired)
      decision = {
        decision: "drop",
        reason: expired ? "responsibility_expired" : "superseded_or_inactive",
        due: null,
      };
    await this.db.query(
      `WITH completed AS (UPDATE responsibility_investigations SET state='complete' WHERE task_id=$1 AND user_id=$2 AND state='running' RETURNING *),
      saved AS (INSERT INTO responsibility_findings(id,user_id,responsibility_id,revision,task_id,payload,decision,reason,fact_key,due_at,closing,state)
        SELECT gen_random_uuid(),$2,responsibility_id,revision,$1,$3::jsonb,$4,$5,$6,$7,$8,CASE WHEN $7::timestamptz IS NULL THEN 'quiet' ELSE 'pending' END FROM completed ON CONFLICT DO NOTHING),
      task AS (UPDATE work_tasks SET status='done',pause_reason=NULL WHERE id=$1 AND EXISTS(SELECT 1 FROM completed))
      UPDATE responsibilities SET understanding=$9,status=CASE WHEN $8::boolean THEN 'resolved' ELSE status END,updated_at=now()
      WHERE id=$10 AND user_id=$2 AND revision=$11 AND status='active' AND $12::boolean AND EXISTS(SELECT 1 FROM completed)`,
      [
        s.task_id,
        s.user_id,
        JSON.stringify(f),
        decision.decision,
        decision.reason,
        key,
        decision.due,
        resolved &&
          s.status === "active" &&
          s.current_revision === s.revision &&
          !expired,
        f.understanding,
        s.responsibility_id,
        s.revision,
        !expired,
      ],
    );
  }
  private async sweep(permitted: string[], expiredOnly = false) {
    const rows = (
      await this.db.query(
        `SELECT r.*,v.spec FROM responsibilities r JOIN responsibility_revisions v ON v.responsibility_id=r.id AND v.revision=r.revision
        WHERE r.status='active' AND r.user_id=ANY($2::text[]) AND (
          (v.spec->>'expiresAt' IS NOT NULL AND (v.spec->>'expiresAt')::timestamptz<=$1)
          OR (NOT $3::boolean AND v.spec->>'end'='all_parcels_terminal' AND jsonb_array_length(v.spec->'parcelIds')>0
            AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(v.spec->'parcelIds') watched LEFT JOIN parcels p ON p.id=watched::uuid AND p.user_id=r.user_id WHERE p.id IS NULL OR (p.archived_at IS NULL AND p.status NOT IN ('delivered','cancelled')))
            AND NOT EXISTS(SELECT 1 FROM responsibility_investigations i JOIN work_tasks t ON t.id=i.task_id WHERE i.responsibility_id=r.id AND i.state='running' AND t.status='running')))
        ORDER BY r.id LIMIT 50`,
        [this.clock(), permitted, expiredOnly],
      )
    ).rows;
    for (const r of rows) {
      if (!this.allowed(r.user_id)) continue;
      const expired =
        r.spec.expiresAt &&
        Date.parse(r.spec.expiresAt) <= this.clock().getTime();
      const terminal =
        r.spec.end === "all_parcels_terminal" &&
        (await this.terminal({
          ...r,
          responsibility_id: r.id,
          candidates: [],
        } as Scope));
      if (!expired && !terminal) continue;
      // Let a running investigation combine the final finding and closing message.
      if (
        !expired &&
        (
          await this.db.query(
            `SELECT 1 FROM responsibility_investigations i JOIN work_tasks t ON t.id=i.task_id WHERE i.responsibility_id=$1 AND i.state='running' AND t.status='running'`,
            [r.id],
          )
        ).rows.length
      )
        continue;
      const d = attention(
        r.spec,
        r.spec.silentClosing ? "quiet" : "now",
        this.clock(),
      );
      const closed = await this.db.query(
        `WITH closed AS (UPDATE responsibilities SET status=$3,updated_at=now() WHERE id=$1 AND user_id=$2 AND revision=$4 AND status='active' RETURNING *)
        , saved AS (INSERT INTO responsibility_findings(id,user_id,responsibility_id,revision,payload,decision,reason,fact_key,due_at,closing,state)
        SELECT gen_random_uuid(),user_id,id,revision,jsonb_build_object('reply',$5::text),$6,'end_condition','closing',$7,true,CASE WHEN $7::timestamptz IS NULL THEN 'quiet' ELSE 'pending' END FROM closed ON CONFLICT DO NOTHING)
        SELECT id FROM closed`,
        [
          r.id,
          r.user_id,
          expired ? "expired" : "resolved",
          r.revision,
          `${r.spec.title}: ${expired ? "the monitoring period has ended" : "all watched parcels are delivered, cancelled or archived"}. I’ve stopped watching.`,
          d.decision,
          d.due,
        ],
      );
      for (const row of closed.rows)
        await this.service.onInactive?.(r.user_id, row.id);
    }
  }
}

export class ResponsibilityDelivery {
  private busy = false;
  constructor(
    private service: Responsibilities,
    private allowed: (user: string) => boolean,
    private send: (
      user: string,
      finding: any,
    ) => Promise<{ message_id: number }>,
    private clock = () => new Date(),
    private calendar?: Pick<CalendarTools, "list">,
  ) {}
  private get db() {
    return this.service.db;
  }
  async recover() {
    await this.db.query(
      `UPDATE responsibility_findings SET state='uncertain' WHERE state='sending'`,
    );
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const rows = (
        await this.db.query(
          `SELECT f.*,r.status,r.revision current_revision,r.attention_weight,v.spec FROM responsibility_findings f
        JOIN responsibilities r ON r.id=f.responsibility_id AND r.user_id=f.user_id JOIN responsibility_revisions v ON v.responsibility_id=f.responsibility_id AND v.revision=f.revision
        WHERE f.state='pending' AND f.due_at<=$1 ORDER BY f.due_at,f.id LIMIT 10`,
          [this.clock()],
        )
      ).rows;
      const digestGroups = new Map<string, any[]>();
      for (const f of rows) {
        if (f.notice_task_id) {
          const task = (
            await this.db.query(
              "SELECT status FROM work_tasks WHERE id=$1 AND user_id=$2",
              [f.notice_task_id, f.user_id],
            )
          ).rows[0];
          if (task?.status !== "paused") {
            await this.db.query(
              "UPDATE responsibility_findings SET state='suppressed',reason='investigation_recovered' WHERE id=$1 AND state='pending'",
              [f.id],
            );
            continue;
          }
        }
        if (
          !this.allowed(f.user_id) ||
          f.revision !== f.current_revision ||
          (!f.closing && f.status !== "active") ||
          (!f.closing &&
            f.spec.expiresAt &&
            Date.parse(f.spec.expiresAt) <= this.clock().getTime()) ||
          ["paused", "cancelled"].includes(f.status)
        ) {
          await this.db.query(
            `UPDATE responsibility_findings SET state='suppressed',reason='inactive_or_superseded' WHERE id=$1 AND state='pending'`,
            [f.id],
          );
          continue;
        }
        if (f.task_id && this.calendar) {
          const s = await this.service.scope(f.user_id, f.task_id);
          const events =
            s?.candidates.filter((c) => c.payload.kind === "calendar") ?? [];
          if (events.length) {
            const now = this.clock();
            const current = await this.calendar.list(
              f.user_id,
              now.toISOString(),
              new Date(now.getTime() + 86400000).toISOString(),
              true,
            );
            if (current.truncated) continue;
            if (
              events.some(
                (c) =>
                  !current.events.some(
                    (e: any) =>
                      e.id === c.payload.event.id &&
                      e.status !== "cancelled" &&
                      Date.parse(e.start?.dateTime) > now.getTime() &&
                      e.start?.dateTime === c.payload.event.start.dateTime,
                  ),
              )
            ) {
              const elapsed = events.some(
                (c) =>
                  Date.parse(c.payload.event.start.dateTime) <= now.getTime(),
              );
              await this.db.query(
                `UPDATE responsibility_findings SET state='suppressed',reason=$2 WHERE id=$1 AND state='pending'`,
                [f.id, elapsed ? "meeting_elapsed" : "meeting_changed"],
              );
              continue;
            }
          }
        }
        const id = f.id,
          now = this.clock();
        const urgent =
          !!f.task_id &&
          (await this.service.scope(f.user_id, f.task_id))?.candidates.some(
            (c) =>
              c.payload.kind === "calendar" &&
              Date.parse(c.payload.event.start.dateTime) > now.getTime() &&
              Date.parse(c.payload.event.start.dateTime) - now.getTime() <=
                7200000,
          );
        const quiet = attention(
          { ...f.spec, deliveryTime: undefined },
          "now",
          now,
          urgent,
        );
        if (quiet.reason === "quiet_hours") {
          await this.db.query(
            `UPDATE responsibility_findings SET due_at=$2,reason='quiet_hours' WHERE id=$1 AND state='pending'`,
            [id, quiet.due],
          );
          continue;
        }
        // Reservations count sending and uncertain attempts: ambiguity cannot grant more sends.
        const claimed = (
          await withResponsibilityOwner(this.db, f.user_id, (tx) =>
            tx.query(
              `WITH owner_lock AS (SELECT id FROM users WHERE id=$2 FOR UPDATE),duplicate AS (
                UPDATE responsibility_findings f SET state='suppressed',decision='drop',reason='duplicate_fact'
                WHERE f.id=$1 AND f.user_id=$2 AND f.state='pending' AND NOT f.closing AND f.reason<>'owner_later' AND EXISTS(SELECT 1 FROM owner_lock)
                AND EXISTS(SELECT 1 FROM responsibility_findings x WHERE x.user_id=$2 AND x.id<>f.id AND x.fact_key=f.fact_key AND x.state IN ('sending','sent','uncertain') AND x.due_at>$4::timestamptz-interval '24 hours') RETURNING f.id
              ),eligible AS (
          SELECT f.id FROM responsibility_findings f JOIN responsibilities r ON r.id=f.responsibility_id AND r.revision=f.revision,owner_lock
          WHERE f.id=$1 AND f.user_id=$2 AND f.state='pending' AND (r.status='active' OR (f.closing AND r.status IN ('resolved','expired')))
          AND (f.closing OR NOT EXISTS(SELECT 1 FROM responsibility_revisions v WHERE v.responsibility_id=r.id AND v.revision=r.revision AND (v.spec->>'expiresAt')::timestamptz<=$4))
          AND NOT EXISTS(SELECT 1 FROM duplicate)
          AND (f.decision='briefing' OR ((SELECT count(*) FROM responsibility_findings x WHERE x.user_id=$2 AND x.state IN ('sending','sent','uncertain') AND x.decision='now' AND (x.due_at AT TIME ZONE 'Asia/Singapore')::date=$3::date)<8
          AND (SELECT count(*) FROM responsibility_findings x WHERE x.responsibility_id=f.responsibility_id AND x.state IN ('sending','sent','uncertain') AND x.decision='now' AND (x.due_at AT TIME ZONE 'Asia/Singapore')::date=$3::date)<greatest(1,3+r.attention_weight)))
          FOR UPDATE OF f)
          UPDATE responsibility_findings SET state='sending',due_at=$4 WHERE id IN (SELECT id FROM eligible) RETURNING *`,
              [id, f.user_id, day(now), now],
            ),
          )
        ).rows[0];
        if (!claimed) {
          await this.db.query(
            `UPDATE responsibility_findings SET decision='briefing',reason='interrupt_cap',due_at=$2 WHERE id=$1 AND state='pending'`,
            [id, new Date(now.getTime() + 86400000)],
          );
          continue;
        }
        if (f.decision === "briefing") {
          const members = digestGroups.get(f.user_id) ?? [];
          members.push(f);
          digestGroups.set(f.user_id, members);
          continue;
        }
        try {
          const sent = await this.send(f.user_id, f);
          await this.db.query(
            `UPDATE responsibility_findings SET state='sent',message_id=$2,sent_at=$3 WHERE id=$1`,
            [id, sent.message_id, this.clock()],
          );
        } catch {
          await this.db.query(
            `UPDATE responsibility_findings SET state='uncertain' WHERE id=$1 AND state='sending'`,
            [id],
          );
        }
      }
      for (const [user, all] of digestGroups)
        for (let offset = 0; offset < all.length; offset += 6) {
          const members = all.slice(offset, offset + 6);
          // A digest carries exact member IDs. Ambiguous sends retain every member.
          try {
            const sent = await this.send(user, { members });
            await this.db.query(
              `UPDATE responsibility_findings SET state='sent',message_id=$2,sent_at=$3 WHERE id=ANY($1::uuid[]) AND state='sending'`,
              [members.map((f) => f.id), sent.message_id, this.clock()],
            );
          } catch {
            await this.db.query(
              `UPDATE responsibility_findings SET state='uncertain' WHERE id=ANY($1::uuid[]) AND state='sending'`,
              [members.map((f) => f.id)],
            );
          }
        }
    } finally {
      this.busy = false;
    }
  }
  async feedback(user: string, id: string, message: number, choice: string) {
    if (!["useful", "later", "resolved", "less"].includes(choice)) return;
    const f = (
      await this.db.query(
        `SELECT f.*,r.revision current_revision FROM responsibility_findings f JOIN responsibilities r ON r.id=f.responsibility_id
      WHERE f.id=$1 AND f.user_id=$2 AND f.message_id=$3 AND f.state='sent'`,
        [id, user, message],
      )
    ).rows[0];
    if (!f || f.revision !== f.current_revision) return;
    await withResponsibilityOwner(this.db, user, (tx) =>
      tx.query(
        `WITH voted AS (INSERT INTO responsibility_feedback(finding_id,user_id,choice)
      SELECT $1,$2,$4 FROM responsibility_findings f JOIN responsibilities r ON r.id=f.responsibility_id
      WHERE f.id=$1 AND f.user_id=$2 AND f.message_id=$3 AND f.state='sent' AND r.revision=$5 AND f.revision=$5
      AND ($4<>'later' OR (r.status='active' AND NOT EXISTS(SELECT 1 FROM responsibility_revisions v WHERE v.responsibility_id=r.id AND v.revision=r.revision AND (v.spec->>'expiresAt')::timestamptz<=$7)))
      ON CONFLICT DO NOTHING RETURNING finding_id), feedback AS (UPDATE responsibility_findings SET feedback=$4 WHERE id IN (SELECT finding_id FROM voted) RETURNING *),
      changed AS (UPDATE responsibilities SET status=CASE WHEN $4='resolved' THEN 'resolved' ELSE status END,
        attention_weight=CASE WHEN $4='less' THEN greatest(-3,attention_weight-1) ELSE attention_weight END,updated_at=now()
      WHERE id=(SELECT responsibility_id FROM feedback) AND user_id=$2 AND revision=$5 RETURNING id),
      stopped AS (UPDATE responsibility_findings SET state='suppressed',reason='owner_resolved' WHERE responsibility_id IN (SELECT id FROM changed) AND revision=$5 AND user_id=$2 AND state='pending' AND $4='resolved')
      INSERT INTO responsibility_findings(id,user_id,responsibility_id,revision,payload,decision,reason,fact_key,due_at,state)
      SELECT gen_random_uuid(),user_id,responsibility_id,revision,payload,'briefing','owner_later',fact_key,$6,'pending' FROM feedback WHERE $4='later'`,
        [
          id,
          user,
          message,
          choice,
          f.revision,
          new Date(this.clock().getTime() + 3600000),
          this.clock(),
        ],
      ),
    );
    if (choice === "resolved")
      await this.service.onInactive?.(user, f.responsibility_id);
  }
}
