import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { Destination } from "./delivery-routing.js";
import { marketCalendar, sessionsFor } from "./market-calendar.js";
import type { CreditBucket } from "./market-credits.js";
import type { MarketHistory } from "./market-history.js";
import { currentHoldings } from "./portfolio.js";
import type { PriceBar, Quote } from "./stock-provider.js";
import { DEFAULT_WINDOW_COLUMNS, zoned } from "./stocks.js";
import { ToolValidationError } from "./tool-errors.js";
import { errorFields, opsLog } from "./ops-log.js";
import {
  describeWindow,
  effectiveWindow,
  inWindow,
  windowOccurrence,
} from "./watch-window.js";

/**
 * Owner-defined stock rules (docs/stock-rules.md, Phase 2b). The stocks agent turns the
 * owner's words into a structured rule; the host evaluates it on the watchlist tick with
 * no model calls, using the same split-adjusted provider history as `stock_lookup`.
 * Rules alert on crossing (re-armed after a 1% recovery) or once a day while true, at most
 * once per rule, stock and trading day. Alerts state facts, never advice.
 */

export const REFERENCES = [
  "prev_close",
  "avg_cost",
  "avg_12w",
  "avg_26w",
  "avg_52w",
  "low_12w",
  "low_26w",
  "low_52w",
  "high_12w",
  "high_26w",
  "high_52w",
  "all_time_low",
  "all_time_high",
] as const;
export type Reference = (typeof REFERENCES)[number];

export const LABELS: Record<Reference, string> = {
  prev_close: "previous close",
  avg_cost: "IBKR average cost",
  avg_12w: "12-week average",
  avg_26w: "26-week average",
  avg_52w: "52-week average",
  low_12w: "12-week low",
  low_26w: "26-week low",
  low_52w: "52-week low",
  high_12w: "12-week high",
  high_26w: "26-week high",
  high_52w: "52-week high",
  all_time_low: "all-time low",
  all_time_high: "all-time high",
};

const SESSIONS = { "12w": 60, "26w": 130, "52w": 260 } as const;
const MIN_COVERAGE = 0.9;
const STALE_DAYS = 7;
const REARM = 0.01;
const MAX_RULES = 50;
/** A close-based alert held for the window is dropped once this old. */
const HOLD_MAX_MS = 4 * 24 * 60 * 60 * 1000;
/** The closing check runs between 5 minutes and 3 hours after the regular close. */
const CLOSING_FROM_MIN = 5;
const CLOSING_UNTIL_MIN = 180;
/** Closing checks per stock and day before giving up on a final quote. */
const CLOSE_ATTEMPTS = 6;

type Value = { value: number; asOf: string; source: string };
type Missing = { value: null; reason: string };
export type ReferenceValue = Value | Missing;

const historyRefs = new Set<Reference>(
  REFERENCES.filter((r) => r !== "prev_close" && r !== "avg_cost"),
);

/**
 * Reference levels for rules. Unlike the "ask now" statistics, these exclude today's bar
 * and price, so "a new 52-week low" means below the lowest level before today.
 */
export function ruleReferences(
  quote: Quote,
  daily: PriceBar[] | null,
  monthly: PriceBar[] | null,
): Partial<Record<Reference, ReferenceValue>> {
  const today = quote.tradingDate;
  const out: Partial<Record<Reference, ReferenceValue>> = {};
  out.prev_close =
    Number.isFinite(quote.prevClose) && quote.prevClose > 0
      ? { value: quote.prevClose, asOf: today, source: "quote" }
      : { value: null, reason: "previous close missing" };
  const prior = (daily ?? []).filter((b) => b.date < today);
  const last = prior.at(-1)?.date;
  const stale =
    !last || (Date.parse(today) - Date.parse(last)) / 86400000 > STALE_DAYS;
  for (const [key, sessions] of Object.entries(SESSIONS) as [
    keyof typeof SESSIONS,
    number,
  ][]) {
    const bars = prior.slice(-sessions);
    const reason = !daily
      ? "daily history unavailable"
      : stale
        ? `daily history ends ${last ?? "never"}`
        : bars.length < sessions * MIN_COVERAGE
          ? `only ${bars.length} of ${sessions} sessions`
          : null;
    if (reason) {
      for (const r of ["avg_", "low_", "high_"])
        out[`${r}${key}` as Reference] = { value: null, reason };
      continue;
    }
    out[`avg_${key}` as Reference] = {
      value: bars.reduce((t, b) => t + b.close, 0) / bars.length,
      asOf: last!,
      source: `${bars.length} sessions to ${last}`,
    };
    const low = bars.reduce((m, b) => (b.low < m.low ? b : m));
    const high = bars.reduce((m, b) => (b.high > m.high ? b : m));
    out[`low_${key}` as Reference] = {
      value: low.low,
      asOf: low.date,
      source: `${bars.length} sessions to ${last}`,
    };
    out[`high_${key}` as Reference] = {
      value: high.high,
      asOf: high.date,
      source: `${bars.length} sessions to ${last}`,
    };
  }
  // All-time: whole earlier months from monthly bars, plus every prior daily bar; the
  // current month's bar may contain today, so it is never used.
  const monthStart = today.slice(0, 7) + "-01";
  const earlier = (monthly ?? []).filter((b) => b.date < monthStart);
  if (!monthly || !earlier.length || stale) {
    const reason = !monthly
      ? "monthly history unavailable"
      : stale
        ? `daily history ends ${last ?? "never"}`
        : "no earlier monthly history";
    out.all_time_low = { value: null, reason };
    out.all_time_high = { value: null, reason };
  } else {
    const bars = [...prior, ...earlier];
    const low = bars.reduce((m, b) => (b.low < m.low ? b : m));
    const high = bars.reduce((m, b) => (b.high > m.high ? b : m));
    const since = `since ${monthly[0]!.date.slice(0, 7)}`;
    out.all_time_low = { value: low.low, asOf: low.date, source: since };
    out.all_time_high = { value: high.high, asOf: high.date, source: since };
  }
  return out;
}

export function triggerLevel(
  direction: "below" | "above",
  reference: number,
  marginPct: number,
) {
  return direction === "below"
    ? reference * (1 - marginPct / 100)
    : reference * (1 + marginPct / 100);
}
export function met(
  direction: "below" | "above",
  price: number,
  trigger: number,
) {
  return direction === "below" ? price < trigger : price > trigger;
}
export function recovered(
  direction: "below" | "above",
  price: number,
  trigger: number,
) {
  return direction === "below"
    ? price >= trigger * (1 + REARM)
    : price <= trigger * (1 - REARM);
}

export function describeRule(rule: {
  direction: string;
  reference: string;
  margin_pct: number | string;
  basis: string;
  notify: string;
}) {
  const margin = Number(rule.margin_pct);
  const ref =
    rule.reference === "avg_cost"
      ? "your IBKR average cost"
      : (LABELS[rule.reference as Reference] ?? rule.reference);
  return `${rule.basis === "close" ? "closes" : "trades"} ${margin ? `${margin}% ` : ""}${rule.direction} ${ref}${rule.notify === "daily" ? ", reminded daily while true" : ", alert on crossing"}`;
}

const fmt = (n: number) =>
  n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(2) : n.toPrecision(3);

export interface Closing {
  date: string;
  closeMinutes: number;
  timezone: string;
}

/**
 * A quote is the session's close only if it is dated that session and stamped at or after
 * the regular close (minus a minute): a delayed feed can still return a mid-afternoon
 * quote after 16:00, which must not stand in for the close.
 */
export function acceptsClose(item: any, q: Quote, closing: Closing) {
  if (q.marketOpen || q.tradingDate !== closing.date) return false;
  if (!(Number.isFinite(q.price) && q.price > 0)) return false;
  if (q.currency && item.currency && q.currency !== item.currency) return false;
  const at = zoned(q.quoteTime, closing.timezone);
  return at.date === closing.date && at.minutes >= closing.closeMinutes - 1;
}

/** Evaluates rules for a watched stock after the monitor validated its quote. */
export class RuleEngine {
  /** Evaluations waiting for history credits, re-run by warm() with the same quote. */
  private pending = new Map<
    string,
    { item: any; quote: Quote; basis: "intraday" | "close"; at: number }
  >();
  private rules = new Map<string, any[]>();
  private holdings = new Map<
    string,
    Awaited<ReturnType<typeof currentHoldings>>
  >();
  constructor(
    private db: Database,
    private providerName: string,
    private credits: CreditBucket,
    private history: MarketHistory,
    private captureDestination: (
      user: string,
    ) => Promise<Destination> = async () => ({
      kind: "topic",
      topic: "markets",
    }),
  ) {}

  /** Loads active rules once per monitor tick. */
  async beginTick(now: Date) {
    this.rules.clear();
    this.holdings.clear();
    for (const r of (
      await this.db.query("SELECT * FROM watch_rules WHERE status='active'")
    ).rows)
      this.rules.set(r.user_id, [...(this.rules.get(r.user_id) ?? []), r]);
    void now;
  }

  private async holdingsOf(user: string, now: Date) {
    if (!this.holdings.has(user))
      this.holdings.set(user, await currentHoldings(this.db, user, now));
    return this.holdings.get(user)!;
  }

  private async applicable(item: any, basis: "intraday" | "close", now: Date) {
    const out: any[] = [];
    for (const rule of this.rules.get(item.user_id) ?? []) {
      if (rule.basis !== basis) continue;
      if (rule.scope === "item" && rule.item_id !== item.id) continue;
      if (rule.scope === "holdings") {
        const h = await this.holdingsOf(item.user_id, now);
        if (
          !("positions" in h) ||
          !h.positions.some(
            (p) =>
              p.symbol === String(item.symbol).toUpperCase() &&
              p.currency === item.currency,
          )
        )
          continue;
      }
      out.push(rule);
    }
    return out;
  }

  private closeAttempts = new Map<string, number>();
  /**
   * A closing check whose quote is not yet the session's final one. Each attempt is
   * visible in stock_rule_list; after a bounded number (about an hour at the 10-minute
   * spacing) the day is marked done, so a stock with no final-minute trade cannot spend
   * credits for the whole closing window.
   */
  async closeNotFinal(item: any, closing: Closing, now: Date) {
    const key = `${item.id}:${closing.date}`;
    const attempts = (this.closeAttempts.get(key) ?? 0) + 1;
    this.closeAttempts.set(key, attempts);
    if (this.closeAttempts.size > 500) this.closeAttempts.clear();
    const giveUp = attempts >= CLOSE_ATTEMPTS;
    for (const rule of await this.applicable(item, "close", now))
      await this.record(rule, item, now, {
        outcome: giveUp
          ? "close not confirmed: no final quote"
          : `waiting for the final close quote (attempt ${attempts})`,
        ...(giveUp ? { closingDate: closing.date } : {}),
      }).catch((error) =>
        opsLog("stock.rules_failed", "warn", errorFields(error)),
      );
  }

  /** Cheap pre-filter: whether the owner has any active close-based rule. */
  hasCloseRules(user: string) {
    return (this.rules.get(user) ?? []).some((r) => r.basis === "close");
  }

  /** Whether a closing check is due for this stock now, with the session's close time. */
  async closingDue(item: any, now: Date): Promise<Closing | null> {
    const rules = await this.applicable(item, "close", now);
    if (!rules.length) return null;
    const tz = marketCalendar(item.mic_code)?.timezone;
    if (!tz) return null;
    const local = zoned(now, tz);
    const regular = sessionsFor(item.mic_code, local.date).sessions.find(
      (s) => s.type === "regular",
    );
    if (!regular) return null;
    const [h, m] = regular.close.split(":").map(Number);
    const closeMinutes = h! * 60 + m!;
    const since = local.minutes - closeMinutes;
    if (since < CLOSING_FROM_MIN || since > CLOSING_UNTIL_MIN) return null;
    const done = (
      await this.db.query(
        "SELECT rule_id FROM watch_rule_states WHERE item_id=$1 AND last_closing_date=$2 AND rule_id=ANY($3::uuid[])",
        [item.id, local.date, rules.map((r) => r.id)],
      )
    ).rows.length;
    return done < rules.length
      ? { date: local.date, closeMinutes, timezone: tz }
      : null;
  }

  /**
   * Spend leftover credits this minute loading history for evaluations that were waiting,
   * then re-run them with their validated quote (intraday only while it is fresh).
   */
  async warm(now: Date) {
    for (const [key, p] of this.pending) {
      if (now.getTime() - p.at > 30 * 60 * 1000) {
        this.pending.delete(key);
        continue;
      }
      const ref = { symbol: p.item.symbol, mic: p.item.mic_code };
      const missing = this.history.missing(ref, p.quote.tradingDate);
      if (missing && !this.credits.tryTake(missing, now, 0)) return;
      this.pending.delete(key);
      await this.history.load(ref, p.quote.tradingDate);
      // A late intraday re-check only counts inside the owner's monitoring window: an
      // alert muted for the window would otherwise use up the crossing.
      const fresh =
        p.basis === "close" ||
        (now.getTime() - p.quote.quoteTime.getTime() <= 20 * 60 * 1000 &&
          inWindow(effectiveWindow(p.item), now));
      if (fresh) await this.evaluate(p.item, p.quote, now, p.basis);
    }
  }

  /**
   * Evaluate `basis` rules for one stock. `quote` is validated by the monitor; for
   * "close" it is the session's final quote for `quote.tradingDate`.
   */
  async evaluate(
    item: any,
    quote: Quote,
    now: Date,
    basis: "intraday" | "close",
  ) {
    const rules = await this.applicable(item, basis, now);
    if (!rules.length) return;
    const ref = { symbol: item.symbol, mic: item.mic_code };
    const day = quote.tradingDate;
    let refs: Partial<Record<Reference, ReferenceValue>> = ruleReferences(
      quote,
      null,
      null,
    );
    if (rules.some((r) => historyRefs.has(r.reference))) {
      const missing = this.history.missing(ref, day);
      // Monitoring may use the daily reserve, but never this minute's exhausted allowance.
      if (missing && !this.credits.tryTake(missing, now, 0)) {
        // Load later from leftover credits (warm), then evaluate with this same quote.
        this.pending.set(`${item.id}:${basis}`, {
          item,
          quote,
          basis,
          at: now.getTime(),
        });
        for (const r of rules.filter((r) => historyRefs.has(r.reference)))
          await this.record(r, item, now, {
            outcome: "references pending: market-data credits",
          });
        rules.splice(
          0,
          rules.length,
          ...rules.filter((r) => !historyRefs.has(r.reference)),
        );
      } else {
        const { daily, monthly } = await this.history.load(ref, day);
        refs = ruleReferences(quote, daily, monthly);
      }
    }
    for (const rule of rules) {
      let reference: ReferenceValue | undefined =
        refs[rule.reference as Reference];
      if (rule.reference === "avg_cost") {
        const h = await this.holdingsOf(item.user_id, now);
        const held =
          "positions" in h
            ? h.positions.find(
                (p) =>
                  p.symbol === String(item.symbol).toUpperCase() &&
                  p.currency === item.currency,
              )
            : undefined;
        reference = !("positions" in h)
          ? { value: null, reason: `cost unknown: ${h.unavailable}` }
          : !held
            ? { value: null, reason: "not held" }
            : held.averageCost == null || !(held.averageCost > 0)
              ? { value: null, reason: "cost unknown" }
              : {
                  value: held.averageCost,
                  asOf: h.asOf.toISOString(),
                  source: "IBKR holdings",
                };
      }
      // One failing rule (for example deleted mid-evaluation) never blocks the others.
      await this.apply(rule, item, quote, now, basis, reference).catch(
        (error) => opsLog("stock.rules_failed", "warn", errorFields(error)),
      );
    }
  }

  private async record(
    rule: any,
    item: any,
    now: Date,
    fields: {
      outcome: string;
      price?: number;
      reference?: number;
      trigger?: number;
      armed?: boolean;
      triggered?: boolean;
      closingDate?: string;
    },
  ) {
    await this.db.query(
      `INSERT INTO watch_rule_states(rule_id,item_id,user_id,armed,last_evaluated_at,last_price,last_reference,last_trigger,last_outcome,last_triggered_at,last_closing_date)
       VALUES($1,$2,$3,COALESCE($4::boolean,true),$5::timestamptz,$6::numeric,$7::numeric,$8::numeric,$9::text,
         CASE WHEN $10::boolean THEN $5::timestamptz END,$11::date)
       ON CONFLICT(rule_id,item_id) DO UPDATE SET
         armed=COALESCE($4::boolean,watch_rule_states.armed),last_evaluated_at=$5::timestamptz,
         last_price=$6::numeric,last_reference=$7::numeric,last_trigger=$8::numeric,last_outcome=$9::text,
         last_triggered_at=CASE WHEN $10::boolean THEN $5::timestamptz ELSE watch_rule_states.last_triggered_at END,
         last_closing_date=COALESCE($11::date,watch_rule_states.last_closing_date)`,
      [
        rule.id,
        item.id,
        item.user_id,
        fields.armed ?? null,
        now,
        fields.price ?? null,
        fields.reference ?? null,
        fields.trigger ?? null,
        fields.outcome.slice(0, 120),
        fields.triggered ?? false,
        fields.closingDate ?? null,
      ],
    );
  }

  private async apply(
    rule: any,
    item: any,
    quote: Quote,
    now: Date,
    basis: "intraday" | "close",
    reference: ReferenceValue | undefined,
  ) {
    const closingDate = basis === "close" ? quote.tradingDate : undefined;
    if (!reference || reference.value == null) {
      await this.record(rule, item, now, {
        outcome: `reference unavailable: ${reference?.reason ?? "unknown"}`,
        price: quote.price,
        closingDate,
      });
      return;
    }
    const price = quote.price;
    const trigger = triggerLevel(
      rule.direction,
      reference.value,
      Number(rule.margin_pct),
    );
    const state = (
      await this.db.query(
        "SELECT armed FROM watch_rule_states WHERE rule_id=$1 AND item_id=$2",
        [rule.id, item.id],
      )
    ).rows[0];
    const armed = state ? state.armed : true;
    const base = { price, reference: reference.value, trigger, closingDate };
    if (!met(rule.direction, price, trigger)) {
      await this.record(rule, item, now, {
        ...base,
        outcome: "not met",
        armed: armed || recovered(rule.direction, price, trigger),
      });
      return;
    }
    if (rule.notify === "cross" && !armed) {
      await this.record(rule, item, now, {
        ...base,
        outcome: "met; waiting to re-arm",
      });
      return;
    }
    // The owner may have paused the rule, the stock or all alerts while this ran.
    const still = (
      await this.db.query(
        `SELECT r.status AS rule_status,i.status AS item_status,COALESCE(s.paused,false) AS paused
         FROM watch_rules r JOIN watchlist_items i ON i.id=$2 AND i.user_id=r.user_id
         LEFT JOIN stock_settings s ON s.user_id=r.user_id WHERE r.id=$1`,
        [rule.id, item.id],
      )
    ).rows[0];
    if (!still) return;
    if (
      still.rule_status !== "active" ||
      still.item_status !== "active" ||
      still.paused
    ) {
      await this.record(rule, item, now, { ...base, outcome: "met; paused" });
      return;
    }
    const alertId = randomUUID();
    const reply =
      `${item.name} (${item.symbol}, ${item.exchange}) ${basis === "close" ? "closed" : "is"} ${Number(rule.margin_pct) ? `${Number(rule.margin_pct)}% ` : ""}${rule.direction} ${rule.reference === "avg_cost" ? "your IBKR average cost" : `its ${LABELS[rule.reference as Reference]}`}.\n` +
      `Price ${fmt(price)} ${quote.currency || item.currency} vs ${LABELS[rule.reference as Reference]} ${fmt(reference.value)} (${reference.source}, ${reference.asOf.slice(0, 10)}); trigger ${fmt(trigger)}.\n` +
      `Rule: “${rule.label}”. ${basis === "close" ? `Close of ${quote.tradingDate}` : `Quote ${zoned(quote.quoteTime, item.exchange_timezone).time} ${item.exchange_timezone}${quote.delayed ? " (delayed)" : ""}`} · ${this.providerName}.\n` +
      `A condition you set has been met; this is not advice.`;
    const inserted = (
      await this.db.query(
        `INSERT INTO watch_rule_alerts(id,user_id,rule_id,item_id,trading_date,hold_for_window,payload)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(rule_id,item_id,trading_date) DO NOTHING RETURNING id`,
        [
          alertId,
          item.user_id,
          rule.id,
          item.id,
          quote.tradingDate,
          basis === "close",
          JSON.stringify({
            destination: await this.captureDestination(item.user_id),
            ruleId: rule.id,
            itemId: item.id,
            symbol: item.symbol,
            reply,
          }),
        ],
      )
    ).rows.length;
    await this.record(rule, item, now, {
      ...base,
      outcome: inserted ? "met; alert queued" : "met; already alerted today",
      armed: rule.notify === "cross" ? false : true,
      triggered: inserted > 0,
    });
  }
}

/** Outbox delivery for rule alerts: same uncertain-send contract as daily-drop alerts. */
export class RuleDelivery {
  private busy = false;
  constructor(
    private db: Database,
    private send: (user: string, payload: any) => Promise<unknown>,
    private clock = () => new Date(),
  ) {}
  async recover() {
    await this.db.query(
      "UPDATE watch_rule_alerts SET state='uncertain' WHERE state='sending'",
    );
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.clock();
      // Pauses landing after an alert was queued mute it.
      await this.db.query(
        `UPDATE watch_rule_alerts a SET state='muted' FROM watch_rules r, watchlist_items i
         WHERE a.rule_id=r.id AND a.item_id=i.id AND a.state='pending'
           AND (r.status<>'active' OR i.status<>'active'
             OR EXISTS(SELECT 1 FROM stock_settings s WHERE s.user_id=a.user_id AND s.paused))`,
      );
      const candidates = (
        await this.db.query(
          `SELECT a.*,i.window_start,i.window_end,i.window_days,${DEFAULT_WINDOW_COLUMNS}
           FROM watch_rule_alerts a JOIN watchlist_items i ON i.id=a.item_id
           LEFT JOIN stock_settings s ON s.user_id=a.user_id
           WHERE a.state='pending' ORDER BY a.created_at LIMIT 500`,
        )
      ).rows;
      for (const d of candidates) {
        const window = effectiveWindow(d);
        const open = inWindow(window, now);
        const age = now.getTime() - new Date(d.created_at).getTime();
        if (d.hold_for_window) {
          if (age > HOLD_MAX_MS) {
            await this.mute(d, now, "held alert expired", window);
            continue;
          }
          if (!open) continue; // held for the next window
        } else {
          const opened = windowOccurrence(window, now)?.[0];
          if (
            !open ||
            (opened !== undefined && new Date(d.created_at).getTime() < opened)
          ) {
            await this.mute(d, now, "outside window", window);
            continue;
          }
        }
        const claimed = (
          await this.db.query(
            `UPDATE watch_rule_alerts a SET state='sending' WHERE a.id=$1 AND a.state='pending'
               AND EXISTS(SELECT 1 FROM watch_rules r JOIN watchlist_items i ON i.id=a.item_id
                          WHERE r.id=a.rule_id AND r.status='active' AND i.status='active')
               AND NOT EXISTS(SELECT 1 FROM stock_settings s WHERE s.user_id=a.user_id AND s.paused)
             RETURNING a.id`,
            [d.id],
          )
        ).rows.length;
        if (!claimed) continue;
        try {
          await this.send(d.user_id, { ...d.payload, alertId: d.id });
          await this.db.query(
            "UPDATE watch_rule_alerts SET state='sent',sent_at=now() WHERE id=$1",
            [d.id],
          );
        } catch {
          await this.db.query(
            "UPDATE watch_rule_alerts SET state='uncertain' WHERE id=$1",
            [d.id],
          );
        }
        return; // one send per tick, like daily-drop delivery
      }
    } finally {
      this.busy = false;
    }
  }
  private async mute(d: any, now: Date, reason: string, window: any) {
    await this.db.query(
      "UPDATE watch_rule_alerts SET state='muted',payload=payload||jsonb_build_object('mutedReason',$2::text,'window',$3::text) WHERE id=$1 AND state='pending'",
      [d.id, reason, describeWindow(window) ?? "none"],
    );
    void now;
  }
}

type RuleAction =
  | {
      operation: "stock_rule_add";
      scope: "item" | "holdings" | "watchlist";
      itemId?: string;
      direction: "below" | "above";
      reference: Reference;
      marginPct?: number;
      basis: "intraday" | "close";
      notify?: "cross" | "daily";
      label: string;
    }
  | { operation: "stock_rule_list" }
  | {
      operation: "stock_rule_update";
      id: string;
      status?: "active" | "paused";
      marginPct?: number;
      notify?: "cross" | "daily";
      label?: string;
    }
  | { operation: "stock_rule_remove"; id: string };

/** The stocks agent's rule tools. Changes require a foreground owner turn. */
export class RuleTools {
  constructor(
    private db: Database,
    private clock = () => new Date(),
  ) {}
  private async requireForeground(user: string, run: string) {
    const turn = (
      await this.db.query(
        "SELECT background FROM work_turns WHERE run_id=$1 AND user_id=$2",
        [run, user],
      )
    ).rows[0];
    if (!turn || turn.background)
      throw new ToolValidationError(
        "Only a foreground owner request may change stock rules",
      );
  }
  async call(user: string, run: string, a: RuleAction) {
    if (a.operation === "stock_rule_list") return this.list(user);
    await this.requireForeground(user, run);
    if (a.operation === "stock_rule_add") return this.add(user, a);
    if (a.operation === "stock_rule_update") return this.update(user, a);
    return this.remove(user, a.id);
  }

  private async add(
    user: string,
    a: Extract<RuleAction, { operation: "stock_rule_add" }>,
  ) {
    if ((a.scope === "item") !== !!a.itemId)
      throw new ToolValidationError(
        "Give itemId (from watchlist_list) only for scope item; holdings and watchlist cover several stocks",
      );
    if (a.scope === "item") {
      const item = (
        await this.db.query(
          "SELECT id FROM watchlist_items WHERE id=$1 AND user_id=$2",
          [a.itemId, user],
        )
      ).rows[0];
      if (!item)
        throw new ToolValidationError(
          "That stock is not on the watchlist; add it with watchlist_add first, then use its id",
        );
    }
    if (a.reference === "avg_cost" && a.scope === "watchlist")
      throw new ToolValidationError(
        "Average cost only exists for holdings; use scope holdings or a held stock",
      );
    const margin = a.marginPct ?? 0;
    const count = (
      await this.db.query(
        "SELECT count(*)::int AS n FROM watch_rules WHERE user_id=$1",
        [user],
      )
    ).rows[0].n;
    if (count >= MAX_RULES)
      throw new ToolValidationError(
        `Maximum ${MAX_RULES} rules; remove one first`,
      );
    const duplicate = (
      await this.db.query(
        `SELECT id FROM watch_rules WHERE user_id=$1 AND scope=$2 AND item_id IS NOT DISTINCT FROM $3
           AND direction=$4 AND reference=$5 AND margin_pct=$6 AND basis=$7`,
        [
          user,
          a.scope,
          a.itemId ?? null,
          a.direction,
          a.reference,
          margin,
          a.basis,
        ],
      )
    ).rows[0];
    if (duplicate)
      throw new ToolValidationError(
        `An identical rule already exists (${duplicate.id}); update it instead`,
      );
    const id = randomUUID();
    const rule = (
      await this.db.query(
        `INSERT INTO watch_rules(id,user_id,scope,item_id,direction,reference,margin_pct,basis,notify,label)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          id,
          user,
          a.scope,
          a.itemId ?? null,
          a.direction,
          a.reference,
          margin,
          a.basis,
          a.notify ?? "cross",
          a.label.trim(),
        ],
      )
    ).rows[0];
    const coverage =
      a.scope === "holdings" ? await this.coverage(user) : undefined;
    return {
      rule: this.view(rule),
      meaning: describeRule(rule),
      coverage,
      checks:
        a.basis === "close"
          ? "Checked once after each regular US session closes; an alert outside your monitoring hours is held for the next window."
          : "Checked on each watchlist poll during the regular session and your monitoring hours.",
      note: "An alert fires when the condition is first met (a rule already true alerts on its first check), then re-arms after a 1% recovery; at most one alert per rule, stock and day. Facts, not advice.",
    };
  }

  /** Holdings on the watchlist (monitored) and holdings that are not. */
  private async coverage(user: string) {
    const h = await currentHoldings(this.db, user, this.clock());
    if (!("positions" in h))
      return {
        holdingsUnavailable: h.unavailable,
        note: "Holdings are unavailable; the rule applies to held stocks once IBKR holdings are fresh.",
      };
    const watched = (
      await this.db.query(
        "SELECT symbol,currency,status FROM watchlist_items WHERE user_id=$1",
        [user],
      )
    ).rows;
    const isWatched = (p: { symbol: string; currency: string }) =>
      watched.some(
        (w) =>
          String(w.symbol).toUpperCase() === p.symbol &&
          w.currency === p.currency,
      );
    return {
      monitored: h.positions.filter(isWatched).map((p) => p.symbol),
      notWatched: h.positions.filter((p) => !isWatched(p)).map((p) => p.symbol),
      note: "Only holdings on the watchlist are checked. Offer to add the others with watchlist_add (confirm each exchange); nothing is added automatically.",
    };
  }

  private view(r: any) {
    return {
      id: r.id,
      scope: r.scope,
      itemId: r.item_id,
      direction: r.direction,
      reference: r.reference,
      marginPct: Number(r.margin_pct),
      basis: r.basis,
      notify: r.notify,
      status: r.status,
      label: r.label,
    };
  }

  private async list(user: string) {
    const rules = (
      await this.db.query(
        "SELECT * FROM watch_rules WHERE user_id=$1 ORDER BY created_at",
        [user],
      )
    ).rows;
    const states = (
      await this.db.query(
        `SELECT s.*,i.symbol FROM watch_rule_states s JOIN watchlist_items i ON i.id=s.item_id
         WHERE s.user_id=$1`,
        [user],
      )
    ).rows;
    return {
      rules: rules.map((r) => ({
        ...this.view(r),
        meaning: describeRule(r),
        stocks: states
          .filter((s) => s.rule_id === r.id)
          .map((s) => ({
            symbol: s.symbol,
            lastChecked: s.last_evaluated_at,
            price: s.last_price == null ? null : Number(s.last_price),
            reference:
              s.last_reference == null ? null : Number(s.last_reference),
            trigger: s.last_trigger == null ? null : Number(s.last_trigger),
            outcome: s.last_outcome,
            armed: s.armed,
            lastAlertedAt: s.last_triggered_at,
          })),
      })),
      limit: MAX_RULES,
    };
  }

  private async update(
    user: string,
    a: Extract<RuleAction, { operation: "stock_rule_update" }>,
  ) {
    if (a.marginPct !== undefined) {
      const clash = (
        await this.db.query(
          `SELECT o.id FROM watch_rules r JOIN watch_rules o ON o.user_id=r.user_id AND o.id<>r.id
             AND o.scope=r.scope AND o.item_id IS NOT DISTINCT FROM r.item_id AND o.direction=r.direction
             AND o.reference=r.reference AND o.basis=r.basis AND o.margin_pct=$3
           WHERE r.id=$1 AND r.user_id=$2`,
          [a.id, user, a.marginPct],
        )
      ).rows[0];
      if (clash)
        throw new ToolValidationError(
          `That change would duplicate rule ${clash.id}; remove one of them instead`,
        );
    }
    const row = (
      await this.db.query(
        `UPDATE watch_rules SET status=COALESCE($3,status),margin_pct=COALESCE($4,margin_pct),
           notify=COALESCE($5,notify),label=COALESCE($6,label),updated_at=now()
         WHERE id=$1 AND user_id=$2 RETURNING *`,
        [
          a.id,
          user,
          a.status ?? null,
          a.marginPct ?? null,
          a.notify ?? null,
          a.label?.trim() ?? null,
        ],
      )
    ).rows[0];
    if (!row)
      throw new ToolValidationError(
        "No rule with that id; use stock_rule_list",
      );
    if (a.status === "paused")
      await this.db.query(
        "UPDATE watch_rule_alerts SET state='muted' WHERE rule_id=$1 AND user_id=$2 AND state='pending'",
        [a.id, user],
      );
    return { rule: this.view(row), meaning: describeRule(row) };
  }

  private async remove(user: string, id: string) {
    const removed = (
      await this.db.query(
        "DELETE FROM watch_rules WHERE id=$1 AND user_id=$2 RETURNING id",
        [id, user],
      )
    ).rows.length;
    if (!removed)
      throw new ToolValidationError(
        "No rule with that id; use stock_rule_list",
      );
    return { removed: id };
  }
}
