import { createHash, randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { Action } from "./protocol.js";
import {
  subscriptionFields,
  type SubscriptionFields,
} from "./subscription-schema.js";
import { ToolValidationError } from "./tool-errors.js";
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
const words = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const leads = (a: string[], b: string[]) =>
  a.length > 0 && a.length <= b.length && a.every((w, i) => w === b[i]);
/** One issuer: known vendor groups, or one name leading the other ("YouTube" / "YouTube Premium"). A shared later word ("Premium", "Max") is not enough. */
function sameIssuer(owner: string, issuer: string) {
  if (issuerIdentity(owner) === issuerIdentity(issuer)) return true;
  const a = words(owner),
    b = words(issuer);
  return leads(a, b) || leads(b, a);
}
const planFamily: Record<string, string> = {
  anthropic: "Claude",
  openai: "ChatGPT",
};
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
        `${matchedInvoices} AND ($2::uuid IS NULL OR g.collection_id=$2) ORDER BY g.match_date DESC,g.collection_id,g.target_key,g.artifact_id LIMIT 2000`,
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
        amounts: row.facts.amounts.slice(0, 12),
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
      const target = row.scope.targets.find((t) => t.key === row.target_key);
      const facts = row.facts;
      // The issuer must match the item's merchant (or its label without one); a plan never decides the issuer.
      const owner = data.merchant ?? data.label!;
      const issuers = [target?.label ?? "", ...facts.issuerLabels].filter(
        Boolean,
      );
      const family = planFamily[issuerIdentity(owner)];
      const plans = [
        data.plan,
        data.label,
        data.plan && `${data.label} ${data.plan}`,
        data.plan && data.merchant && `${data.merchant} ${data.plan}`,
        data.plan && family && `${family} ${data.plan}`,
      ];
      const recorded =
        row.date_basis === "invoice_date" && row.match_date.length === 10
          ? row.match_date
          : facts.invoiceDates.length === 1
            ? facts.invoiceDates[0]!
            : null;
      const invoiceDate = fields.lastInvoiceDate ?? recorded;
      if (!issuers.some((n) => sameIssuer(owner, n)))
        refusal =
          "This invoice's recorded issuer does not match this item's merchant (or label).";
      else if (plans.some((n) => n && productEvidence(facts, n) === "conflict"))
        refusal =
          "This invoice explicitly identifies a different plan or product from this item.";
      else if (
        target?.accountLabel &&
        data.accountLabel &&
        subscriptionKey(target.accountLabel) !==
          subscriptionKey(data.accountLabel)
      )
        refusal =
          "This invoice was gathered for a different account label than this item.";
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
      else if (
        fields.lastInvoiceDate &&
        !(
          (row.date_basis === "invoice_date" &&
            row.match_date === fields.lastInvoiceDate) ||
          facts.invoiceDates.includes(fields.lastInvoiceDate)
        )
      )
        refusal =
          "lastInvoiceDate must be the invoice date recorded for this file.";
      else if (
        old?.data.lastInvoiceDate &&
        (!invoiceDate || invoiceDate < old.data.lastInvoiceDate)
      )
        refusal = invoiceDate
          ? `This invoice (${invoiceDate}) is older than the saved last invoice (${old.data.lastInvoiceDate}); an older invoice cannot replace newer invoice fields.`
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
    const row = await this.owned(user, id);
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
    const data = { ...(old?.data ?? defaults), ...fields };
    validate(data);
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
    };
    const priceChange =
      old &&
      fields.amount != null &&
      old.data.amount != null &&
      (old.data.currency !== data.currency ||
        decimalKey(old.data.amount) !== decimalKey(data.amount!))
        ? {
            from: { amount: old.data.amount, currency: old.data.currency },
            to: { amount: data.amount, currency: data.currency },
            source: evidence ? "invoice" : "owner",
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
          `${data.label}: price changed from ${priceChange.from.amount} ${priceChange.from.currency} to ${priceChange.to.amount} ${priceChange.to.currency}${evidence ? ` (invoice ${evidence.ref.matchDate})` : ""}.`,
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
          "Limit of 50 active schedules reached; pause another reminder before enabling these dates.",
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
