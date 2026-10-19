import { createHash } from "node:crypto";
import type { Delivery } from "./answer.js";
import type { Database } from "./db.js";
import { ScheduleParser } from "./schedule.js";
import type { SubscriptionFields } from "./subscription-schema.js";
import {
  decimalKey,
  effectiveRow,
  priceOn,
  singaporeDay,
  subscriptionDates,
  subscriptionTotals,
  type Row,
} from "./subscriptions.js";
import { ToolValidationError } from "./tool-errors.js";

// The monthly summary (issue 132 S7, R10) is built from saved records when it is sent, with no
// model call. It is one briefing-kind schedule per owner, found by a stable ID derived from the
// owner, so no migration is needed and DailyWorker's existing claim, delivery and
// no-replay rules apply.
const CONTENT = "Monthly subscription summary";
const LIST = 12;

export function summaryScheduleId(user: string) {
  const h = createHash("sha256")
    .update(`subscription-summary:${user}`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type Change = { date: string; text: string };
const money = (amount?: string | null, currency?: string | null) =>
  amount != null && currency ? `${amount} ${currency}` : "unknown";
const cap = (lines: string[], none: string) =>
  lines.length
    ? lines.slice(0, LIST).join("\n") +
      (lines.length > LIST ? `\n…and ${lines.length - LIST} more` : "")
    : none;

/** The calendar month before the given Singapore day, as [YYYY-MM, start, end) instants. */
export function previousMonth(today: string) {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const year = m === 1 ? y - 1 : y,
    month = m === 1 ? 12 : m - 1;
  return monthWindow(`${year}-${String(month).padStart(2, "0")}`);
}
export function monthWindow(month: string) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next =
    m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return {
    month,
    start: Date.parse(`${month}-01T00:00:00+08:00`),
    end: Date.parse(`${next}-01T00:00:00+08:00`),
    label: new Date(`${month}-15T00:00:00Z`).toLocaleDateString("en-SG", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }),
  };
}

/** Saved records only: totals now, changes recorded in the month, and the next 30 days. */
export async function buildSubscriptionSummary(
  db: Database,
  user: string,
  now: number,
  month?: string,
): Promise<Delivery> {
  const today = singaporeDay(now);
  const window = month ? monthWindow(month) : previousMonth(today);
  const stored = (
    await db.query("SELECT * FROM subscriptions WHERE user_id=$1 ORDER BY id", [
      user,
    ])
  ).rows as Row[];
  const rows = stored.map((r) => effectiveRow(r, today));
  const label = new Map(rows.map((r) => [r.id, r.data.label ?? "Item"]));
  const totals = subscriptionTotals(rows);
  const updates = (
    await db.query(
      "SELECT subscription_id,revision,changes,source_ref,recorded_at FROM subscription_updates WHERE user_id=$1 ORDER BY subscription_id,revision",
      [user],
    )
  ).rows as {
    subscription_id: string;
    revision: number;
    changes: SubscriptionFields;
    source_ref: Record<string, any>;
    recorded_at: string | Date;
  }[];
  const inWindow = (t: number) => t >= window.start && t < window.end;
  const dayOf = (t: number) => singaporeDay(t);
  const added: Change[] = [],
    ended: Change[] = [],
    prices: Change[] = [];
  // Replay each item's history so a price change is reported with the price it replaced.
  const state = new Map<
    string,
    { amount?: string | null; currency?: string | null }
  >();
  // Each item's status before the month and at its end, so one item gives one status line.
  const status = new Map<
    string,
    { start?: string; end?: string; at?: string }
  >();
  for (const u of updates) {
    const at = new Date(u.recorded_at).getTime();
    const name = label.get(u.subscription_id) ?? "Item";
    const before = { ...(state.get(u.subscription_id) ?? {}) };
    const applied = u.source_ref?.appliedPending;
    if (applied) {
      const effective = Date.parse(`${applied.effectiveDate}T00:00:00+08:00`);
      if (inWindow(effective))
        prices.push({
          date: applied.effectiveDate,
          text: `${name}: ${money(before.amount, before.currency)} → ${money(applied.to.amount, applied.to.currency)} from ${applied.effectiveDate} (saved price change)`,
        });
      before.amount = applied.to.amount;
      before.currency = applied.to.currency;
    }
    const after = { ...before };
    if ("amount" in u.changes) after.amount = u.changes.amount;
    if ("currency" in u.changes) after.currency = u.changes.currency;
    state.set(u.subscription_id, after);
    if (at >= window.end) continue;
    const st = status.get(u.subscription_id) ?? {};
    if ("status" in u.changes || u.revision === 1) {
      const value = u.changes.status ?? "unknown";
      // Before the month: the baseline. A create inside the month is its own baseline.
      if (!inWindow(at) || u.revision === 1) st.start = value;
      if (inWindow(at)) {
        st.end = value;
        st.at = dayOf(at);
      }
    }
    status.set(u.subscription_id, st);
    if (!inWindow(at)) continue;
    const day = dayOf(at);
    if (u.revision === 1)
      added.push({ date: day, text: `${name}: added ${day}` });
    const samePrice =
      after.currency === before.currency &&
      (after.amount == null) === (before.amount == null) &&
      (after.amount == null ||
        decimalKey(after.amount) === decimalKey(before.amount!));
    if (u.revision > 1 && !samePrice)
      prices.push({
        date: day,
        text: `${name}: ${money(before.amount, before.currency)} → ${money(after.amount, after.currency)} (${u.source_ref?.invoice ? `from the invoice matched for ${u.source_ref.invoice.matchDate}` : "owner"}, recorded ${day})`,
      });
  }
  // One line per item whose status changed over the month: ended, or reactivated.
  const gone = (x?: string) => x === "cancelled" || x === "cancelling";
  const live = (x?: string) => x === "active" || x === "trial";
  const reactivated: Change[] = [];
  for (const [id, st] of status) {
    if (st.end === undefined || st.end === st.start) continue;
    const name = label.get(id) ?? "Item";
    if (gone(st.end) && !gone(st.start))
      ended.push({
        date: st.at!,
        text: `${name}: ${st.end} (recorded ${st.at})`,
      });
    else if (live(st.end) && gone(st.start))
      reactivated.push({
        date: st.at!,
        text: `${name}: ${st.end} again (recorded ${st.at})`,
      });
  }
  // A saved price change already in effect but not yet recorded; not for an ended item.
  for (const r of rows)
    if (
      r.appliedPending &&
      !gone(r.data.status) &&
      inWindow(
        Date.parse(`${(r.appliedPending as any).effectiveDate}T00:00:00+08:00`),
      )
    ) {
      const a = r.appliedPending as any;
      prices.push({
        date: a.effectiveDate,
        text: `${r.data.label}: ${money(a.from.amount, a.from.currency)} → ${money(a.to.amount, a.to.currency)} from ${a.effectiveDate} (saved price change)`,
      });
    }
  const end = singaporeDay(now + 30 * 86400000);
  // Dates from the stored row keep a price change listed on its effective day; prices from the effective view.
  const storedData = new Map(stored.map((r) => [r.id, r.data]));
  const upcoming = rows
    .flatMap((r) =>
      subscriptionDates(storedData.get(r.id)!)
        .filter((d) => d.date >= today && d.date < end)
        .map((d) => ({
          date: d.date,
          text: `${d.date} · ${r.data.label}: ${d.events.join(" / ")}${d.estimated ? " (estimated)" : ""} · ${priceOn(r.data, d.date).trim()}`,
        })),
    )
    .sort(
      (a, b) => a.date.localeCompare(b.date) || a.text.localeCompare(b.text),
    );
  // Every item the totals leave out, with the reason; matches subscriptionTotals' excluded count.
  const unknown = rows.flatMap((r) => {
    const d = r.data,
      st = d.status ?? "unknown";
    if (!["active", "trial", "unknown"].includes(st)) return [];
    const reason =
      st === "trial"
        ? "trial"
        : st === "unknown"
          ? "status unknown"
          : d.amount == null
            ? "amount unknown"
            : d.amountType !== "fixed"
              ? `${d.amountType ?? "unknown"} amount`
              : !d.cadence || d.cadence === "unknown"
                ? "cadence unknown"
                : null;
    return reason
      ? [
          `${d.label}: ${d.amount == null ? "" : money(d.amount, d.currency) + ", "}${reason}`,
        ]
      : [];
  });
  const byDate = (a: Change, b: Change) =>
    a.date.localeCompare(b.date) || a.text.localeCompare(b.text);
  const totalText = totals.totals.length
    ? totals.totals
        .map(
          (t) =>
            `${t.monthlyEquivalent} ${t.currency} a month (${t.items} item${t.items === 1 ? "" : "s"})`,
        )
        .join("\n")
    : "No active fixed-price items.";
  const changes = [
    ...added.sort(byDate).map((c) => "New · " + c.text),
    ...ended.sort(byDate).map((c) => "Ended · " + c.text),
    ...reactivated.sort(byDate).map((c) => "Back · " + c.text),
    ...prices.sort(byDate).map((c) => "Price · " + c.text),
  ];
  const sections: NonNullable<Delivery["sections"]> = [
    {
      title: "Monthly equivalents now",
      body:
        totalText +
        (totals.excluded
          ? `\n${totals.excluded} item${totals.excluded === 1 ? "" : "s"} excluded (trial, variable or unknown amount, unknown cadence or status); see Not in the totals.`
          : "") +
        "\nEstimates per currency, not this month's charges; no currency conversion.",
    },
    {
      title: `Changes in ${window.label}`,
      body: cap(changes, "No recorded changes."),
    },
    {
      title: "Next 30 days",
      body: cap(
        upcoming.map((u) => u.text),
        "No saved renewals, trial ends, deadlines or price changes.",
      ),
    },
  ];
  if (unknown.length)
    sections.push({
      title: "Not in the totals",
      body: cap(unknown, ""),
    });
  return {
    reply: [
      `Subscriptions — ${window.label} summary`,
      totalText,
      changes.length
        ? `${window.label}: ${added.length} new, ${ended.length} ended, ${reactivated.length ? `${reactivated.length} back, ` : ""}${prices.length} price change${prices.length === 1 ? "" : "s"}.`
        : `${window.label}: no recorded changes.`,
      `Next 30 days:\n${cap(
        upcoming.map((u) => u.text),
        "Nothing saved.",
      )}`,
      "From saved records only, not bank or card statements. Open Sections for details.",
    ].join("\n\n"),
    sections,
  };
}

/** Turn the owner's monthly summary on or off; the schedule fires on `day` at `time` Singapore time. */
export async function setSubscriptionSummary(
  db: Database,
  user: string,
  now: number,
  settings: { enabled: boolean; day?: number; time?: string },
) {
  const id = summaryScheduleId(user);
  const existing = (
    await db.query(
      "SELECT status,schedule FROM daily_schedules WHERE id=$1 AND user_id=$2",
      [id, user],
    )
  ).rows[0];
  // A setting written during a delivery would be overwritten when the delivery completes.
  if (existing?.status === "processing")
    throw new ToolValidationError(
      "The monthly summary is being sent right now; try the change again in a minute.",
    );
  // Omitted day or time keep the saved ones.
  const [savedMinute, savedHour, savedDay] = String(
    existing?.schedule ?? "0 9 1 * *",
  ).split(" ");
  const day = settings.day ?? Number(savedDay),
    time =
      settings.time ??
      `${savedHour!.padStart(2, "0")}:${savedMinute!.padStart(2, "0")}`,
    [hour, minute] = time.split(":").map(Number) as [number, number];
  const schedule = `${minute} ${hour} ${day} * *`;
  const display = `monthly on day ${day} at ${time} Singapore time`;
  const parsed = { kind: "cron", expr: schedule, display };
  const next = (
    await new ScheduleParser(() => new Date(now)).next(schedule, parsed)
  ).next!;
  try {
    const row = (
      await db.query(
        `INSERT INTO daily_schedules(id,user_id,kind,content,schedule,parsed,next_run,status)
         VALUES($1,$2,'briefing',$3,$4,$5::jsonb,$6::timestamptz,$7)
         ON CONFLICT(id) DO UPDATE SET schedule=EXCLUDED.schedule,parsed=EXCLUDED.parsed,next_run=EXCLUDED.next_run,
           status=EXCLUDED.status,
           content=EXCLUDED.content,include_email=false,include_calendar=false,updated_at=now()
         WHERE daily_schedules.user_id=EXCLUDED.user_id AND daily_schedules.status<>'processing'
         RETURNING status,next_run AS "nextRun"`,
        [
          id,
          user,
          CONTENT,
          schedule,
          JSON.stringify(parsed),
          next,
          settings.enabled ? "scheduled" : "cancelled",
        ],
      )
    ).rows[0];
    // No row: the worker claimed it after the check above; refuse as for a delivery in progress.
    if (!row)
      throw new ToolValidationError(
        "The monthly summary is being sent right now; try the change again in a minute.",
      );
    return {
      enabled: row.status === "scheduled",
      schedule: display,
      nextRun: settings.enabled ? row.nextRun : null,
      notice:
        "Built from saved records with no model call: monthly equivalents, the previous month's recorded changes and the next 30 days.",
    };
  } catch (error) {
    if (
      (error as { constraint?: string }).constraint ===
      "daily_schedule_capacity_limit"
    )
      throw new ToolValidationError(
        "Limit of 50 active schedules reached; pause another schedule before enabling the monthly summary.",
      );
    throw error;
  }
}

/** Whether the owner's summary is on, and when it next runs. */
export async function summaryStatus(db: Database, user: string) {
  const row = (
    await db.query(
      `SELECT status,next_run AS "nextRun",parsed->>'display' AS schedule,last_error AS "lastError" FROM daily_schedules WHERE id=$1 AND user_id=$2`,
      [summaryScheduleId(user), user],
    )
  ).rows[0];
  return row
    ? {
        enabled: row.status === "scheduled",
        schedule: row.schedule,
        nextRun: row.status === "scheduled" ? row.nextRun : null,
        status: row.status,
        ...(row.status === "failed"
          ? {
              lastError: row.lastError,
              statusNotice:
                "A delivery failed and was not replayed; the summary stays stopped until it is turned on again.",
            }
          : {}),
      }
    : { enabled: false, schedule: null, nextRun: null, status: "off" };
}
