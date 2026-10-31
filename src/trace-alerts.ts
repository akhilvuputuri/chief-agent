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
}

const RATES = new Set(["model_error_rate", "tool_error_rate"]);

function amount(metric: string, value: number | null) {
  if (value === null) return "no data";
  if (RATES.has(metric)) return `${Math.round(value * 1000) / 10}%`;
  if (metric === "cost_usd") return `$${value.toFixed(2)}`;
  if (metric === "model_p95_ms") return `${(value / 1000).toFixed(1)} s`;
  return `${Math.round(value * 1000) / 1000}`;
}

function span(minutes: number) {
  if (minutes % (24 * 60) === 0)
    return minutes === 24 * 60 ? "24 hours" : `${minutes / (24 * 60)} days`;
  if (minutes % 60 === 0)
    return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

/** The Telegram text of one alert. Plain text: it is sent without a parse mode. */
export function alertText(alert: MonitorAlert) {
  const name = alert.monitor_name.slice(0, 200);
  const value = amount(alert.metric, alert.value);
  const threshold = amount(alert.metric, alert.threshold);
  if (alert.kind === "resolved")
    return `Resolved: ${name} is back to ${value} over the last ${span(alert.window_minutes)} (limit ${threshold}).`;
  return `Alert: ${name} is ${value} over the last ${span(alert.window_minutes)}, ${alert.comparison} the limit of ${threshold} (${alert.samples} samples). Details in agentwatch.`;
}

function valid(alert: any): alert is MonitorAlert {
  return (
    typeof alert?.id === "string" &&
    /^[A-Za-z0-9_.:-]{1,200}$/.test(alert.id) &&
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

  constructor(
    private readonly base: string,
    /** Sends to the owner; must reject when it could not, so the alert is retried. */
    private readonly send: (text: string) => Promise<void>,
    private readonly post: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

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
      const alerts = Array.isArray(data?.alerts) ? data.alerts : [];
      for (const alert of alerts.slice(0, MAX_PER_POLL)) {
        if (!valid(alert)) throw new Error("invalid alert");
        await this.send(alertText(alert));
        const marked = await this.post(
          `${this.base}/api/alerts/${encodeURIComponent(alert.id)}/delivered`,
          { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) },
        );
        await marked.body?.cancel().catch(() => undefined);
        if (!marked.ok) throw new Error(`HTTP ${marked.status}`);
        delivered++;
      }
      if (delivered)
        opsLog("trace.alerts_delivered", "info", { deliveredCount: delivered });
    } catch {
      // agentwatch being down costs a log line an hour; turns are unaffected.
      if (this.now() - this.lastReport >= REPORT_EVERY_MS) {
        this.lastReport = this.now();
        opsLog("trace.alerts_failed", "warn", { deliveredCount: delivered });
      }
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
