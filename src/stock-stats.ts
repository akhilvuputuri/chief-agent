import type { PriceBar, Quote } from "./stock-provider.js";

/**
 * Reference statistics for one instrument (docs/stock-rules.md). Pure and deterministic:
 * questions, rules and digests all use these figures, so answers and alerts agree. Every
 * figure comes from the same provider as the price. A window with too little history is
 * null with a reason, never a shorter window presented as the full one. The quote's
 * `fifty_two_week` block is deliberately unused: at the monitor's 1-minute interval it
 * covers recent minutes, not 52 weeks (measured 4 October 2026).
 */

export const WINDOWS = { "12w": 60, "26w": 130, "52w": 260 } as const;
export type WindowKey = keyof typeof WINDOWS;
/** Sessions fetched so the 52-week window is complete with margin for holidays. */
export const DAILY_BARS = 300;
const MIN_COVERAGE = 0.9;

const round = (value: number, digits: number) =>
  Math.round(value * 10 ** digits) / 10 ** digits;
const fromPct = (price: number, reference: number) =>
  round((price / reference - 1) * 100, 2);

type Missing = { value: null; reason: string };

export interface Average {
  value: number;
  sessions: number;
  fromPct: number;
}
export interface Range {
  low: number;
  lowDate: string;
  high: number;
  highDate: string;
  sessions: number;
  fromLowPct: number;
  fromHighPct: number;
}

export interface StockStats {
  price: number;
  currency: string;
  quoteTime: string;
  tradingDate: string;
  previousClose: number | null;
  dayChangePct: number | null;
  averages: Record<WindowKey, Average | Missing>;
  ranges: Record<WindowKey, Range | Missing>;
  allTime:
    (Omit<Range, "sessions"> & { since: string; months: number }) | Missing;
  basis: string;
}

/** Extremes over bars, with the current price included (it may be today's new extreme). */
function extremes(bars: PriceBar[], price: number, today: string) {
  let low = { value: price, date: today };
  let high = { value: price, date: today };
  for (const b of bars) {
    if (b.low < low.value) low = { value: b.low, date: b.date };
    if (b.high > high.value) high = { value: b.high, date: b.date };
  }
  return { low, high };
}

export function computeStats(input: {
  quote: Quote;
  daily: PriceBar[] | null;
  monthly: PriceBar[] | null;
}): StockStats {
  const q = input.quote;
  if (!(Number.isFinite(q.price) && q.price > 0))
    throw new Error("Quote has no usable price");
  const price = q.price;
  const today = q.tradingDate || q.quoteTime.toISOString().slice(0, 10);
  const daily = input.daily ?? [];
  // Averages use completed sessions only; today's bar is still moving.
  const completed = daily.filter((b) => b.date < today);
  const averages = {} as StockStats["averages"];
  const ranges = {} as StockStats["ranges"];
  for (const [key, sessions] of Object.entries(WINDOWS) as [
    WindowKey,
    number,
  ][]) {
    const closes = completed.slice(-sessions);
    if (closes.length < sessions * MIN_COVERAGE) {
      const reason = input.daily
        ? `only ${closes.length} of ${sessions} sessions of history`
        : "daily history unavailable";
      averages[key] = { value: null, reason };
      ranges[key] = { value: null, reason };
      continue;
    }
    const mean = closes.reduce((t, b) => t + b.close, 0) / closes.length;
    averages[key] = {
      value: round(mean, 4),
      sessions: closes.length,
      fromPct: fromPct(price, mean),
    };
    // Lows/highs include today's bar and price: a new low today counts.
    const window = daily.slice(
      -sessions - (daily.at(-1)?.date === today ? 1 : 0),
    );
    const { low, high } = extremes(window, price, today);
    ranges[key] = {
      low: round(low.value, 4),
      lowDate: low.date,
      high: round(high.value, 4),
      highDate: high.date,
      sessions: closes.length,
      fromLowPct: fromPct(price, low.value),
      fromHighPct: fromPct(price, high.value),
    };
  }
  let allTime: StockStats["allTime"];
  const monthly = input.monthly ?? [];
  if (!monthly.length)
    allTime = {
      value: null,
      reason: input.monthly
        ? "no monthly history"
        : "monthly history unavailable",
    };
  else {
    const { low, high } = extremes([...monthly, ...daily], price, today);
    allTime = {
      low: round(low.value, 4),
      lowDate: low.date,
      high: round(high.value, 4),
      highDate: high.date,
      fromLowPct: fromPct(price, low.value),
      fromHighPct: fromPct(price, high.value),
      since: monthly[0]!.date,
      months: monthly.length,
    };
  }
  const previousClose =
    Number.isFinite(q.prevClose) && q.prevClose > 0 ? q.prevClose : null;
  return {
    price,
    currency: q.currency,
    quoteTime: q.quoteTime.toISOString(),
    tradingDate: today,
    previousClose,
    dayChangePct: previousClose ? fromPct(price, previousClose) : null,
    averages,
    ranges,
    allTime,
    basis:
      "Split-adjusted history from the same provider as the price. Averages are simple averages of completed daily closes (12w=60, 26w=130, 52w=260 sessions); lows/highs use daily bar lows/highs plus the current price. All-time figures start at the provider's first monthly bar ('since'). Bar dates for monthly extremes are the month's first day.",
  };
}
