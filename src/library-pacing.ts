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
