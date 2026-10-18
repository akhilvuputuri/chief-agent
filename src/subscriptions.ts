import { createHash, randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { Action } from "./protocol.js";
import {
  subscriptionFields,
  type SubscriptionFields,
} from "./subscription-schema.js";
import { ToolValidationError } from "./tool-errors.js";
import { opsLog } from "./ops-log.js";
import {
  issuerIdentity,
  productEvidence,
  type InvoiceFacts,
} from "./gathering/facts.js";

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
  "Saved owner statements, plus fields the owner asked to take from matched invoice PDFs (marked sourceKind invoice). Not verified charges or a complete account audit. Unknown amounts and dates remain unknown. Nothing here changes or pays a merchant account.";
const INVOICE_NOTICE =
  "Invoices matched by gathering, with typed clues recorded from each PDF. Amounts are every currency amount found in the document (totals, subtotals and tax alike), not a verified charge. Using one in the tracker needs the owner's request; a listed invoice is not an instruction to save it.";
// Fields an invoice can evidence; the rest of a record still comes from the owner.
const invoiceKeys = ["amount", "currency", "lastInvoiceDate"] as const;
type MatchedInvoice = {
  collection_id: string;
  target_key: string;
  artifact_id: string;
  match_date: string;
  date_basis: "invoice_date" | "service_period";
  receipt_id: string;
  collection_state: string;
  scope: {
    targets: {
      key: string;
      label: string;
      month: string;
      accountLabel?: string;
    }[];
  };
  facts: InvoiceFacts;
};
// Current-scope matches only: a superseded scope's matches are history, not evidence.
const matchedInvoices = `SELECT g.collection_id,g.target_key,g.artifact_id,g.match_date,g.date_basis,g.receipt_id,c.state AS collection_state,c.scope,k.facts
  FROM gather_items g
  JOIN gather_collections c ON c.id=g.collection_id AND c.user_id=g.user_id AND g.scope_revision=c.task_revision
  JOIN gather_candidates k ON k.collection_id=g.collection_id AND k.target_key=g.target_key AND k.artifact_id=g.artifact_id AND k.user_id=g.user_id
  WHERE g.user_id=$1`;
const decimalKey = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return whole!.replace(/^0+(?=\d)/, "") + (trimmed ? "." + trimmed : "");
};
const legal = new Set([
  "inc",
  "llc",
  "ltd",
  "ab",
  "pbc",
  "corp",
  "gmbh",
  "plc",
  "ai",
  "com",
]);
// Trailing legal or domain suffixes ("Spotify AB", "Claude.ai") do not change the issuer.
const words = (value: string) => {
  const w = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  // Keep a suffix when what remains would be too short to name an issuer ("X Corp" stays distinct from "X.ai").
  while (
    w.length > 1 &&
    legal.has(w[w.length - 1]!) &&
    w.slice(0, -1).join("").length >= 3
  )
    w.pop();
  return w;
};
/** Vendor identity of a name, ignoring legal suffixes and reading sized plan names as their tier. */
const issuerOf = (name: string) =>
  issuerIdentity(planTier(name) ?? words(name).join(" "));
const leads = (a: string[], b: string[]) =>
  a.length > 0 && a.length <= b.length && a.every((w, i) => w === b[i]);
/** One issuer: known vendor groups, or one name leading the other ("YouTube" / "YouTube Premium"). A shared later word ("Premium", "Max") is not enough. */
function sameIssuer(owner: string, issuer: string) {
  if (issuerOf(owner) === issuerOf(issuer)) return true;
  const a = words(owner),
    b = words(issuer);
  return leads(a, b) || leads(b, a);
}
/** "Claude Max 5x", or "Max20" with an Anthropic merchant, reads as "Claude Max": the family and tier productEvidence recognises. */
function planTier(name: string, family?: string) {
  const w = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (let i = 0; i < w.length; i++) {
    const tier = /^(plus|pro|max|team|business|enterprise)(?:\d+x?)?$/.exec(
      w[i]!,
    )?.[1];
    if (!tier) continue;
    const named = w.slice(0, i).find((x) => x === "claude" || x === "chatgpt");
    const base =
      named === "claude" ? "Claude" : named === "chatgpt" ? "ChatGPT" : family;
    if (base) return base + " " + tier[0]!.toUpperCase() + tier.slice(1);
  }
  return null;
}
const planFamily: Record<string, string> = {
  anthropic: "Claude",
  openai: "ChatGPT",
};
/** The invoice date that orders a file: an invoice-date match, or the PDF's only invoice date. */
function recordedDate(row: MatchedInvoice) {
  return row.date_basis === "invoice_date" && row.match_date.length === 10
    ? row.match_date
    : row.facts.invoiceDates.length === 1
      ? row.facts.invoiceDates[0]!
      : null;
}
/** Whether a matched invoice can belong to this item: issuer, plan and gathered account. */
function identityRefusal(row: MatchedInvoice, data: SubscriptionFields) {
  const target = row.scope.targets.find((t) => t.key === row.target_key);
  const facts = row.facts;
  // The issuer must match the item's merchant (or its label without one); a plan never decides the issuer.
  const owner = data.merchant ?? data.label!;
  const issuers = [target?.label ?? "", ...facts.issuerLabels].filter(Boolean);
  // Any name of the item can place it in a plan family; that only adds conflict checks.
  const family = [data.merchant, data.label]
    .map((n) => (n ? planFamily[issuerOf(n)] : undefined))
    .find(Boolean);
  const plans = [
    data.plan,
    data.label,
    data.plan && `${data.label} ${data.plan}`,
    data.plan && data.merchant && `${data.merchant} ${data.plan}`,
    data.plan && family && `${family} ${data.plan}`,
  ];
  if (!issuers.some((n) => sameIssuer(owner, n)))
    return "This invoice's recorded issuer does not match this item's merchant (or its label when it has no merchant).";
  if (
    plans
      .flatMap((n) => (n ? [n, planTier(n, family)] : []))
      .some((n) => n && productEvidence(facts, n) === "conflict")
  )
    return "This invoice explicitly identifies a different plan or product from this item.";
  if (
    target?.accountLabel &&
    subscriptionKey(target.accountLabel) !== subscriptionKey(data.accountLabel)
  )
    return `This invoice was gathered for account "${target.accountLabel}"; it can update only an item with that accountLabel.`;
  return null;
}
// A findings agent has one host-recorded coordinator; it cannot choose another run.
const inputScope = `user_id=$1 AND run_id IN ($2::uuid, (SELECT (data->>'parentRunId')::uuid FROM events WHERE user_id=$1 AND run_id=$2 AND type='agent.child_started' LIMIT 1))`;
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
    "lastInvoiceDate",
    "pendingEffectiveDate",
  ] as const)
    if (data[key] && !validDate(data[key]!))
      throw new ToolValidationError("Use a real calendar date for " + key);
  if ((data.amount != null) !== (data.currency != null))
    throw new ToolValidationError(
      "An amount needs its stated currency; clear both to make the price unknown.",
    );
  const pending = [
    data.pendingAmount,
    data.pendingCurrency,
    data.pendingEffectiveDate,
  ].filter((v) => v != null).length;
  if (pending !== 0 && pending !== 3)
    throw new ToolValidationError(
      "A pending price change needs pendingAmount, pendingCurrency and pendingEffectiveDate together; clear all three to drop it.",
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
type Due = {
  date: string;
  events: string[];
  days: number;
  estimated: boolean;
  /** Default lead per event; a filtered date uses only its remaining events' leads. */
  leads: Record<string, number>;
};
const priceNoticeDays = 3;
const singaporeDay = (now: number) =>
  new Date(now + 8 * 3600000).toISOString().slice(0, 10);
/** The price in force on a date: a pending change applies from its effective date. */
function priceOn(data: SubscriptionFields, date: string) {
  const applied =
    !!data.pendingEffectiveDate && data.pendingEffectiveDate <= date;
  const amount = applied ? data.pendingAmount : data.amount,
    currency = applied ? data.pendingCurrency : data.currency;
  return amount != null
    ? `${amount} ${currency} (${data.amountType ?? "unknown"} amount${applied ? ", after the saved price change" : ""}). `
    : "Amount unknown. ";
}
/** From its effective date a pending price is the current price; the next write records it in history. */
export function effectiveRow<
  T extends {
    data: SubscriptionFields;
    field_sources: Record<string, unknown>;
  },
>(row: T, today: string): T & { appliedPending?: Record<string, unknown> } {
  const d = row.data;
  if (!d.pendingEffectiveDate || d.pendingEffectiveDate > today) return row;
  const { pendingAmount, pendingCurrency, pendingEffectiveDate, ...rest } = d;
  const {
    pendingAmount: source,
    pendingCurrency: _c,
    pendingEffectiveDate: _d,
    ...sources
  } = row.field_sources ?? {};
  const applied = { ...(source as object), appliedOn: pendingEffectiveDate };
  return {
    ...row,
    data: { ...rest, amount: pendingAmount, currency: pendingCurrency },
    field_sources: { ...sources, amount: applied, currency: applied },
    appliedPending: {
      from: { amount: d.amount ?? null, currency: d.currency ?? null },
      to: { amount: pendingAmount, currency: pendingCurrency },
      effectiveDate: pendingEffectiveDate,
    },
  };
}
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
      existing.leads[event] = days ?? -1;
      existing.estimated ||= estimated;
    } else
      dates.push({
        date,
        events: [event],
        days: days ?? -1,
        estimated,
        leads: { [event]: days ?? -1 },
      });
  };
  add(
    data.nextChargeDate,
    "renewal",
    data.cadence === "annual" ? 7 : null,
    !!data.nextChargeEstimated,
  );
  if (data.status === "trial") add(data.trialEndDate, "trial ends", 3);
  add(data.cancellationDeadline, "cancellation deadline", 7);
  add(data.pendingEffectiveDate, "price change", 3);
  return dates.sort((a, b) => a.date.localeCompare(b.date));
}
export function subscriptionReminders(data: SubscriptionFields, now: number) {
  const warnings: string[] = [];
  const plans: { id: string; date: string; content: string; fire: string }[] =
    [];
  // Price-change notices follow priceAlerts (on unless turned off); every other date needs reminders on.
  const alerts = data.priceAlerts !== false;
  for (const due of subscriptionDates(data)) {
    // priceAlerts=false removes the price-change notice whether or not other reminders are on.
    const events = (
      data.reminderEnabled
        ? due.events
        : due.events.filter((e) => e === "price change")
    ).filter((e) => alerts || e !== "price change");
    if (!events.length) continue;
    const lead = data.reminderEnabled
      ? (data.reminderDays ?? Math.max(...events.map((e) => due.leads[e]!)))
      : priceNoticeDays;
    if (lead < 0) continue; // Monthly and unknown cadences have no automatic lead time.
    const time = data.reminderTime ?? "09:00";
    const fire = new Date(
      Date.parse(due.date + "T" + time + ":00+08:00") - lead * 86400000,
    ).toISOString();
    if (Date.parse(fire) <= now) {
      warnings.push(
        `${data.label}: the ${events.join(" / ")} notice time has passed (${fire}); no late reminder was scheduled. Check the saved date ${due.date}.`,
      );
      continue;
    }
    plans.push({
      id: randomUUID(),
      date: due.date,
      fire,
      content: events.includes("price change")
        ? `${data.label}: price changes on ${due.date} from ${data.amount != null ? `${data.amount} ${data.currency}` : "an unknown amount"} to ${data.pendingAmount} ${data.pendingCurrency} (saved notice).${events.length > 1 ? ` Also on that date: ${events.filter((e) => e !== "price change").join(" / ")}.` : ""} Review the terms before it takes effect. This reminder does not confirm a payment.`
        : `${data.label}: ${events.join(" / ")} on ${due.date}${due.estimated ? " (estimated)" : " (saved date)"}. ${priceOn(data, due.date)}Review the terms before the decision or charge date. This reminder does not confirm a payment.`,
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
    confidence: Object.values(row.field_sources ?? {}).some(
      (s) => (s as { sourceKind?: string })?.sourceKind === "invoice",
    )
      ? "owner stated; marked fields from matched invoices"
      : "owner stated",
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
    if (action.operation === "subscription_invoices")
      return this.invoices(user, action, run);
    if (action.operation === "subscription_list" && action.sourceInputs)
      return this.inputs(user, run, action.offset ?? 0);
    if (action.operation === "subscription_list")
      return this.list(user, action);
    if (action.operation === "subscription_settings") {
      const fields: SubscriptionFields = {};
      if (action.enabled !== undefined) fields.reminderEnabled = action.enabled;
      if (action.priceAlerts !== undefined)
        fields.priceAlerts = action.priceAlerts;
      if (action.daysBefore !== undefined)
        fields.reminderDays = action.daysBefore;
      if (action.time !== undefined) fields.reminderTime = action.time;
      if (!Object.keys(fields).length)
        throw new ToolValidationError(
          "Specify a reminder change; inspect settings with subscription_list(id), which is read-only.",
        );
      if (!action.requestKey)
        throw new ToolValidationError(
          "Changing reminders needs a unique requestKey; reuse it only for an exact retry.",
        );
      return this.record(user, run, {
        operation: "subscription_record",
        id: action.id,
        baseRevision: action.baseRevision,
        requestKey: action.requestKey,
        sourceInputIds: action.sourceInputIds,
        fields,
      });
    }
    return this.record(user, run, action);
  }
  /**
   * After gathering matches an invoice: does it agree with the one active tracked item it can belong to?
   * Read-only; the same issuer, plan and account rules as invoice evidence decide the item.
   */
  async priceCheck(
    user: string,
    collectionId: string,
    targetKey: string,
    artifactId: string,
  ) {
    const row = (
      await this.db.query(
        `${matchedInvoices} AND g.collection_id=$2 AND g.target_key=$3 AND g.artifact_id=$4`,
        [user, collectionId, targetKey, artifactId],
      )
    ).rows[0] as MatchedInvoice | undefined;
    if (!row) return null;
    const today = singaporeDay(this.now());
    const items = (
      (
        await this.db.query(
          "SELECT * FROM subscriptions WHERE user_id=$1 AND data->>'status' IN ('active','trial') ORDER BY id",
          [user],
        )
      ).rows as Row[]
    ).filter((item) => !identityRefusal(row, item.data));
    if (!items.length) return null;
    if (items.length > 1)
      return {
        status: "ambiguous" as const,
        subscriptionIds: items.map((i) => i.id),
        notice:
          "Several tracked items could own this invoice; no price comparison was made. Ask the owner which item it belongs to.",
      };
    const item = items[0]!,
      d = item.data,
      date = recordedDate(row);
    const base = {
      subscriptionId: item.id,
      label: d.label,
      invoiceDate: date,
      alerts: d.priceAlerts !== false,
    };
    if (d.lastInvoiceDate && (!date || date < d.lastInvoiceDate))
      return {
        status: "not_newer" as const,
        ...base,
        notice: `The tracker already reflects a later invoice (${d.lastInvoiceDate}); no comparison was made.`,
      };
    // Compare with the price in force on the invoice date, including a saved price change.
    const on = date ?? today;
    const pendingApplies =
      !!d.pendingEffectiveDate && d.pendingEffectiveDate <= on;
    const amount = pendingApplies ? d.pendingAmount : d.amount,
      currency = pendingApplies ? d.pendingCurrency : d.currency;
    const invoiceAmounts = [...row.facts.amounts]
      .sort(
        (x, y) =>
          Number(y.currency === currency) - Number(x.currency === currency),
      )
      .slice(0, 8);
    if (amount == null || !currency)
      return {
        status: "no_saved_price" as const,
        ...base,
        invoiceAmounts,
        notice: "The tracked item has no saved price to compare.",
      };
    const shows = row.facts.amounts.some(
      (x) =>
        x.currency === currency && decimalKey(x.amount) === decimalKey(amount),
    );
    return {
      status: shows ? ("unchanged" as const) : ("differs" as const),
      ...base,
      saved: { amount, currency, pendingApplied: pendingApplies },
      invoiceAmounts,
      notice: shows
        ? "The invoice shows the saved price."
        : "The invoice does not show the saved price. It may have changed; the tracker was not changed. Applying it needs the owner's request.",
    };
  }
  /** One Telegram alert per tracked item and invoice, never repeated; the tracker itself is unchanged. */
  async queuePriceAlert(
    user: string,
    check: Awaited<ReturnType<SubscriptionTools["priceCheck"]>>,
    artifactId: string,
  ) {
    if (!check || check.status !== "differs" || !check.alerts) return false;
    const h = createHash("sha256")
      .update(`price-alert:${user}:${check.subscriptionId}:${artifactId}`)
      .digest("hex");
    const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
    const fire = new Date(this.now()).toISOString();
    const amounts = check.invoiceAmounts
      .map((x) => `${x.amount} ${x.currency}`)
      .join(", ");
    const content = `${check.label}: possible price change. The invoice${check.invoiceDate ? ` dated ${check.invoiceDate}` : ""} does not show the saved ${check.saved.amount} ${check.saved.currency}${amounts ? `; amounts on it: ${amounts}` : ""}. The tracker was not changed. Ask Chief to update ${check.label} from this invoice if the price changed, or to turn off its price alerts.`;
    try {
      return (
        (
          await this.db.query(
            "INSERT INTO daily_schedules(id,user_id,kind,content,schedule,parsed,next_run) VALUES($1,$2,'reminder',$3,$4,jsonb_build_object('kind','once','run_at',$4::text,'display',$4::text),$4::timestamptz) ON CONFLICT(id) DO NOTHING RETURNING id",
            [id, user, content.slice(0, 1000), fire],
          )
        ).rows.length > 0
      );
    } catch (error) {
      if (
        (error as { constraint?: string }).constraint ===
        "daily_schedule_capacity_limit"
      ) {
        opsLog("subscription.price_alert_skipped", "warn", {
          ref: check.subscriptionId,
          kind: "capacity",
        });
        return false;
      }
      throw error;
    }
  }
  /** An agent bound to a gathering task works only with that task's collection. */
  private async assignedCollection(user: string, run?: string) {
    if (!run) return null;
    return ((
      await this.db.query(
        "SELECT c.id FROM gather_collections c JOIN work_turns w ON w.task_id=c.task_id AND w.user_id=c.user_id WHERE w.run_id=$1 AND w.user_id=$2 AND EXISTS(SELECT 1 FROM events e WHERE e.user_id=$2 AND e.run_id=$1 AND e.type='agent.child_started')",
        [run, user],
      )
    ).rows[0]?.id ?? null) as string | null;
  }
  async invoices(
    user: string,
    a: Extract<SubscriptionAction, { operation: "subscription_invoices" }>,
    run?: string,
  ) {
    const assigned = await this.assignedCollection(user, run);
    if (assigned && a.collectionId && a.collectionId !== assigned)
      throw new ToolValidationError(
        "This agent may read only its assigned collection's invoices.",
      );
    const rows = (
      await this.db.query(
        `${matchedInvoices} AND ($2::uuid IS NULL OR g.collection_id=$2) ORDER BY g.match_date DESC,g.collection_id,g.target_key,g.artifact_id`,
        [user, assigned ?? a.collectionId ?? null],
      )
    ).rows as MatchedInvoice[];
    const linked = new Map<string, string[]>();
    for (const row of (
      await this.db.query(
        "SELECT DISTINCT subscription_id,source_ref->'invoice'->>'artifactId' AS artifact FROM subscription_updates WHERE user_id=$1 AND source_ref ? 'invoice'",
        [user],
      )
    ).rows)
      linked.set(row.artifact, [
        ...(linked.get(row.artifact) ?? []),
        row.subscription_id,
      ]);
    const shownRows = rows
      .map((row) => {
        const target = row.scope.targets.find((t) => t.key === row.target_key);
        return { row, target };
      })
      .filter(
        ({ row, target }) =>
          !a.issuer ||
          [target?.label ?? "", ...row.facts.issuerLabels].some((n) =>
            sameIssuer(a.issuer!, n),
          ),
      );
    const offset = a.offset ?? 0;
    const result = {
      notice: INVOICE_NOTICE,
      invoices: shownRows.slice(offset, offset + 10).map(({ row, target }) => ({
        collectionId: row.collection_id,
        artifactId: row.artifact_id,
        targetKey: row.target_key,
        target: target?.label ?? null,
        accountLabel: target?.accountLabel ?? null,
        month: target?.month ?? null,
        matchDate: row.match_date,
        dateBasis: row.date_basis,
        collectionState: row.collection_state,
        issuerLabels: row.facts.issuerLabels,
        productLabels: row.facts.productLabels,
        invoiceDates: row.facts.invoiceDates,
        serviceMonths: row.facts.serviceMonths,
        amounts: row.facts.amounts,
        linkedSubscriptionIds: linked.get(row.artifact_id) ?? [],
      })),
      total: shownRows.length,
      nextOffset: offset + 10 < shownRows.length ? offset + 10 : null,
    };
    while (
      result.invoices.length > 1 &&
      JSON.stringify(result).length > 11000
    ) {
      result.invoices.pop();
      result.nextOffset = offset + result.invoices.length;
    }
    return result;
  }
  /** The host checks each invoice-backed field against the PDF's recorded clues. */
  private async invoiceEvidence(
    user: string,
    run: string,
    invoice: { collectionId: string; artifactId: string },
    fields: SubscriptionFields,
    data: SubscriptionFields,
    old: Row | null,
  ) {
    const backed = invoiceKeys.filter((k) => fields[k] != null);
    if (!backed.length)
      throw new ToolValidationError(
        "An invoice reference must support amount/currency or lastInvoiceDate; record other fields from the owner's statement without it.",
      );
    const assigned = await this.assignedCollection(user, run);
    if (assigned && invoice.collectionId !== assigned)
      throw new ToolValidationError(
        "This agent may cite only its assigned collection's invoices.",
      );
    const rows = (
      await this.db.query(
        `${matchedInvoices} AND g.collection_id=$2 AND g.artifact_id=$3 ORDER BY g.target_key`,
        [user, invoice.collectionId, invoice.artifactId],
      )
    ).rows as MatchedInvoice[];
    if (!rows.length)
      throw new ToolValidationError(
        "That file is not a matched invoice in this owner's current collection scope; use subscription_invoices for matched invoice IDs.",
      );
    let refusal = "";
    for (const row of rows) {
      const facts = row.facts;
      const recorded = recordedDate(row);
      const identity = identityRefusal(row, data);
      if (identity) refusal = identity;
      else if (
        (fields.amount != null || fields.currency != null) &&
        !facts.amounts.some(
          (x) =>
            x.currency === data.currency &&
            data.amount != null &&
            decimalKey(x.amount) === decimalKey(data.amount),
        )
      )
        refusal =
          "That amount and currency do not occur in the invoice's recorded amounts; use an amount listed by subscription_invoices or ask the owner.";
      // Only a single recorded invoice date can set lastInvoiceDate or order this invoice; the caller never chooses it.
      else if (fields.lastInvoiceDate && fields.lastInvoiceDate !== recorded)
        refusal = recorded
          ? `lastInvoiceDate must be this file's recorded invoice date (${recorded}).`
          : "This file has no single recorded invoice date, so lastInvoiceDate cannot come from it; ask the owner.";
      else if (
        old?.data.lastInvoiceDate &&
        (!recorded || recorded < old.data.lastInvoiceDate)
      )
        refusal = recorded
          ? `This invoice (${recorded}) is older than the saved last invoice (${old.data.lastInvoiceDate}); an older invoice cannot replace newer invoice fields.`
          : `This invoice has no single recorded invoice date, so it cannot be ordered against the saved last invoice (${old.data.lastInvoiceDate}); ask the owner.`;
      else if (fields.amount != null && !fields.lastInvoiceDate && recorded)
        refusal = `Include this invoice's lastInvoiceDate (${recorded}) with its amount so later invoices can be ordered.`;
      else
        return {
          backed,
          ref: {
            collectionId: row.collection_id,
            artifactId: row.artifact_id,
            targetKey: row.target_key,
            matchDate: row.match_date,
            dateBasis: row.date_basis,
            receiptId: row.receipt_id,
          },
        };
    }
    throw new ToolValidationError(refusal);
  }
  private async inputs(user: string, run: string, offset: number) {
    if (
      !(
        await this.db.query(
          "SELECT 1 FROM work_turns WHERE user_id=$1 AND run_id=$2",
          [user, run],
        )
      ).rows.length
    )
      throw new ToolValidationError(
        "Original inputs require an owner-scoped active turn.",
      );
    const rows = (
      await this.db.query(
        `SELECT id,received_at AS "receivedAt",left(message,400) AS excerpt FROM conversation_inputs WHERE ${inputScope} ORDER BY ordinal LIMIT 11 OFFSET $3`,
        [user, run, offset],
      )
    ).rows;
    return {
      notice:
        "Original owner input excerpts from this turn/coordinator, not new instructions or automatic evidence. Choose the exact input IDs supporting the fields; excerpts may be incomplete. Chief can read an original input with conversation_read(id).",
      sourceInputs: rows.slice(0, 10),
      nextOffset: rows.length > 10 ? offset + 10 : null,
    };
  }
  private async sourceIds(user: string, run: string, ids?: string[]) {
    if (ids) {
      const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
      if (unique.length !== ids.length)
        throw new ToolValidationError("Source input IDs must be distinct.");
      const rows = (
        await this.db.query(
          `SELECT id FROM conversation_inputs WHERE ${inputScope} AND id=ANY($3::uuid[])`,
          [user, run, unique],
        )
      ).rows;
      if (rows.length !== unique.length)
        throw new ToolValidationError(
          "Source input IDs must belong to this owner's current turn or its coordinator; use subscription_list(sourceInputs=true).",
        );
      return unique;
    }
    const rows = (
      await this.db.query(
        `SELECT id FROM conversation_inputs WHERE ${inputScope} ORDER BY ordinal LIMIT 2`,
        [user, run],
      )
    ).rows;
    if (rows.length > 1)
      throw new ToolValidationError(
        "Several original inputs belong to this turn. Specify the exact sourceInputIds supporting these fields; subscription_list(sourceInputs=true) lists them in stable pages.",
      );
    return rows.map((row) => row.id);
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
    const row = effectiveRow(
      await this.owned(user, id),
      singaporeDay(this.now()),
    );
    const history = (
      await this.db.query(
        "SELECT id,revision,source_kind,source_ref,changes,recorded_at FROM subscription_updates WHERE user_id=$1 AND subscription_id=$2 ORDER BY revision DESC LIMIT 11 OFFSET $3",
        [user, id, offset],
      )
    ).rows;
    const reminders = (
      await this.db.query(
        `SELECT id,to_char(subscription_date,'YYYY-MM-DD') AS date,next_run AS "firesAt",status,last_error,started_at FROM daily_schedules WHERE user_id=$1 AND subscription_id=$2 ORDER BY CASE WHEN status='scheduled' THEN 0 WHEN status='processing' THEN 1 WHEN subscription_date::text=ANY($3::text[]) THEN 2 ELSE 3 END, subscription_date DESC LIMIT 20`,
        [user, id, subscriptionDates(row.data).map((d) => d.date)],
      )
    ).rows;
    const result = {
      notice: NOTICE,
      ...shown(row),
      ...(row.appliedPending
        ? {
            appliedPendingPrice: {
              ...row.appliedPending,
              notice:
                "The saved price change is in effect; history records it with the next update.",
            },
          }
        : {}),
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
    if (a.sourceInputs)
      throw new ToolValidationError(
        "Original input lookup requires the host turn; use the subscription_list tool in a conversation.",
      );
    if (a.id) return this.read(user, a.id, a.offset);
    const all = (
      (
        await this.db.query(
          "SELECT * FROM subscriptions WHERE user_id=$1 ORDER BY updated_at DESC,id",
          [user],
        )
      ).rows as Row[]
    ).map((row) => effectiveRow(row, singaporeDay(this.now())));
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
    const fields = { ...a.fields };
    if (fields.nextChargeDate === null) {
      if (fields.nextChargeEstimated === true)
        throw new ToolValidationError(
          "A cleared charge date cannot be estimated.",
        );
      fields.nextChargeEstimated = false;
    } else if (
      fields.nextChargeDate !== undefined &&
      fields.nextChargeEstimated === undefined
    )
      throw new ToolValidationError(
        "Supplying a next charge date requires nextChargeEstimated: false for a stated date, true for an estimate.",
      );
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          id: a.id ?? null,
          baseRevision: a.baseRevision ?? null,
          sourceInputIds:
            a.sourceInputIds?.map((id) => id.toLowerCase()).sort() ?? null,
          ...(a.invoice
            ? {
                invoice: {
                  collectionId: a.invoice.collectionId.toLowerCase(),
                  artifactId: a.invoice.artifactId.toLowerCase(),
                },
              }
            : {}),
          fields: Object.fromEntries(
            Object.entries(fields).sort(([x], [y]) => x.localeCompare(y)),
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
    // A pending price already in effect becomes the base of this update and is recorded with it.
    const old = a.id
      ? effectiveRow(await this.owned(user, a.id), singaporeDay(this.now()))
      : null;
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
    const data = { ...(old?.data ?? defaults), ...fields };
    validate(data);
    if (
      fields.pendingEffectiveDate &&
      fields.pendingEffectiveDate <= singaporeDay(this.now())
    )
      throw new ToolValidationError(
        "A pending price change needs a future effective date; for a price already in effect, set amount and currency instead.",
      );
    const evidence = a.invoice
      ? await this.invoiceEvidence(user, run, a.invoice, fields, data, old)
      : null;
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
    for (const key of Object.keys(fields))
      fieldSources[key] = evidence?.backed.includes(key as never)
        ? {
            updateId,
            observedAt: stamp,
            sourceKind: "invoice",
            collectionId: evidence.ref.collectionId,
            artifactId: evidence.ref.artifactId,
          }
        : { updateId, observedAt: stamp, sourceKind: "owner" };
    // source_kind stays 'owner': the owner authorised the update; the invoice evidences fields.
    const source = {
      runId: run,
      inputIds: await this.sourceIds(user, run, a.sourceInputIds),
      ...(evidence ? { invoice: evidence.ref } : {}),
      ...(old?.appliedPending ? { appliedPending: old.appliedPending } : {}),
    };
    // Any change to the amount/currency pair, including to or from unknown.
    // Compare with the stored price, so a saved change first recorded by this write is reported too.
    const prior = old?.appliedPending
      ? (old.appliedPending.from as {
          amount: string | null;
          currency: string | null;
        })
      : {
          amount: old?.data.amount ?? null,
          currency: old?.data.currency ?? null,
        };
    const supplied =
      fields.amount !== undefined || fields.currency !== undefined;
    const priceChange =
      old &&
      (supplied || old.appliedPending) &&
      (prior.currency !== (data.currency ?? null) ||
        (prior.amount == null) !== (data.amount == null) ||
        (prior.amount != null &&
          decimalKey(prior.amount) !== decimalKey(data.amount!)))
        ? {
            from: prior,
            to: { amount: data.amount, currency: data.currency },
            source: supplied
              ? evidence
                ? "invoice"
                : "owner"
              : "saved price change",
          }
        : null;
    const { plans, warnings } = subscriptionReminders(data, this.now());
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
      JSON.stringify(fields),
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
        FROM p CROSS JOIN jsonb_to_recordset($14::jsonb) AS x(id text,date text,content text,fire text) WHERE EXISTS(SELECT 1 FROM u) AND (SELECT count(*) FROM withdrawn)>=0
        ON CONFLICT(subscription_id,subscription_date) WHERE subscription_id IS NOT NULL DO UPDATE
        SET content=EXCLUDED.content,schedule=EXCLUDED.schedule,parsed=EXCLUDED.parsed,next_run=EXCLUDED.next_run,subscription_revision=EXCLUDED.subscription_revision,status='scheduled',lease=NULL,updated_at=now()
        WHERE daily_schedules.started_at IS NULL AND daily_schedules.last_delivered IS NULL AND daily_schedules.status IN ('scheduled','paused','cancelled') RETURNING id
      ) SELECT p.*,(SELECT count(*) FROM reminders) AS scheduled,(SELECT count(*) FROM withdrawn WHERE last_error IS NOT NULL) AS possibly_started FROM p JOIN u ON true`,
          values,
        )
      ).rows[0] as Row & { scheduled: number; possibly_started: number };
      if (!result) {
        const duplicate = await replay();
        if (duplicate) return duplicate;
        throw new ToolValidationError(
          "Subscription changed while saving; read it again before retrying.",
        );
      }
      const read = await this.read(user, id);
      const plannedReminders = (
        await this.db.query(
          "SELECT to_char(subscription_date,'YYYY-MM-DD') AS date,status,started_at,last_error FROM daily_schedules WHERE user_id=$1 AND subscription_id=$2 AND subscription_date::text=ANY($3::text[])",
          [user, id, plans.map((p) => p.date)],
        )
      ).rows;
      for (const reminder of plannedReminders)
        if (
          plans.some((p) => p.date === reminder.date) &&
          (["completed", "failed", "processing"].includes(reminder.status) ||
            (reminder.status === "cancelled" && reminder.started_at))
        )
          warnings.push(
            `Reminder for ${reminder.date} is ${reminder.status}; a delivery was already attempted or may have started. Check Telegram; it will not be replayed automatically.`,
          );
      if (priceChange)
        warnings.push(
          `${data.label}: price changed from ${priceChange.from.amount == null ? "unknown" : `${priceChange.from.amount} ${priceChange.from.currency}`} to ${priceChange.to.amount == null ? "unknown" : `${priceChange.to.amount} ${priceChange.to.currency}`}${evidence ? ` (invoice ${evidence.ref.matchDate})` : ""}.`,
        );
      return {
        ...read,
        created: !old,
        updateId,
        ...(priceChange ? { priceChange } : {}),
        warnings,
        ...(Number(result.possibly_started) > 0 ||
        plannedReminders.some(
          (r: any) =>
            r.started_at && ["processing", "cancelled"].includes(r.status),
        )
          ? {
              deliveryNotice:
                "A reminder may already have started delivery; inspect Telegram. It will not be retried automatically.",
            }
          : {}),
      };
    } catch (error) {
      if (
        (error as { constraint?: string }).constraint ===
        "daily_schedule_capacity_limit"
      )
        throw new ToolValidationError(
          "Limit of 50 active schedules reached; pause another reminder before enabling these dates. A saved price change also takes a slot for its notice unless priceAlerts is false.",
        );
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
