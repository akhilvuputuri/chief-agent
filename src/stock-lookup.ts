import type { Database } from "./db.js";
import { marketCalendar } from "./market-calendar.js";
import type { CreditBucket } from "./market-credits.js";
import {
  ProviderError,
  quoteKey,
  type MarketDataProvider,
  type PriceBar,
  type Quote,
  type SymbolHit,
  type SymbolRef,
} from "./stock-provider.js";
import { computeStats, DAILY_BARS } from "./stock-stats.js";
import { pickInstrument, zoned } from "./stocks.js";
import { ToolValidationError } from "./tool-errors.js";

/** Daily credits lookups leave untouched, so monitoring always has its allowance. */
const DAILY_RESERVE = 300;
const QUOTE_TTL_MS = 60 * 1000;

export interface LookupAction {
  operation: "stock_lookup";
  query?: string;
  exchange?: string;
  id?: string;
}

/**
 * Read-only "ask now" answers for the stocks agent (docs/stock-rules.md, Phase 2a):
 * price, averages, ranges and all-time extremes with provenance. History is cached per
 * exchange trading day, so repeated questions cost no further credits. Credits come from
 * the allowance shared with the monitor: a lookup uses only what is left this minute (a
 * monitor batch then waits for the next minute) and never the daily monitoring reserve.
 * No model calls; no writes.
 */
export class StockLookup {
  /** null records a failed fetch for the day, so a broken series is not re-billed on retry. */
  private history = new Map<string, PriceBar[] | null>();
  private quotes = new Map<string, { at: number; quote: Quote }>();
  /** Resolved searches for the UTC day, so a repeated question costs no search credit. */
  private resolved = new Map<string, { day: string; hit: SymbolHit }>();
  constructor(
    private db: Database,
    private provider: MarketDataProvider,
    private credits: CreditBucket,
    private clock = () => new Date(),
  ) {}

  private take(credits: number, now: Date) {
    if (!credits) return null;
    if (this.credits.tryTake(credits, now, DAILY_RESERVE)) return null;
    const reserved =
      this.credits.usedToday(now) + credits >
      this.credits.perDay - DAILY_RESERVE;
    const midnight = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    return {
      status: "busy",
      retryAfterSeconds: reserved
        ? Math.ceil((midnight - now.getTime()) / 1000)
        : 60 - now.getUTCSeconds(),
      note: reserved
        ? "Today's market-data allowance is reserved for monitoring; try again after 08:00 Singapore time."
        : "Market data is rate-limited this minute; try again shortly.",
    };
  }

  private async instrument(
    user: string,
    a: LookupAction,
    now: Date,
  ): Promise<
    | {
        ref: SymbolRef;
        symbol: string;
        name: string;
        exchange: string;
        currency: string;
      }
    | Record<string, unknown>
  > {
    if (a.id) {
      const row = (
        await this.db.query(
          "SELECT symbol,name,exchange,mic_code,currency FROM watchlist_items WHERE id=$1 AND user_id=$2",
          [a.id, user],
        )
      ).rows[0];
      if (!row)
        throw new ToolValidationError(
          "No watched stock with that id; use watchlist_list for ids",
        );
      return {
        ref: { symbol: row.symbol, mic: row.mic_code },
        symbol: row.symbol,
        name: row.name,
        exchange: row.exchange,
        currency: row.currency,
      };
    }
    const query = a.query?.trim();
    if (!query)
      throw new ToolValidationError(
        "Give a ticker or company name, or a watched stock id",
      );
    // A stock already on the watchlist resolves without a search.
    const ticker = query.toUpperCase();
    const watched = (
      await this.db.query(
        "SELECT symbol,name,exchange,mic_code,currency FROM watchlist_items WHERE user_id=$1 AND upper(symbol)=$2",
        [user, ticker],
      )
    ).rows;
    const exchangeMatch = (row: any) =>
      !a.exchange ||
      [row.exchange, row.mic_code].some(
        (v: string) => v.toLowerCase() === a.exchange!.toLowerCase(),
      );
    const known = watched.filter(exchangeMatch);
    if (known.length === 1) {
      const row = known[0];
      return {
        ref: { symbol: row.symbol, mic: row.mic_code },
        symbol: row.symbol,
        name: row.name,
        exchange: row.exchange,
        currency: row.currency,
      };
    }
    const cacheKey = `${ticker}|${a.exchange?.toLowerCase() ?? ""}`;
    const day = now.toISOString().slice(0, 10);
    const cached = this.resolved.get(cacheKey);
    if (cached?.day === day)
      return {
        ref: { symbol: cached.hit.symbol, mic: cached.hit.mic },
        symbol: cached.hit.symbol,
        name: cached.hit.name,
        exchange: cached.hit.exchange,
        currency: cached.hit.currency,
      };
    const busy = this.take(1, now);
    if (busy) return busy;
    let hits: SymbolHit[];
    try {
      hits = await this.provider.search(query);
    } catch (error) {
      throw new Error(
        `Symbol lookup failed: ${error instanceof Error ? error.message : "provider error"}`,
      );
    }
    const hit = pickInstrument(
      hits,
      query,
      a.exchange,
      "Multiple instruments match; ask the owner which exchange, then call stock_lookup again with that exchange.",
    );
    if ("needsChoice" in hit) return hit;
    if (this.resolved.size > 500) this.resolved.clear();
    this.resolved.set(cacheKey, { day, hit });
    return {
      ref: { symbol: hit.symbol, mic: hit.mic },
      symbol: hit.symbol,
      name: hit.name,
      exchange: hit.exchange,
      currency: hit.currency,
    };
  }

  async call(user: string, a: LookupAction) {
    if (!this.provider.history)
      throw new ToolValidationError(
        "The market-data provider has no price history",
      );
    const now = this.clock();
    const found = await this.instrument(user, a, now);
    if (!("ref" in found)) return found;
    const instrument = found as {
      ref: SymbolRef;
      symbol: string;
      name: string;
      exchange: string;
      currency: string;
    };
    const calendar = marketCalendar(instrument.ref.mic);
    if (!calendar)
      throw new ToolValidationError(
        `${instrument.exchange} is not supported on the current market-data plan; only US listings are covered`,
      );
    const key = quoteKey(instrument.ref);
    const tradingDay = zoned(now, calendar.timezone).date;
    const dailyKey = `${key}:1day:${tradingDay}`;
    const monthlyKey = `${key}:1month:${tradingDay}`;
    const cachedQuote = this.quotes.get(key);
    const needQuote =
      !cachedQuote || now.getTime() - cachedQuote.at > QUOTE_TTL_MS;
    const needed =
      (needQuote ? 1 : 0) +
      (this.history.has(dailyKey) ? 0 : 1) +
      (this.history.has(monthlyKey) ? 0 : 1);
    const busy = this.take(needed, now);
    if (busy) return busy;
    let quote: Quote;
    try {
      if (needQuote) {
        const fetched = (await this.provider.quotes([instrument.ref])).get(key);
        if (!fetched)
          throw new ProviderError("provider returned no quote", true);
        if (this.quotes.size > 200) this.quotes.clear();
        this.quotes.set(key, { at: now.getTime(), quote: fetched });
      }
      quote = this.quotes.get(key)!.quote;
    } catch (error) {
      throw new Error(
        `Market data unavailable: ${error instanceof Error ? error.message : "provider error"}`,
      );
    }
    // A failed history series degrades to null figures with reasons, not a failed answer.
    // Only a permanent failure is remembered for the day; a transient one (429, 5xx,
    // timeout) is fetched again on the next question.
    const series = new Map<string, PriceBar[] | null>();
    for (const [cacheKey, interval, size] of [
      [dailyKey, "1day", DAILY_BARS],
      [monthlyKey, "1month", 5000],
    ] as const) {
      if (this.history.has(cacheKey)) {
        series.set(cacheKey, this.history.get(cacheKey)!);
        continue;
      }
      try {
        const bars = await this.provider.history(
          instrument.ref,
          interval,
          size,
        );
        this.remember(cacheKey, bars);
        series.set(cacheKey, bars);
      } catch (error) {
        if (error instanceof ProviderError && !error.retryable)
          this.remember(cacheKey, null);
        series.set(cacheKey, null);
      }
    }
    if (quote.currency && quote.currency !== instrument.currency)
      throw new Error(
        `Quote currency ${quote.currency} differs from the listing's ${instrument.currency}`,
      );
    return {
      instrument: {
        symbol: instrument.symbol,
        name: instrument.name,
        exchange: instrument.exchange,
        currency: instrument.currency,
      },
      stats: computeStats({
        quote,
        daily: series.get(dailyKey) ?? null,
        monthly: series.get(monthlyKey) ?? null,
      }),
      source: {
        provider: this.provider.name,
        quoteDelayed: quote.delayed,
        marketOpen: quote.marketOpen,
        history: "split-adjusted; cached for the exchange trading day",
      },
      note: "Facts only: these are reference levels, not buy or sell advice.",
    };
  }

  /** Keeps only the current trading day's history per instrument and interval. */
  private remember(key: string, bars: PriceBar[] | null) {
    const prefix = key.slice(0, key.lastIndexOf(":"));
    for (const existing of this.history.keys())
      if (existing.startsWith(prefix + ":") && existing !== key)
        this.history.delete(existing);
    this.history.set(key, bars);
  }
}
