import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { Action } from "./protocol.js";
export type DailyAction = Extract<
  Action,
  {
    operation:
      `item_${string}` | `schedule_${string}` | "calendar_list" | "daily_sync";
  }
>;
export class ScheduleParser {
  constructor(
    private url: string,
    private token: string,
  ) {}
  async next(schedule: string, parsed?: unknown) {
    const r = await fetch(new URL("/v1/schedule", this.url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(parsed ? { parsed } : { schedule }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok)
      throw new Error(
        "Schedule rejected; use in 30m, an explicit ISO date, or every day at 9am (Singapore time)",
      );
    return (await r.json()) as { parsed: any; next: string | null };
  }
}
export class DailyTools {
  constructor(
    private db: Database,
    private parser: Pick<ScheduleParser, "next">,
    private calendar: {
      list(user: string, start: string, end: string): Promise<unknown>;
    },
    private mirror: { sync(user: string): Promise<unknown> },
  ) {}
  async call(user: string, a: DailyAction): Promise<unknown> {
    const db = this.db;
    if (a.operation === "calendar_list")
      return this.calendar.list(user, a.start, a.end);
    if (a.operation === "daily_sync") return this.mirror.sync(user);
    if (a.operation === "item_list")
      return (
        await db.query(
          `SELECT * FROM daily_items WHERE user_id=$1 AND ($2::text IS NULL OR kind=$2) AND ($3::text IS NULL OR status=$3) ORDER BY due_at NULLS LAST,updated_at DESC LIMIT 200`,
          [user, a.kind ?? null, a.status ?? null],
        )
      ).rows;
    if (a.operation === "item_save")
      return (
        await db.query(
          `INSERT INTO daily_items(id,user_id,kind,title,content,due_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
          [randomUUID(), user, a.kind, a.title, a.content, a.dueAt ?? null],
        )
      ).rows[0];
    if (a.operation === "item_update") {
      const row = (
        await db.query(
          `UPDATE daily_items SET title=COALESCE($3,title),content=COALESCE($4,content),status=COALESCE($5,status),due_at=CASE WHEN $6 THEN $7::timestamptz ELSE due_at END,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,
          [
            a.id,
            user,
            a.title ?? null,
            a.content ?? null,
            a.status ?? null,
            a.dueAt !== undefined,
            a.dueAt ?? null,
          ],
        )
      ).rows[0];
      if (!row) throw new Error("Item not found");
      return row;
    }
    if (a.operation === "schedule_list")
      return (
        await db.query(
          `SELECT id,kind,content,schedule,next_run,status,include_email,include_calendar,last_delivered,last_error FROM daily_schedules WHERE user_id=$1 ORDER BY next_run LIMIT 200`,
          [user],
        )
      ).rows;
    if (a.operation === "schedule_create") {
      const n = await this.parser.next(a.schedule);
      if (!n.next || Date.parse(n.next) <= Date.now())
        throw new Error("Choose a future time");
      const row = (
        await db.query(
          `INSERT INTO daily_schedules(id,user_id,kind,content,schedule,parsed,next_run,include_email,include_calendar) SELECT $1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9 WHERE (SELECT count(*) FROM daily_schedules WHERE user_id=$2 AND status IN ('scheduled','processing'))<50 RETURNING *`,
          [
            randomUUID(),
            user,
            a.kind,
            a.content,
            a.schedule,
            JSON.stringify(n.parsed),
            n.next,
            a.includeEmail,
            a.includeCalendar,
          ],
        )
      ).rows[0];
      if (!row) throw new Error("Limit of 50 active schedules reached");
      return {
        ...row,
        timezone: "Asia/Singapore",
        note: "Briefings use a fixed summary of open tasks plus explicitly selected email/calendar sources. Task due dates alone do not create reminders.",
      };
    }
    const old = (
      await db.query(
        "SELECT * FROM daily_schedules WHERE id=$1 AND user_id=$2",
        [a.id, user],
      )
    ).rows[0];
    if (!old) throw new Error("Schedule not found");
    const n = a.schedule
      ? await this.parser.next(a.schedule)
      : a.status === "scheduled"
        ? await this.parser.next(old.schedule, old.parsed)
        : null;
    if (n && !n.next)
      throw new Error("Supply a new future schedule to resume this reminder");
    return (
      await db.query(
        `UPDATE daily_schedules SET schedule=COALESCE($3,schedule),parsed=COALESCE($4::jsonb,parsed),next_run=COALESCE($5::timestamptz,next_run),status=COALESCE($6,status),lease=NULL,last_error=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,
        [
          a.id,
          user,
          a.schedule ?? null,
          n ? JSON.stringify(n.parsed) : null,
          n?.next ?? null,
          a.status ?? (n ? "scheduled" : null),
        ],
      )
    ).rows[0];
  }
}
export class DailyWorker {
  private busy = false;
  constructor(
    private db: Database,
    private parser: Pick<ScheduleParser, "next">,
    private send: (user: string, text: string) => Promise<unknown>,
    private briefing: (job: any) => Promise<string>,
    private sync: (user: string) => Promise<unknown>,
  ) {}
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      // Delivery may have reached Telegram before a crash. Never replay an ambiguous send automatically.
      await this.db.query(
        `UPDATE daily_schedules SET status='failed',last_error='Delivery interrupted; check Telegram before rescheduling',lease=NULL WHERE status='processing' AND started_at<now()-interval '10 minutes'`,
      );
      for (let i = 0; i < 5; i++) {
        const lease = randomUUID();
        const j = (
          await this.db.query(
            `UPDATE daily_schedules SET status='processing',lease=$1,started_at=now() WHERE id=(SELECT id FROM daily_schedules WHERE status='scheduled' AND next_run<=now() ORDER BY next_run FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
            [lease],
          )
        ).rows[0];
        if (!j) break;
        try {
          const text =
            j.kind === "reminder"
              ? `Reminder: ${j.content}`
              : await this.briefing(j);
          const valid = (
            await this.db.query(
              `SELECT id FROM daily_schedules WHERE id=$1 AND lease=$2 AND status='processing'`,
              [j.id, lease],
            )
          ).rows[0];
          if (!valid) continue;
          await this.send(j.user_id, text);
          const n =
            j.parsed.kind === "once"
              ? null
              : await this.parser.next(j.schedule, j.parsed);
          await this.db.query(
            `UPDATE daily_schedules SET status=$3,next_run=COALESCE($4::timestamptz,next_run),last_delivered=now(),lease=NULL,last_error=NULL WHERE id=$1 AND lease=$2`,
            [j.id, lease, n?.next ? "scheduled" : "completed", n?.next ?? null],
          );
        } catch {
          await this.db.query(
            `UPDATE daily_schedules SET status='failed',lease=NULL,last_error='Run or delivery failed; check Telegram before rescheduling' WHERE id=$1 AND lease=$2`,
            [j.id, lease],
          );
        }
        try {
          await this.sync(j.user_id);
        } catch {
          /* Delivery state remains in Postgres if Sheets is unavailable. */
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
