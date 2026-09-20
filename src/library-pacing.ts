import type { RouteKind } from "./library-routes.js";
export type CallOutcome =
  | "ok"
  | "rejected"
  | "throttled"
  | "unauthenticated"
  | "transient"
  | "timeout"
  | "refused";
export interface CallRecord {
  host: string;
  method: string;
  route: string;
  kind: RouteKind;
  outcome: CallOutcome;
  status?: number;
  ms: number;
}
/** Durable pacing state. Phase 1 keeps it in memory; a Postgres store arrives with the schema release. */
export interface PacingStore {
  /** Counts an attempt against the day; returns false when the ceiling for this kind is reached. */
  reserve(kind: RouteKind, day: string, ceiling: number): Promise<boolean>;
  breaker(): Promise<{ until: number; reason: string } | null>;
  /** Returns true when this call opened the breaker (so the owner is told once). */
  openBreaker(until: number, reason: string): Promise<boolean>;
  timing(): Promise<{ callAt: number; writeAt: number }>;
  markCall(kind: RouteKind, at: number): Promise<void>;
  failures(action: "increment" | "reset"): Promise<number>;
  record(entry: CallRecord): Promise<void>;
  usage(day: string): Promise<{ calls: number; linkPolls: number }>;
}
export class MemoryPacing implements PacingStore {
  private days = new Map<string, { calls: number; linkPolls: number }>();
  private open: { until: number; reason: string } | null = null;
  private callAt = 0;
  private writeAt = 0;
  private consecutive = 0;
  readonly records: CallRecord[] = [];
  constructor(private now: () => number = Date.now) {}
  private day(day: string) {
    let d = this.days.get(day);
    if (!d) {
      d = { calls: 0, linkPolls: 0 };
      this.days.set(day, d);
    }
    return d;
  }
  async reserve(kind: RouteKind, day: string, ceiling: number) {
    const d = this.day(day);
    if (kind === "link") {
      if (d.linkPolls >= ceiling) return false;
      d.linkPolls++;
      return true;
    }
    if (d.calls >= ceiling) return false;
    d.calls++;
    return true;
  }
  async breaker() {
    if (this.open && this.open.until > this.now()) return this.open;
    return null;
  }
  async openBreaker(until: number, reason: string) {
    const newly = !this.open || this.open.until <= this.now();
    if (newly || until > this.open!.until) this.open = { until, reason };
    return newly;
  }
  async timing() {
    return { callAt: this.callAt, writeAt: this.writeAt };
  }
  async markCall(kind: RouteKind, at: number) {
    this.callAt = at;
    if (kind === "write" || kind === "identity") this.writeAt = at;
  }
  async failures(action: "increment" | "reset") {
    this.consecutive = action === "reset" ? 0 : this.consecutive + 1;
    return this.consecutive;
  }
  async record(entry: CallRecord) {
    this.records.push(entry);
  }
  async usage(day: string) {
    return { ...this.day(day) };
  }
}
import type { Database } from "./db.js";
/** Pacing state in Postgres so ceilings, breaker and write spacing survive restarts. */
export class PostgresPacing implements PacingStore {
  constructor(
    private db: Database,
    private now: () => number = Date.now,
  ) {}
  async reserve(kind: RouteKind, day: string, ceiling: number) {
    await this.db.query(
      "INSERT INTO library_call_days(day) VALUES($1) ON CONFLICT DO NOTHING",
      [day],
    );
    const column = kind === "link" ? "link_polls" : "calls";
    const reserved = (
      await this.db.query(
        `UPDATE library_call_days SET ${column}=${column}+1${kind === "write" || kind === "identity" ? ",writes=writes+1" : ""} WHERE day=$1 AND ${column}<$2 RETURNING ${column}`,
        [day, ceiling],
      )
    ).rows[0];
    if (reserved) return true;
    await this.db.query(
      "UPDATE library_call_days SET refused=refused+1 WHERE day=$1",
      [day],
    );
    return false;
  }
  async breaker() {
    const row = (
      await this.db.query(
        "SELECT breaker_open_until,breaker_reason FROM library_pacing WHERE breaker_open_until>now()",
      )
    ).rows[0];
    return row
      ? {
          until: new Date(row.breaker_open_until).getTime(),
          reason: String(row.breaker_reason ?? ""),
        }
      : null;
  }
  async openBreaker(until: number, reason: string) {
    const opened = (
      await this.db.query(
        "UPDATE library_pacing SET breaker_open_until=$1,breaker_reason=$2,notified_breaker_at=now(),updated_at=now() WHERE breaker_open_until IS NULL OR breaker_open_until<=now() RETURNING singleton",
        [new Date(until).toISOString(), reason],
      )
    ).rows.length;
    if (!opened)
      await this.db.query(
        "UPDATE library_pacing SET breaker_open_until=GREATEST(breaker_open_until,$1::timestamptz),updated_at=now()",
        [new Date(until).toISOString()],
      );
    return opened > 0;
  }
  async timing() {
    const row = (
      await this.db.query(
        "SELECT last_call_at,last_write_at FROM library_pacing",
      )
    ).rows[0];
    return {
      callAt: row?.last_call_at ? new Date(row.last_call_at).getTime() : 0,
      writeAt: row?.last_write_at ? new Date(row.last_write_at).getTime() : 0,
    };
  }
  async markCall(kind: RouteKind, at: number) {
    const iso = new Date(at).toISOString();
    await this.db.query(
      kind === "write" || kind === "identity"
        ? "UPDATE library_pacing SET last_call_at=$1,last_write_at=$1,updated_at=now()"
        : "UPDATE library_pacing SET last_call_at=$1,updated_at=now()",
      [iso],
    );
  }
  async failures(action: "increment" | "reset") {
    const row = (
      await this.db.query(
        action === "reset"
          ? "UPDATE library_pacing SET consecutive_failures=0 RETURNING consecutive_failures"
          : "UPDATE library_pacing SET consecutive_failures=consecutive_failures+1 RETURNING consecutive_failures",
      )
    ).rows[0];
    return Number(row?.consecutive_failures ?? 0);
  }
  async record(entry: CallRecord) {
    await this.db.query(
      "INSERT INTO library_calls(host,method,route,kind,outcome,status,duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        entry.host,
        entry.method,
        entry.route,
        entry.kind,
        entry.outcome,
        entry.status ?? null,
        Math.round(entry.ms),
      ],
    );
  }
  async usage(day: string) {
    const row = (
      await this.db.query(
        "SELECT calls,link_polls FROM library_call_days WHERE day=$1",
        [day],
      )
    ).rows[0];
    return {
      calls: Number(row?.calls ?? 0),
      linkPolls: Number(row?.link_polls ?? 0),
    };
  }
  /** Unused; the client supplies its own clock. Kept so the store can be constructed symmetrically in tests. */
  clock() {
    return this.now();
  }
}
