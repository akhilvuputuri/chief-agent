// Alerts from agentwatch (issue #323), delivered to the owner on Telegram. agentwatch decides
// when a monitor fires and keeps the alert until it is told it was delivered; this polls for
// undelivered alerts over the same private network as trace export. So no inbound route, no
// shared secret, and agentwatch never holds the Telegram token. Alerts carry only monitor
// names and numbers. Delivery is at least once: an alert is marked only after it was sent.

import { opsLog } from "./ops-log.js";

/** Alerts sent per poll, so a backlog cannot flood the chat. */
const MAX_PER_POLL = 5;
const TIMEOUT_MS = 5000;
/** A failed poll or send is logged at most this often. */
const REPORT_EVERY_MS = 60 * 60_000;
/** Polls an alert waits for an unreachable owner once another owner has it. */
const MAX_PARTIAL_ROUNDS = 5;
/** An alert older than this says when it happened, so a backlog does not read as current. */
const LATE_MS = 10 * 60_000;

export interface MonitorAlert {
  id: string;
  monitor_name: string;
  kind: string;
  metric: string;
  comparison: string;
  threshold: number;
  value: number | null;
  bound: number | null;
  samples: number;
  window_minutes: number;
  /** Set when a firing monitor was edited or deleted, rather than recovering. */
  reason?: string | null;
  /** Unix nanoseconds, as a decimal string. */
  created_ns?: string;
}

const RATES = new Set(["model_error_rate", "tool_error_rate"]);

function amount(metric: string, value: number | null) {
  if (value === null) return "no data";
  if (
    RATES.has(metric) ||
    (metric === "score_mean" && value >= 0 && value <= 1)
  )
    return `${Math.round(value * 1000) / 10}%`;
  if (metric === "cost_usd") return `$${value.toFixed(2)}`;
  if (metric === "model_p95_ms") return `${(value / 1000).toFixed(1)} s`;
  return `${Math.round(value * 1000) / 1000}`;
}

function span(minutes: number) {
  if (minutes % (24 * 60) === 0)
    return minutes === 24 * 60 ? "24 hours" : `${minutes / (24 * 60)} days`;
  if (minutes % 60 === 0)
    return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function late(alert: MonitorAlert, now: number) {
  const at = Number(alert.created_ns) / 1e6;
  if (!Number.isFinite(at) || now - at < LATE_MS) return "";
  const minutes = Math.round((now - at) / 60_000);
  return minutes < 120
    ? `, raised ${minutes} minutes ago`
    : `, raised ${Math.round(minutes / 60)} hours ago`;
}

/** The Telegram text of one alert. Plain text: it is sent without a parse mode. */
export function alertText(alert: MonitorAlert, now = Date.now()) {
  // Anyone who can reach agentwatch sets this name, so it is reduced to one plain line. Not
  // kept in history; a reply quoting this message reaches the model as untrusted quoted text.
  const name = alert.monitor_name
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
    .trim()
    .slice(0, 200);
  const value = amount(alert.metric, alert.value);
  const threshold = amount(alert.metric, alert.threshold);
  if (alert.kind === "resolved" && alert.reason === "removed")
    return `Resolved: ${name} no longer applies; the monitor was deleted.`;
  if (alert.kind === "resolved" && alert.reason)
    return `Resolved: ${name} no longer applies; the monitor was changed or switched off.`;
  if (alert.kind === "resolved")
    return `Resolved: ${name} is back to ${value} over the last ${span(alert.window_minutes)} (limit ${threshold}).`;
  return `Alert: ${name} is ${value} over the last ${span(alert.window_minutes)}, ${alert.comparison} the limit of ${threshold} (${alert.samples} ${alert.samples === 1 ? "sample" : "samples"})${late(alert, now)}. Details in agentwatch.`;
}

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const UNREADABLE =
  "Alert: agentwatch raised an alert that Chief could not read. See its Alerts page.";

function valid(alert: any): alert is MonitorAlert {
  return (
    typeof alert?.id === "string" &&
    ID.test(alert.id) &&
    typeof alert.monitor_name === "string" &&
    typeof alert.kind === "string" &&
    typeof alert.metric === "string" &&
    typeof alert.comparison === "string" &&
    typeof alert.threshold === "number" &&
    (typeof alert.value === "number" || alert.value === null) &&
    typeof alert.samples === "number" &&
    typeof alert.window_minutes === "number"
  );
}

export class AlertRelay {
  private polling = false;
  private lastReport = Number.NEGATIVE_INFINITY;
  // Owners each alert has reached, and its failed rounds, so a retry repeats nothing. In
  // memory: a crash between sending and marking can repeat an alert once.
  private readonly progress = new Map<
    string,
    { reached: Set<string>; rounds: number }
  >();

  constructor(
    private readonly base: string,
    private readonly owners: string[],
    /** Sends to one owner; must reject when it could not, so that owner is retried. */
    private readonly send: (owner: string, text: string) => Promise<void>,
    private readonly post: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private report(errorCode: string, deliveredCount: number) {
    if (this.now() - this.lastReport < REPORT_EVERY_MS) return;
    this.lastReport = this.now();
    opsLog("trace.alerts_failed", "warn", { errorCode, deliveredCount });
  }

  /** Sends to the owners not yet reached; true when the alert is finished with. */
  private async deliver(id: string, text: string) {
    const state = this.progress.get(id) ?? {
      reached: new Set<string>(),
      rounds: 0,
    };
    this.progress.set(id, state);
    for (const owner of this.owners) {
      if (state.reached.has(owner)) continue;
      await this.send(owner, text).then(
        () => state.reached.add(owner),
        () => undefined,
      );
    }
    state.rounds++;
    if (state.reached.size === this.owners.length) return true;
    this.report("ALERT_SEND_FAILED", 0);
    // One owner who cannot be reached (never started the bot) must not hold up the queue;
    // an alert that reached nobody keeps waiting for Telegram to come back.
    return state.reached.size > 0 && state.rounds >= MAX_PARTIAL_ROUNDS;
  }

  /** One poll. Never throws; overlapping calls do nothing. Returns the alerts delivered. */
  async poll(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    let delivered = 0;
    try {
      const response = await this.post(
        `${this.base}/api/alerts?undelivered=1&limit=${MAX_PER_POLL}`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { alerts?: unknown };
      const alerts: unknown[] = Array.isArray(data?.alerts) ? data.alerts : [];
      for (const alert of alerts.slice(0, MAX_PER_POLL)) {
        const id = (alert as { id?: unknown } | null)?.id;
        if (typeof id !== "string" || !ID.test(id)) {
          // Nothing can mark it; it should not exist, so say so and go on to the next.
          this.report("ALERT_INVALID", delivered);
          continue;
        }
        const text = valid(alert) ? alertText(alert, this.now()) : UNREADABLE;
        // Stop here rather than skip it, so a resolved message cannot overtake its alert.
        if (!(await this.deliver(id, text))) break;
        const marked = await this.post(
          `${this.base}/api/alerts/${encodeURIComponent(id)}/delivered`,
          {
            method: "POST",
            // agentwatch takes writes only as JSON, which a browser cannot send cross-site.
            headers: { "content-type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(TIMEOUT_MS),
          },
        );
        await marked.body?.cancel().catch(() => undefined);
        if (!marked.ok) throw new Error(`HTTP ${marked.status}`);
        this.progress.delete(id);
        delivered++;
      }
      if (delivered)
        opsLog("trace.alerts_delivered", "info", { deliveredCount: delivered });
    } catch {
      // agentwatch being down costs a log line an hour; turns are unaffected.
      this.report("AGENTWATCH_UNAVAILABLE", delivered);
    } finally {
      this.polling = false;
    }
    return delivered;
  }
}

/** agentwatch's base URL, from the traces endpoint export already uses. */
export function alertsBase(tracesUrl: string) {
  return new URL(tracesUrl).origin;
}
