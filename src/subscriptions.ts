import { createHash, randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { Action } from "./protocol.js";
import {
  subscriptionFields,
  type SubscriptionFields,
} from "./subscription-schema.js";
import { ToolValidationError } from "./tool-errors.js";

type SubscriptionAction = Extract<
  Action,
  { operation: `subscription_${string}` }
>;
type Row = {
  id: string;
  user_id: string;
  data: SubscriptionFields;
  field_sources: Record<string, unknown>;
  revision: number;
  updated_at: string;
};
const NOTICE =
  "Saved owner statements, not verified charges or a complete account audit. Unknown amounts and dates remain unknown. Nothing here changes or pays a merchant account.";
export const subscriptionKey = (value?: string | null) =>
  (value ?? "")
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/\s+/g, " ");
const defaults: SubscriptionFields = {
  category: "other",
  amountType: "unknown",
  cadence: "unknown",
  status: "unknown",
  nextChargeEstimated: false,
  reminderEnabled: false,
};
function validDate(value: string) {
  const n = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === value;
}
function validate(data: SubscriptionFields) {
  subscriptionFields.parse(data);
  if (!data.label)
    throw new ToolValidationError("A subscription needs a label.");
  for (const key of [
    "nextChargeDate",
    "trialEndDate",
    "cancellationDeadline",
    "paidThroughDate",
  ] as const)
    if (data[key] && !validDate(data[key]!))
      throw new ToolValidationError("Use a real calendar date for " + key);
  if ((data.amount != null) !== (data.currency != null))
    throw new ToolValidationError(
      "An amount needs its stated currency; clear both to make the price unknown.",
    );
  if (data.cadence === "days" && !data.intervalDays)
    throw new ToolValidationError("A days cadence needs intervalDays.");
  if (data.cadence !== "days" && data.intervalDays != null)
    throw new ToolValidationError(
      "intervalDays applies only to a days cadence.",
    );
  if (!data.nextChargeDate && data.nextChargeEstimated)
    throw new ToolValidationError("An estimated charge needs a date.");
  // These fields are labels, never places to retain payment identifiers or addresses.
  for (const key of ["label", "merchant", "plan", "accountLabel"] as const)
    if (
      data[key] &&
      /\d(?:[ -]?\d){7,}|\b(?:iban|swift|account number|card number|billing address)\b|\b\d+\s+[^\n,]{0,45}\b(?:street|road|avenue|lane|drive|boulevard)\b/i.test(
        data[key]!,
      )
    )
      throw new ToolValidationError(
        "Use a short merchant, plan or account label without payment numbers or a full address.",
      );
}
type Due = { date: string; events: string[]; days: number; estimated: boolean };
export function subscriptionDates(data: SubscriptionFields): Due[] {
  if (!["active", "trial"].includes(data.status ?? "unknown")) return [];
  const dates: Due[] = [];
  const add = (
    date: string | null | undefined,
    event: string,
    days: number | null,
    estimated = false,
  ) => {
    if (!date) return;
    const existing = dates.find((d) => d.date === date);
    if (existing) {
      existing.events.push(event);
      existing.days = Math.max(existing.days, days ?? -1);
      existing.estimated ||= estimated;
    } else dates.push({ date, events: [event], days: days ?? -1, estimated });
  };
  add(
    data.nextChargeDate,
    "renewal",
    data.cadence === "annual" ? 7 : null,
    !!data.nextChargeEstimated,
  );
  if (data.status === "trial") add(data.trialEndDate, "trial ends", 3);
  add(data.cancellationDeadline, "cancellation deadline", 7);
  return dates.sort((a, b) => a.date.localeCompare(b.date));
}
export function subscriptionReminders(data: SubscriptionFields, now: number) {
  const warnings: string[] = [];
  const plans: { id: string; date: string; content: string; fire: string }[] =
    [];
  if (!data.reminderEnabled) return { plans, warnings };
  for (const due of subscriptionDates(data)) {
    const lead = data.reminderDays ?? due.days;
    if (lead < 0) continue; // Monthly and unknown cadences have no automatic lead time.
    const time = data.reminderTime ?? "09:00";
    const fire = new Date(
      Date.parse(due.date + "T" + time + ":00+08:00") - lead * 86400000,
    ).toISOString();
    if (Date.parse(fire) <= now) {
      warnings.push(
        `${data.label}: the ${due.events.join(" / ")} notice time has passed (${fire}); no late reminder was scheduled. Check the saved date ${due.date}.`,
      );
      continue;
    }
    plans.push({
      id: randomUUID(),
      date: due.date,
      fire,
      content: `${data.label}: ${due.events.join(" / ")} on ${due.date}${due.estimated ? " (estimated)" : " (saved date)"}. ${data.amount != null ? `${data.amount} ${data.currency} (${data.amountType ?? "unknown"} amount). ` : "Amount unknown. "}Review the terms before the decision or charge date. This reminder does not confirm a payment.`,
    });
  }
  return { plans, warnings };
}
function fraction(data: SubscriptionFields): [bigint, bigint] | null {
  if (
    data.status !== "active" ||
    data.amountType !== "fixed" ||
    data.amount == null ||
    !data.currency
  )
    return null;
  const [whole, decimals = ""] = data.amount.split(".");
  const amount = BigInt(whole! + decimals.padEnd(6, "0"));
  const factor: Record<string, [bigint, bigint]> = {
    monthly: [1n, 1n],
    quarterly: [1n, 3n],
    annual: [1n, 12n],
    weekly: [13n, 3n],
    days: [365n, 12n * BigInt(data.intervalDays ?? 1)],
  };
  const f = factor[data.cadence ?? "unknown"];
  return f ? [amount * f[0], 1000000n * f[1]] : null;
}
function decimal(n: bigint, d: bigint, currency: string) {
  let places = 2;
  try {
    places =
      new Intl.NumberFormat("en-SG", {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    /* Unknown ISO-like codes retain two places. */
  }
  const scale = 10n ** BigInt(places);
  const rounded = (n * scale * 2n + d) / (d * 2n);
  return places
    ? `${rounded / scale}.${String(rounded % scale).padStart(places, "0")}`
    : String(rounded);
}
export function subscriptionTotals(rows: Row[]) {
  const currencies = new Map<string, [bigint, bigint, number]>();
  let excluded = 0;
  for (const row of rows) {
    const f = fraction(row.data);
    if (!f) {
      if (["active", "trial", "unknown"].includes(row.data.status ?? "unknown"))
        excluded++;
      continue;
    }
    const code = row.data.currency!;
    const previous = currencies.get(code) ?? [0n, 1n, 0];
    const gcd = (a: bigint, b: bigint): bigint => (b ? gcd(b, a % b) : a);
    const n = previous[0] * f[1] + f[0] * previous[1],
      d = previous[1] * f[1],
      divisor = gcd(n, d);
    currencies.set(code, [n / divisor, d / divisor, previous[2] + 1]);
  }
  return {
    totals: [...currencies]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, [n, d, count]]) => ({
        currency,
        monthlyEquivalent: decimal(n, d, currency),
        items: count,
      })),
    excluded,
    basis:
      "Monthly equivalents of active fixed amounts; annual ÷ 12, quarterly ÷ 3, weekly × 52 ÷ 12, day intervals × 365 ÷ 12 ÷ days. Estimates, not this month's charges. Trial, variable, unknown and cancelled/cancelling amounts excluded. No currency conversion.",
  };
}
function shown(row: Row, details = true) {
  const f = fraction(row.data);
  return {
    id: row.id,
    ...row.data,
    revision: row.revision,
    asOf: row.updated_at,
    lastCheckedAt: null,
    confidence: "owner stated",
    ...(details ? { fieldSources: row.field_sources } : {}),
    monthlyEquivalent: f ? decimal(f[0], f[1], row.data.currency!) : null,
  };
}
export class SubscriptionTools {
  constructor(
    private db: Database,
    private now: () => number = Date.now,
  ) {}
  async call(
    user: string,
    run: string,
    action: SubscriptionAction,
  ): Promise<any> {
    if (action.operation === "subscription_list")
      return this.list(user, action);
    if (action.operation === "subscription_settings") {
      const fields: SubscriptionFields = {};
      if (action.enabled !== undefined) fields.reminderEnabled = action.enabled;
      if (action.daysBefore !== undefined)
        fields.reminderDays = action.daysBefore;
      if (action.time !== undefined) fields.reminderTime = action.time;
      if (!Object.keys(fields).length) return this.read(user, action.id);
      if (!action.requestKey)
        throw new ToolValidationError(
          "Changing reminders needs a unique requestKey; reuse it only for an exact retry.",
        );
      return this.record(user, run, {
        operation: "subscription_record",
        id: action.id,
        baseRevision: action.baseRevision,
        requestKey: action.requestKey,
        fields,
      });
    }
    return this.record(user, run, action);
  }
  private async owned(user: string, id: string): Promise<Row> {
    const row = (
      await this.db.query(
        "SELECT * FROM subscriptions WHERE user_id=$1 AND id=$2",
        [user, id],
      )
    ).rows[0];
    if (!row)
      throw new ToolValidationError(
        "Subscription not found; use subscription_list for this owner's IDs.",
      );
    return row;
  }
  async read(user: string, id: string, offset = 0) {
    const row = await this.owned(user, id);
    const history = (
      await this.db.query(
        "SELECT id,revision,source_kind,source_ref,changes,recorded_at FROM subscription_updates WHERE user_id=$1 AND subscription_id=$2 ORDER BY revision DESC LIMIT 11 OFFSET $3",
        [user, id, offset],
      )
    ).rows;
    const reminders = (
      await this.db.query(
        `SELECT id,to_char(subscription_date,'YYYY-MM-DD') AS date,next_run AS "firesAt",status,last_error FROM daily_schedules WHERE user_id=$1 AND subscription_id=$2 ORDER BY CASE WHEN status='scheduled' THEN 0 WHEN status='processing' THEN 1 ELSE 2 END, subscription_date DESC LIMIT 20`,
        [user, id],
      )
    ).rows;
    const result = {
      notice: NOTICE,
      ...shown(row),
      history: history.slice(0, 10),
      nextOffset: history.length > 10 ? offset + 10 : null,
      reminders,
      timezone: "Asia/Singapore",
    };
    while (result.history.length > 1 && JSON.stringify(result).length > 11000) {
      result.history.pop();
      result.nextOffset = offset + result.history.length;
    }
    return result;
  }
  async list(
    user: string,
    a: Extract<SubscriptionAction, { operation: "subscription_list" }>,
  ) {
    if (a.id) return this.read(user, a.id, a.offset);
    const all = (
      await this.db.query(
        "SELECT * FROM subscriptions WHERE user_id=$1 ORDER BY updated_at DESC,id",
        [user],
      )
    ).rows as Row[];
    const merchant = subscriptionKey(a.merchant),
      plan = subscriptionKey(a.plan),
      account = subscriptionKey(a.accountLabel);
    const rows = all.filter(
      (row) =>
        (a.includeInactive ||
          ["active", "trial", "unknown"].includes(
            row.data.status ?? "unknown",
          )) &&
        (!merchant ||
          subscriptionKey(row.data.merchant ?? row.data.label) === merchant) &&
        (!plan || subscriptionKey(row.data.plan) === plan) &&
        (!account || subscriptionKey(row.data.accountLabel) === account),
    );
    const offset = a.offset ?? 0;
    const decisive = !!merchant && !!(plan || account) && rows.length === 1;
    const today = new Date(this.now() + 8 * 3600000).toISOString().slice(0, 10),
      end = new Date(this.now() + 8 * 3600000 + 30 * 86400000)
        .toISOString()
        .slice(0, 10);
    const upcoming = all
      .flatMap((row) =>
        subscriptionDates(row.data)
          .filter((d) => d.date >= today && d.date < end)
          .map((d) => ({
            id: row.id,
            label: row.data.label,
            date: d.date,
            events: d.events,
            estimated: d.estimated,
          })),
      )
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const result = {
      notice: NOTICE,
      items: rows.slice(offset, offset + 10).map((row) => shown(row, false)),
      total: rows.length,
      nextOffset: offset + 10 < rows.length ? offset + 10 : null,
      ...(merchant
        ? {
            ambiguous: rows.length > 0 && !decisive,
            resolvedId: decisive ? rows[0]!.id : null,
            matchBasis: decisive
              ? "merchant plus plan/account"
              : "merchant alone does not decide",
          }
        : {}),
      ...subscriptionTotals(all),
      upcoming: upcoming.slice(0, 30),
      upcomingTotal: upcoming.length,
      asOf: new Date(this.now()).toISOString(),
    };
    while (result.upcoming.length && JSON.stringify(result).length > 11000)
      result.upcoming.pop();
    while (result.items.length > 1 && JSON.stringify(result).length > 11000) {
      result.items.pop();
      result.nextOffset = offset + result.items.length;
    }
    return result;
  }
  private async record(
    user: string,
    run: string,
    a: Extract<SubscriptionAction, { operation: "subscription_record" }>,
  ) {
    // This is host lane metadata, including a delegated child's inherited lane.
    const turn = (
      await this.db.query(
        "SELECT background FROM work_turns WHERE user_id=$1 AND run_id=$2",
        [user, run],
      )
    ).rows[0];
    if (!turn || turn.background)
      throw new ToolValidationError(
        "Only a foreground owner request may change subscriptions or their reminders.",
      );
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          id: a.id ?? null,
          baseRevision: a.baseRevision ?? null,
          fields: Object.fromEntries(
            Object.entries(a.fields).sort(([x], [y]) => x.localeCompare(y)),
          ),
        }),
      )
      .digest("hex");
    const replay = async () => {
      const previous = (
        await this.db.query(
          "SELECT subscription_id,request_hash FROM subscription_updates WHERE user_id=$1 AND request_key=$2",
          [user, a.requestKey],
        )
      ).rows[0];
      if (!previous) return null;
      if (previous.request_hash !== hash)
        throw new ToolValidationError(
          "That requestKey was used for different subscription data; use a new key.",
        );
      return {
        ...(await this.read(user, previous.subscription_id)),
        duplicate: true,
      };
    };
    const previous = await replay();
    if (previous) return previous;
    const old = a.id ? await this.owned(user, a.id) : null;
    if (old && a.baseRevision !== old.revision)
      throw new ToolValidationError(
        "Subscription changed or baseRevision is missing; read it again before updating.",
      );
    if (!old && a.baseRevision !== undefined)
      throw new ToolValidationError(
        "baseRevision applies only to an existing subscription.",
      );
    if (!Object.keys(a.fields).length)
      throw new ToolValidationError("Supply at least one subscription field.");
    const data = { ...(old?.data ?? defaults), ...a.fields };
    validate(data);
    const merchant = subscriptionKey(data.merchant ?? data.label),
      plan = subscriptionKey(data.plan),
      account = subscriptionKey(data.accountLabel);
    const clash = (
      await this.db.query(
        "SELECT id,plan_key,account_key FROM subscriptions WHERE user_id=$1 AND merchant_key=$2 AND ($3::uuid IS NULL OR id<>$3)",
        [user, merchant, a.id ?? null],
      )
    ).rows;
    if (
      clash.some(
        (row) =>
          (!plan && !account) ||
          (row.plan_key === plan && row.account_key === account),
      )
    )
      throw new ToolValidationError(
        "That merchant already has a saved item. Use subscription_list with merchant, plan and accountLabel; ask the owner when ambiguous, or distinguish a new plan/account.",
      );
    const id = old?.id ?? randomUUID(),
      updateId = randomUUID(),
      revision = (old?.revision ?? 0) + 1;
    const stamp = new Date(this.now()).toISOString();
    const fieldSources = { ...(old?.field_sources ?? {}) };
    for (const key of Object.keys(a.fields))
      fieldSources[key] = { updateId, observedAt: stamp, sourceKind: "owner" };
    const inputs = (
      await this.db.query(
        `SELECT id FROM conversation_inputs WHERE user_id=$1 AND run_id IN ($2::uuid, (SELECT (data->>'parentRunId')::uuid FROM events WHERE user_id=$1 AND run_id=$2 AND type='agent.child_started' LIMIT 1)) ORDER BY ordinal DESC LIMIT 10`,
        [user, run],
      )
    ).rows;
    const source = { runId: run, inputIds: inputs.map((r) => r.id) };
    const { plans, warnings } = subscriptionReminders(data, this.now());
    const otherSchedules = Number(
      (
        await this.db.query(
          "SELECT count(*) AS n FROM daily_schedules WHERE user_id=$1 AND status IN ('scheduled','processing') AND (subscription_id IS NULL OR subscription_id<>$2)",
          [user, id],
        )
      ).rows[0].n,
    );
    if (otherSchedules + plans.length > 50)
      throw new ToolValidationError(
        "Limit of 50 active schedules reached; pause another reminder before enabling these dates.",
      );
    const values: unknown[] = [
      id,
      user,
      JSON.stringify(data),
      JSON.stringify(fieldSources),
      merchant,
      plan,
      account,
      old?.revision ?? 0,
      updateId,
      a.requestKey,
      hash,
      JSON.stringify(source),
      JSON.stringify(a.fields),
      JSON.stringify(plans),
    ];
    const write = old
      ? `UPDATE subscriptions SET data=$3::jsonb,field_sources=$4::jsonb,merchant_key=$5,plan_key=$6,account_key=$7,revision=revision+1,updated_at=now() WHERE id=$1 AND user_id=$2 AND revision=$8 RETURNING *`
      : `INSERT INTO subscriptions(id,user_id,data,field_sources,merchant_key,plan_key,account_key,revision) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8::integer+1) RETURNING *`;
    try {
      const result = (
        await this.db.query(
          `WITH p AS (${write}), u AS (
        INSERT INTO subscription_updates(id,subscription_id,user_id,request_key,request_hash,source_ref,changes,revision)
        SELECT $9,p.id,p.user_id,$10,$11,$12::jsonb,$13::jsonb,p.revision FROM p RETURNING id
      ), withdrawn AS (
        UPDATE daily_schedules SET status='cancelled',lease=NULL,updated_at=now(),last_error=CASE WHEN status='processing' THEN 'Subscription changed during delivery; check Telegram before retrying' ELSE last_error END
        WHERE user_id=$2 AND subscription_id=$1 AND status IN ('scheduled','paused','processing')
        AND EXISTS(SELECT 1 FROM u) AND subscription_date NOT IN (SELECT date::date FROM jsonb_to_recordset($14::jsonb) AS x(date text)) RETURNING id,last_error
      ), reminders AS (
        INSERT INTO daily_schedules(id,user_id,kind,content,schedule,parsed,next_run,subscription_id,subscription_date,subscription_revision)
        SELECT x.id::uuid,p.user_id,'reminder',x.content,x.fire,jsonb_build_object('kind','once','run_at',x.fire,'display',x.fire),x.fire::timestamptz,p.id,x.date::date,p.revision
        FROM p CROSS JOIN jsonb_to_recordset($14::jsonb) AS x(id text,date text,content text,fire text) WHERE EXISTS(SELECT 1 FROM u)
        ON CONFLICT(subscription_id,subscription_date) WHERE subscription_id IS NOT NULL DO UPDATE
        SET content=EXCLUDED.content,schedule=EXCLUDED.schedule,parsed=EXCLUDED.parsed,next_run=EXCLUDED.next_run,subscription_revision=EXCLUDED.subscription_revision,status='scheduled',lease=NULL,updated_at=now()
        WHERE daily_schedules.started_at IS NULL AND daily_schedules.last_delivered IS NULL AND daily_schedules.status IN ('scheduled','paused','cancelled') RETURNING id
      ) SELECT p.*,(SELECT count(*) FROM reminders) AS scheduled,(SELECT count(*) FROM withdrawn WHERE last_error IS NOT NULL) AS possibly_started FROM p JOIN u ON true`,
          values,
        )
      ).rows[0] as Row & { scheduled: number; possibly_started: number };
      if (!result)
        throw new ToolValidationError(
          "Subscription changed while saving; read it again before retrying.",
        );
      const read = await this.read(user, id);
      for (const reminder of read.reminders)
        if (
          plans.some((p) => p.date === reminder.date) &&
          ["completed", "failed", "processing"].includes(reminder.status)
        )
          warnings.push(
            `Reminder for ${reminder.date} is ${reminder.status}; a delivery was already attempted or may have started. Check Telegram; it will not be replayed automatically.`,
          );
      return {
        ...read,
        created: !old,
        updateId,
        warnings,
        ...(Number(result.possibly_started) > 0 ||
        read.reminders.some((r: any) => r.status === "processing")
          ? {
              deliveryNotice:
                "A reminder may already have started delivery; inspect Telegram. It will not be retried automatically.",
            }
          : {}),
      };
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        const duplicate = await replay();
        if (duplicate) return duplicate;
        throw new ToolValidationError(
          "Subscription identity was saved concurrently; list the merchant again before retrying.",
        );
      }
      throw error;
    }
  }
}
