import { createHash, randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { event } from "./db.js";
import { ToolValidationError } from "./tool-errors.js";
import { ScheduleParser } from "./schedule.js";
import { dueWindow } from "./routines.js";
import {
  responsibilitySpec,
  responsibilityFinding,
  type ResponsibilitySpec,
} from "./responsibility-schema.js";
import type { GmailTools } from "./gmail.js";
import type { CalendarTools } from "./calendar.js";
import type { Delivery } from "./answer.js";
import { validateWindow } from "./watch-window.js";
import { withResponsibilityOwner } from "./responsibility-transaction.js";

const fail = (text: string): never => {
  throw new ToolValidationError(text);
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const day = (now: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
const minute = (time: string) =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
function localMinute(now: Date) {
  return minute(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Singapore",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
}
function nextSlot(now: Date, time: string) {
  const target = new Date(`${day(now)}T${time}:00+08:00`);
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  return target;
}
export function attention(
  spec: ResponsibilitySpec,
  proposed: string,
  now: Date,
  timeCritical = false,
  urgent = false,
) {
  if (proposed === "quiet" || proposed === "drop")
    return {
      decision: proposed,
      reason: proposed === "quiet" ? "not_actionable" : "irrelevant",
      due: null,
    };
  if (spec.deliveryTime && !timeCritical && !urgent)
    return {
      decision: "briefing",
      reason: "delivery_slot",
      due: nextSlot(now, spec.deliveryTime),
    };
  if (proposed === "briefing")
    return {
      decision: "briefing",
      reason: "digest",
      due: nextSlot(now, "08:00"),
    };
  const n = localMinute(now),
    start = minute(spec.quietHours.start),
    end = minute(spec.quietHours.end);
  const quiet =
    start === end
      ? false
      : start < end
        ? n >= start && n < end
        : n >= start || n < end;
  return quiet && !timeCritical
    ? {
        decision: "now",
        reason: "quiet_hours",
        due: nextSlot(now, spec.quietHours.end),
      }
    : {
        decision: "now",
        reason: timeCritical ? "time_critical" : "notify",
        due: now,
      };
}
export type Scope = {
  task_id: string;
  user_id: string;
  responsibility_id: string;
  revision: number;
  status: string;
  current_revision: number;
  state: string;
  finding: any;
  spec: ResponsibilitySpec;
  candidates: any[];
};
type Sources = {
  gmail?: Pick<GmailTools, "poll" | "call">;
  calendar?: Pick<CalendarTools, "list">;
};

/** All mutations are owner-scoped; model arguments cannot authorize monitoring. */
export class Responsibilities {
  onInactive?: (user: string, id: string) => Promise<void>;
  constructor(
    readonly db: Database,
    private sources: Sources = {},
    private clock = () => new Date(),
  ) {}
  async list(user: string, offset = 0) {
    return (
      await this.db.query(
        `SELECT r.*,v.spec,
      (SELECT max(last_check) FROM responsibility_triggers t WHERE t.responsibility_id=r.id AND t.revision=r.revision) last_check,
      (SELECT min(next_check) FROM responsibility_triggers t WHERE t.responsibility_id=r.id AND t.revision=r.revision) next_check,
      (SELECT bool_or(health='degraded') FROM responsibility_triggers t WHERE t.responsibility_id=r.id AND t.revision=r.revision) degraded,
      (SELECT count(*)::int FROM responsibility_investigations i WHERE i.responsibility_id=r.id AND (i.created_at AT TIME ZONE 'Asia/Singapore')::date=$2::date) investigations_today,
      (SELECT jsonb_build_object('decision',f.decision,'reason',f.reason,'createdAt',f.created_at) FROM responsibility_findings f WHERE f.responsibility_id=r.id ORDER BY f.created_at DESC LIMIT 1) last_finding
      FROM responsibilities r JOIN responsibility_revisions v ON v.responsibility_id=r.id AND v.revision=r.revision
      WHERE r.user_id=$1 ORDER BY CASE WHEN r.status IN ('active','paused') THEN 0 ELSE 1 END,r.created_at DESC,r.id DESC OFFSET $3 LIMIT 50`,
        [user, day(this.clock()), offset],
      )
    ).rows;
  }
  async history(user: string, id: string, offset = 0) {
    const row = (
      await this.db.query(
        `SELECT r.*,v.spec,
          (SELECT max(last_check) FROM responsibility_triggers t WHERE t.responsibility_id=r.id AND t.revision=r.revision) last_check,
          (SELECT min(next_check) FROM responsibility_triggers t WHERE t.responsibility_id=r.id AND t.revision=r.revision) next_check,
          (SELECT bool_or(health='degraded') FROM responsibility_triggers t WHERE t.responsibility_id=r.id AND t.revision=r.revision) degraded,
          (SELECT count(*)::int FROM responsibility_investigations i WHERE i.responsibility_id=r.id AND (i.created_at AT TIME ZONE 'Asia/Singapore')::date=$3::date) investigations_today
          FROM responsibilities r JOIN responsibility_revisions v ON v.responsibility_id=r.id AND v.revision=r.revision WHERE r.id=$1 AND r.user_id=$2`,
        [id, user, day(this.clock())],
      )
    ).rows[0];
    if (!row) fail("Responsibility unavailable");
    const findings = (
      await this.db.query(
        `SELECT * FROM responsibility_findings WHERE responsibility_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC OFFSET $3 LIMIT 10`,
        [id, user, offset],
      )
    ).rows;
    const checks = (
      await this.db.query(
        `SELECT c.* FROM responsibility_checks c JOIN responsibility_triggers t ON t.id=c.trigger_id WHERE t.responsibility_id=$1 AND c.user_id=$2 ORDER BY c.created_at DESC OFFSET $3 LIMIT 10`,
        [id, user, offset],
      )
    ).rows;
    const investigations = (
      await this.db.query(
        `SELECT i.*,t.status,t.pause_reason,t.used_models,t.used_tools,t.used_ms,
      (SELECT COALESCE(sum(c.actual_usd),0) FROM provider_charges c WHERE c.run_id IN (SELECT id FROM runtime_runs WHERE task_id=i.task_id)) reported_cost,
      (SELECT COALESCE(sum(c.estimated_usd),0) FROM provider_charges c WHERE c.actual_usd IS NULL AND c.run_id IN (SELECT id FROM runtime_runs WHERE task_id=i.task_id)) estimated_unknown_cost
      FROM responsibility_investigations i JOIN work_tasks t ON t.id=i.task_id WHERE i.responsibility_id=$1 AND i.user_id=$2 ORDER BY i.created_at DESC OFFSET $3 LIMIT 10`,
        [id, user, offset],
      )
    ).rows;
    return {
      responsibility: row,
      findings,
      checks,
      investigations,
      nextOffset:
        Math.max(findings.length, checks.length, investigations.length) === 10
          ? offset + 10
          : null,
    };
  }
  async call(user: string, run: string, a: any) {
    if (a.operation === "responsibility_list")
      return this.list(user, a.offset ?? 0);
    if (a.operation === "responsibility_history")
      return this.history(user, a.id, a.offset);
    if (a.operation === "responsibility_report")
      return this.report(user, run, a.finding);
    const turn = (
      await this.db.query(
        "SELECT background FROM work_turns WHERE run_id=$1 AND user_id=$2",
        [run, user],
      )
    ).rows[0];
    if (!turn || turn.background)
      fail(
        "Only an explicit foreground owner request may change responsibilities",
      );
    let old: any;
    if (a.operation === "responsibility_update") {
      old = (
        await this.db.query(
          "SELECT * FROM responsibilities WHERE id=$1 AND user_id=$2 AND revision=$3",
          [a.id, user, a.baseRevision],
        )
      ).rows[0];
      if (!old)
        fail("Responsibility unavailable or revision changed; read it again");
      if (!a.spec) {
        if (!a.status) fail("Give a new specification or a lifecycle status");
        if (["cancelled", "expired", "resolved"].includes(old.status))
          fail(
            "Finished responsibilities cannot resume; create a new confirmed responsibility",
          );
        await withResponsibilityOwner(this.db, user, async (tx) => {
          const changed = await tx.query(
            "UPDATE responsibilities SET status=$4,updated_at=now() WHERE id=$1 AND user_id=$2 AND revision=$3 AND status IN ('active','paused') RETURNING id",
            [a.id, user, a.baseRevision, a.status],
          );
          if (!changed.rows.length)
            fail(
              "Responsibility changed concurrently; read its current revision before changing lifecycle",
            );
          if (a.status !== "active")
            await tx.query(
              `UPDATE responsibility_findings SET state='suppressed',reason='owner_${a.status}' WHERE responsibility_id=$1 AND user_id=$2 AND revision=$3 AND state='pending'`,
              [a.id, user, a.baseRevision],
            );
        });
        if (a.status !== "active") await this.onInactive?.(user, a.id);
        await event(this.db, user, run, "responsibility.lifecycle", {
          id: a.id,
          state: a.status,
        });
        return {
          id: a.id,
          status: a.status,
          revision: a.baseRevision,
          notice:
            "Existing investigations remain inspectable. No paused work was automatically resumed.",
        };
      }
    }
    const spec = responsibilitySpec.parse(a.spec);
    if (spec.schedule && !spec.publicQuery) {
      if (spec.outcome.length > 500)
        fail(
          "Scheduled research needs an exact publicQuery of at most 500 characters",
        );
      spec.publicQuery = spec.outcome;
    }
    if (spec.monitoringWindow) validateWindow(spec.monitoringWindow);
    if (
      !spec.gmail &&
      !spec.calendar &&
      !spec.schedule &&
      !spec.parcelIds.length
    )
      fail("Choose an exact source or schedule");
    if (spec.end === "all_parcels_terminal" && !spec.parcelIds.length)
      fail("Parcel completion needs exact parcel IDs");
    if (spec.end === "date" && !spec.expiresAt)
      fail("A date end condition needs expiresAt");
    if (spec.expiresAt && new Date(spec.expiresAt) <= this.clock())
      fail("Choose a future expiry");
    if (spec.parcelIds.length) {
      const owned = (
        await this.db.query(
          "SELECT id FROM parcels WHERE user_id=$1 AND id=ANY($2::uuid[])",
          [user, spec.parcelIds],
        )
      ).rows;
      if (owned.length !== new Set(spec.parcelIds).size)
        fail("Every parcel must be an exact owned record");
    }
    if (preview(spec).length > 3800)
      fail(
        "Monitoring confirmation is too long; narrow the outcome, query or subjects so the entire policy fits on the confirmation card",
      );
    const configs: any[] = [];
    if (spec.gmail) {
      if (!this.sources.gmail) fail("Gmail is unavailable");
      const accounts = (await this.sources.gmail!.call(
        user,
        "gmail_accounts",
        "",
      )) as any;
      const mailbox = accounts.accounts.find(
        (x: any) => x.account === spec.gmail!.account,
      );
      if (!mailbox) fail("Confirmed mailbox unavailable");
      configs.push({
        kind: "gmail",
        config: { ...spec.gmail, email: mailbox.email.toLowerCase() },
        due: this.clock(),
      });
    }
    if (spec.calendar) {
      if (!this.sources.calendar) fail("Calendar is unavailable");
      configs.push({
        kind: "calendar",
        config: spec.calendar,
        due: this.clock(),
      });
    }
    if (spec.schedule) {
      const parsed = await new ScheduleParser(() => this.clock()).next(
        spec.schedule,
      );
      if (!parsed.next) fail("Choose a future schedule");
      configs.push({
        kind: "schedule",
        config: { schedule: spec.schedule, parsed: parsed.parsed },
        due: parsed.next,
      });
    }
    if (spec.parcelIds.length)
      configs.push({
        kind: "parcel",
        config: { ids: spec.parcelIds },
        due: this.clock(),
      });
    const pinnedEmail = configs.find((c) => c.kind === "gmail")?.config.email;
    if (preview(spec, pinnedEmail).length > 3800)
      fail(
        "Narrow this specification so the entire exact confirmation fits on one card",
      );
    const approval = randomUUID(),
      id = old?.id ?? randomUUID();
    await this.db.query(
      `INSERT INTO approvals(id,user_id,run_id,operation,payload) VALUES($1,$2,$3,'responsibility_confirm',$4::jsonb)`,
      [
        approval,
        user,
        run,
        JSON.stringify({ id, baseRevision: old?.revision ?? 0, spec, configs }),
      ],
    );
    return {
      id,
      approvalId: approval,
      status: "awaiting_confirmation",
      preview: preview(spec, pinnedEmail),
      notice:
        "Monitoring starts only after the owner confirms this exact Telegram card.",
    };
  }
  async confirm(user: string, id: string, yes: boolean) {
    const result = await withResponsibilityOwner(this.db, user, (tx) =>
      tx.query(
        `WITH owner_lock AS (SELECT id FROM users WHERE id=$2 FOR UPDATE),
      a AS (UPDATE approvals SET status=CASE WHEN $3::boolean THEN 'approved' ELSE 'denied' END
        WHERE id=$1 AND user_id=$2 AND operation='responsibility_confirm' AND status='pending' AND expires_at>now() AND EXISTS(SELECT 1 FROM owner_lock) RETURNING *),
      valid AS (SELECT * FROM a WHERE $3::boolean AND (
        ((payload->>'baseRevision')::int=0 AND (SELECT count(*) FROM responsibilities WHERE user_id=$2 AND status IN ('active','paused'))<50)
        OR EXISTS(SELECT 1 FROM responsibilities r WHERE r.id=(a.payload->>'id')::uuid AND r.user_id=$2 AND r.revision=(a.payload->>'baseRevision')::int AND r.status IN ('active','paused')))),
      r AS (INSERT INTO responsibilities(id,user_id,revision) SELECT (payload->>'id')::uuid,$2,(payload->>'baseRevision')::int+1 FROM valid
        ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,status='active',understanding='',attention_weight=0,updated_at=now()
        WHERE responsibilities.user_id=$2 AND responsibilities.revision=EXCLUDED.revision-1 RETURNING *),
      v AS (INSERT INTO responsibility_revisions(responsibility_id,revision,user_id,spec,approval_id)
        SELECT r.id,r.revision,$2,a.payload->'spec',a.id FROM r,valid a RETURNING *),
      t AS (INSERT INTO responsibility_triggers(id,responsibility_id,user_id,revision,kind,config,next_check,cursor)
        SELECT gen_random_uuid(),v.responsibility_id,$2,v.revision,c->>'kind',c->'config',(c->>'due')::timestamptz,
          jsonb_build_object('watermark',now(),'activatedAt',now()) FROM v,valid a,jsonb_array_elements(a.payload->'configs') c RETURNING id)
      SELECT r.id,r.revision FROM r`,
        [id, user, yes],
      ),
    );
    if (yes && !result.rows.length)
      fail(
        "Confirmation expired, already used, or the responsibility changed; request a fresh card",
      );
    if (yes && result.rows[0].revision > 1)
      await this.onInactive?.(user, result.rows[0].id);
    return { status: yes ? "active" : "declined", ...result.rows[0] };
  }
  async scope(user: string, task: string): Promise<Scope | undefined> {
    const row = (
      await this.db.query(
        `SELECT i.*,r.status,r.understanding,r.revision current_revision,v.spec FROM responsibility_investigations i
      JOIN responsibilities r ON r.id=i.responsibility_id AND r.user_id=i.user_id
      JOIN responsibility_revisions v ON v.responsibility_id=i.responsibility_id AND v.revision=i.revision
      WHERE i.task_id=$1 AND i.user_id=$2`,
        [task, user],
      )
    ).rows[0];
    if (!row) return;
    row.candidates = (
      await this.db.query(
        "SELECT source_key,payload FROM responsibility_candidates WHERE task_id=$1 AND user_id=$2 ORDER BY created_at,id",
        [task, user],
      )
    ).rows;
    row.expired =
      !!row.spec.expiresAt &&
      Date.parse(row.spec.expiresAt) <= this.clock().getTime();
    row.priorFindings = (
      await this.db.query(
        `SELECT payload,decision,reason FROM responsibility_findings WHERE responsibility_id=$1 AND user_id=$2 AND revision=$3 AND task_id IS NOT NULL ORDER BY created_at DESC LIMIT 3`,
        [row.responsibility_id, user, row.revision],
      )
    ).rows;
    return row;
  }
  async scopeForRun(user: string, run: string) {
    const task = (
      await this.db.query(
        "SELECT task_id FROM work_turns WHERE user_id=$1 AND run_id=$2",
        [user, run],
      )
    ).rows[0]?.task_id;
    return task ? this.scope(user, task) : undefined;
  }
  allowedOperations(scope: Scope) {
    return new Set([
      "responsibility_report",
      ...(scope.spec.parcelIds.length ? ["parcel_list", "parcel_record"] : []),
      ...(scope.spec.gmail ? ["gmail_read"] : []),
      ...(scope.spec.schedule ? ["web_search", "web_read"] : []),
    ]);
  }
  async authorize(user: string, run: string, a: any) {
    const s = await this.scopeForRun(user, run);
    if (!s) return;
    if (
      s.status !== "active" ||
      s.current_revision !== s.revision ||
      s.state !== "running"
    )
      fail("Responsibility paused, finished or superseded");
    if (
      s.spec.expiresAt &&
      Date.parse(s.spec.expiresAt) <= this.clock().getTime()
    )
      fail("Responsibility monitoring period has expired");
    if (s.finding && a.operation !== "responsibility_report")
      fail(
        "Finding already recorded; finish this investigation before doing more work",
      );
    if (!this.allowedOperations(s).has(a.operation))
      fail("Operation outside the responsibility permission scope");
    if (a.operation === "web_search" && a.query !== s.spec.publicQuery)
      fail("Public research must use the exact confirmed publicQuery");
    if (a.operation === "web_read") {
      const searches = (
        await this.db.query(
          `SELECT c.result FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id WHERE r.task_id=$1 AND r.user_id=$2 AND c.operation='web_search' AND c.state='success'`,
          [s.task_id, user],
        )
      ).rows;
      const urls = new Set<string>();
      for (const row of searches) {
        const value = row.result?.result ?? row.result;
        let content: any;
        try {
          content = JSON.parse(value.content);
        } catch {
          continue;
        }
        for (const result of Array.isArray(content)
          ? content
          : (content.results ?? []))
          if (typeof result.url === "string") urls.add(result.url);
      }
      if (!urls.has(a.url))
        fail(
          "Read only exact URLs returned by this investigation’s confirmed public search",
        );
    }
    if (a.operation === "gmail_read" || a.operation === "parcel_record") {
      const candidate = s.candidates.find(
        (c) =>
          c.payload.kind === "gmail" &&
          c.payload.id === a.messageId &&
          c.payload.account === (a.account ?? "primary").toLowerCase(),
      );
      if (candidate) {
        const live = (await this.sources.gmail?.call(
          user,
          "gmail_accounts",
          "",
        )) as any;
        if (
          !live?.accounts.some(
            (m: any) =>
              m.account === candidate.payload.account &&
              m.email.toLowerCase() === candidate.payload.email.toLowerCase(),
          )
        )
          fail(
            "Confirmed Gmail identity changed; reconfirm the responsibility before reading",
          );
      }
    }
    if (a.operation.startsWith("parcel_")) {
      if (!a.id || !s.spec.parcelIds.includes(a.id))
        fail("Parcel outside the confirmed subjects");
      if (a.operation === "parcel_record") {
        if (a.archive !== undefined || a.sourceKind !== "email" || !a.messageId)
          fail(
            "Unattended parcel writes require verified email provenance and cannot create, archive or impersonate owner statements",
          );
        const candidate = s.candidates.find(
          (c) =>
            c.payload.kind === "gmail" &&
            c.payload.id === a.messageId &&
            c.payload.account === (a.account ?? "primary").toLowerCase(),
        );
        if (!candidate) fail("Email outside the confirmed candidate messages");
        const read = (
          await this.db.query(
            `SELECT c.result FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id
          WHERE r.user_id=$1 AND r.task_id=$2 AND c.operation='gmail_read' AND c.state='success'`,
            [user, s.task_id],
          )
        ).rows
          .map((c) => c.result?.result ?? c.result)
          .find(
            (c) =>
              c.id === a.messageId && c.account === candidate.payload.account,
          );
        const header = (name: string) =>
          read?.headers?.find((h: any) => h.name === name)?.value;
        if (
          !read ||
          !header("date") ||
          Date.parse(a.observedAt) !== Date.parse(header("date"))
        )
          fail("Parcel observation time must match the email actually read");
        a.account = candidate.payload.account;
        a.threadId = read.threadId;
        a.sender = header("from");
        a.subject = header("subject");
      }
    }
    if (
      a.operation === "gmail_read" &&
      !s.candidates.some(
        (c) =>
          c.payload.kind === "gmail" &&
          c.payload.id === a.messageId &&
          c.payload.account === (a.account ?? "primary").toLowerCase(),
      )
    )
      fail("Message outside the confirmed candidates");
  }
  async report(user: string, run: string, input: unknown) {
    const s = await this.scopeForRun(user, run);
    if (!s) fail("A responsibility investigation is required");
    const finding = responsibilityFinding.parse(input);
    const mailReads = (
      await this.db.query(
        `SELECT c.result FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id WHERE r.task_id=$1 AND r.user_id=$2 AND c.operation='gmail_read' AND c.state='success'`,
        [s!.task_id, user],
      )
    ).rows.map((c) => c.result?.result ?? c.result);
    for (const key of finding.evidence.filter((k) => k.startsWith("gmail:"))) {
      const candidate = s!.candidates.find((c) => c.source_key === key);
      if (
        !candidate ||
        !mailReads.some(
          (r) =>
            r.id === candidate.payload.id &&
            r.account === candidate.payload.account,
        )
      )
        fail("Gmail evidence must have been read in this investigation");
    }
    const keys = new Set([
      ...s!.candidates.map((c) => c.source_key),
      ...s!.spec.parcelIds.map((id) => `parcel:${id}`),
    ]);
    const sources = (
      await this.db.query(
        `SELECT c.result FROM runtime_calls c JOIN runtime_runs r ON r.id=c.run_id WHERE r.user_id=$1 AND r.task_id=$2 AND c.operation='web_read' AND c.state='success'`,
        [user, s!.task_id],
      )
    ).rows;
    for (const row of sources) {
      const value = row.result?.result ?? row.result;
      if (value.sourceUrl) keys.add(value.sourceUrl);
    }
    if (finding.changed.trim() && !finding.evidence.length)
      fail("A changed finding needs evidence");
    if (finding.evidence.some((k) => !keys.has(k)))
      fail(
        "Finding evidence must reference this investigation’s candidate keys, subjects or pages actually read",
      );
    const saved = await this.db.query(
      `UPDATE responsibility_investigations SET finding=$3::jsonb,report_run=$4 WHERE task_id=$1 AND user_id=$2 AND state='running' AND finding IS NULL RETURNING task_id`,
      [s!.task_id, user, JSON.stringify(finding), run],
    );
    if (!saved.rows.length) fail("Finding already saved");
    return {
      recorded: true,
      notice: "Finish normally. The host decides whether and when to notify.",
    };
  }
}
export function preview(s: ResponsibilitySpec, email?: string) {
  const sources: string[] = [];
  if (s.gmail)
    sources.push(
      `Gmail ${s.gmail.account}${email ? " (" + email + ")" : ""}: ${s.gmail.query}; every ${s.gmail.minutes} minutes`,
    );
  if (s.parcelIds.length)
    sources.push(
      "Saved parcel changes: checked every 15 seconds; email observations only on these IDs",
    );
  if (s.calendar)
    sources.push(
      `Primary Calendar: ${s.calendar.leadHours}h before timed meetings with ${s.calendar.internalDomains.length ? "attendees outside " + s.calendar.internalDomains.join(", ") : "any non-owner, non-resource attendee"}; checked every 5 minutes`,
    );
  if (s.schedule)
    sources.push(
      `Public research: ${s.schedule}; exact search query: ${s.publicQuery ?? s.outcome}. A bounded model investigation may run each occurrence even when unchanged.`,
    );
  return [
    s.title,
    `Outcome: ${s.outcome}`,
    `Subjects: ${s.parcelIds.join(", ") || "the exact source filters below"}`,
    `Sources:\n${sources.join("\n")}`,
    ...(s.monitoringWindow
      ? [
          `Monitoring window: ${s.monitoringWindow.start}–${s.monitoringWindow.end} SGT, ${s.monitoringWindow.days?.join(", ") || "every day"}`,
        ]
      : []),
    `Notify when: ${s.notifyWhen}${s.parcelIds.length ? "; parcel statuses: " + s.notifyStatuses.join(", ") + " or action required" : ""}`,
    ...(s.urgentWhen
      ? [
          `Urgent outside the delivery slot: ${s.urgentWhen}. Quiet hours still apply unless a watched meeting starts within 2 hours.`,
        ]
      : []),
    `Delivery: ${s.deliveryTime ?? "when actionable; deferred findings in an 08:00 SGT digest"}; quiet ${s.quietHours.start}–${s.quietHours.end} SGT`,
    `Ends: ${s.end}${s.expiresAt ? " (" + s.expiresAt + ")" : ""}; closing ${s.silentClosing ? "silent" : "one message"}`,
    "Limits: 6 investigations/day, 25 across responsibilities; 5 minutes, 10 model and 30 tool calls each. Interrupt caps: 3/day here, 8 across responsibilities. Confirm to start.",
  ].join("\n");
}
