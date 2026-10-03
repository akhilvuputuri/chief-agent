/**
 * The market-data provider's credit allowance, shared by the watchlist monitor and
 * on-demand lookups. Twelve Data restores the full per-minute allowance at each minute
 * boundary (no drip) and counts a daily allowance that resets at 00:00 UTC. The monitor
 * spends as before; optional work such as lookups only takes what is left this minute and
 * never dips into a daily reserve kept for monitoring. Counts are in memory: a restart
 * under-counts, and the provider's own 429 still backs off.
 */
export class CreditBucket {
  private minute = -1;
  private left = 0;
  private day = "";
  private used = 0;
  constructor(
    readonly perMinute: number,
    readonly perDay = 800,
  ) {}
  /**
   * Windows only move forward. The monitor fixes `now` at the start of a tick while a
   * lookup reads a later clock; an older timestamp is counted in the current window, never
   * used to reopen a past minute (which would refill an allowance already spent).
   */
  private roll(now: Date) {
    const minute = Math.floor(now.getTime() / 60000);
    if (minute > this.minute) {
      this.minute = minute;
      this.left = this.perMinute;
    }
    const day = now.toISOString().slice(0, 10);
    if (day > this.day) {
      this.day = day;
      this.used = 0;
    }
  }
  /** Credits left in the current minute. */
  available(now: Date) {
    this.roll(now);
    return this.left;
  }
  /** Reserve credits before dispatch: a timed-out request may still be billed. */
  spend(credits: number, now: Date) {
    this.roll(now);
    this.left -= credits;
    this.used += credits;
  }
  /** Optional work: take credits only if this minute and the daily reserve allow it. */
  tryTake(credits: number, now: Date, dailyReserve: number) {
    this.roll(now);
    if (this.left < credits || this.used + credits > this.perDay - dailyReserve)
      return false;
    this.spend(credits, now);
    return true;
  }
  usedToday(now: Date) {
    this.roll(now);
    return this.used;
  }
}
