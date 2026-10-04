import {
  ProviderError,
  quoteKey,
  type MarketDataProvider,
  type PriceBar,
  type SymbolRef,
} from "./stock-provider.js";
import { DAILY_BARS } from "./stock-stats.js";

const SERIES = [
  ["1day", DAILY_BARS],
  ["1month", 5000],
] as const;

/**
 * Split-adjusted history shared by on-demand lookups and the rule engine, cached per
 * listing, interval and exchange trading day so each stock costs at most one credit per
 * series per day. Callers reserve credits for `missing()` series before `load()`. A
 * permanent provider failure is remembered as null for the day; a transient one (429,
 * 5xx, timeout) yields null for that call only and is fetched again next time.
 */
export class MarketHistory {
  private cache = new Map<string, PriceBar[] | null>();
  constructor(private provider: MarketDataProvider) {}

  private key(ref: SymbolRef, interval: string, day: string) {
    return `${quoteKey(ref)}:${interval}:${day}`;
  }

  /** Series not yet cached for this trading day: the credits a load would spend. */
  missing(ref: SymbolRef, day: string) {
    return SERIES.filter(([i]) => !this.cache.has(this.key(ref, i, day)))
      .length;
  }

  async load(
    ref: SymbolRef,
    day: string,
  ): Promise<{ daily: PriceBar[] | null; monthly: PriceBar[] | null }> {
    const out: Record<string, PriceBar[] | null> = {};
    for (const [interval, size] of SERIES) {
      const key = this.key(ref, interval, day);
      if (this.cache.has(key)) {
        out[interval] = this.cache.get(key)!;
        continue;
      }
      if (!this.provider.history) {
        out[interval] = null;
        continue;
      }
      try {
        const bars = await this.provider.history(ref, interval, size);
        this.remember(key, bars);
        out[interval] = bars;
      } catch (error) {
        if (error instanceof ProviderError && !error.retryable)
          this.remember(key, null);
        out[interval] = null;
      }
    }
    return { daily: out["1day"] ?? null, monthly: out["1month"] ?? null };
  }

  /** Keeps only the current trading day's entry per listing and interval. */
  private remember(key: string, bars: PriceBar[] | null) {
    const prefix = key.slice(0, key.lastIndexOf(":") + 1);
    for (const existing of this.cache.keys())
      if (existing.startsWith(prefix) && existing !== key)
        this.cache.delete(existing);
    if (this.cache.size > 400) this.cache.clear();
    this.cache.set(key, bars);
  }
}
