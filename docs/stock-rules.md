# Stock questions, rules and digests (issue #146, Phase 2)

Status: **plan agreed with the owner on 3–4 October 2026. Phase 2a is implemented on `feat/stock-rules-2a`, pending review and release.** Builds on the deterministic [stock watchlist](stock-watchlist.md) and read-only [IBKR holdings](ibkr-portfolio.md). Journal: [60](journey/60-stock-rules.md).

## Goal

The owner asks the stocks agent about stocks in their own words. The agent answers questions now, turns "tell me when…" into saved rules that the host checks without model calls, and can send a scheduled digest. A new kind of request should usually need a new _reference_, not a new feature.

## Request kinds

| Kind                 | Examples                                                                                             | Handling                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Ask now              | "What's AAPL's all-time low?", "How far is QQQM from its high?"                                      | `stock_lookup`: computed statistics with source and as-of time                                                      |
| Watch and tell me    | "Tell me when any holding is below my buy price", "…if VOO is 15% off its 52-week high at the close" | A structured rule, evaluated deterministically on the watchlist tick; alerts through the existing outbox (Phase 2b) |
| Report on a schedule | "Every evening, tell me where my stocks stand against my rules"                                      | A deterministic digest at an owner-chosen Singapore time (Phase 2c)                                                 |
| Advice               | "Should I buy the dip?"                                                                              | Facts only (distance to low, high, average or cost); no buy or sell advice                                          |

## Rule shape (Phase 2b)

- **Subject:** one watched stock, every IBKR holding, or every watched stock.
- **Condition:** price `below` or `above` a reference, optionally by a margin percentage.
- **References:** previous close, IBKR average cost, N-week average, N-week low or high, all-time low or high.
- **Basis:** intraday (each valid poll) or close (the session's last valid regular-hours quote), within the existing monitoring windows.
- **Notify:** on crossing, re-armed after recovering 1% past the trigger, at most once per rule per trading day; or once per day while true.

The agent converts the owner's words into this shape. The host validates it, and the agent confirms its interpretation before saving. Ambiguity (exchange, which average, intraday or close) goes back to the owner.

## Statistics layer (Phase 2a)

One module, `src/stock-stats.ts`, computes every reference. Questions, rules and digests all use it, so answers and alerts agree.

- **Inputs.** The quote the monitor already fetches, plus history from the same provider, so one provider's price is never compared with another's reference.
  - Daily bars: the latest 300 sessions, `1day`, split-adjusted.
  - Monthly bars: full history, `1month`, split-adjusted. Twelve Data returns 551 bars for AAPL, back to December 1980, measured on 4 October 2026 with the public demo key.
- **Outputs.** Each has its source and as-of date:
  - day change;
  - 12-, 26- and 52-week simple averages (60, 130 and 260 sessions);
  - 12-, 26- and 52-week lows and highs;
  - all-time low and high, with their dates and the history start ("since 1980-12");
  - distance from each, as a percentage.
- **The quote's `fifty_two_week` block is not used.** With the monitor's `interval=1min`, it covers recent one-minute bars, not 52 weeks: measured 330.67–334.54 for AAPL on 4 October 2026. Every N-week figure comes from daily history instead.
- **Insufficient history.** A figure needing more sessions than are available (below 90% of the window) is `null`, with the reason; it is never a shorter-window value presented as the full one.
- **Caching.** History is cached per symbol, interval and exchange trading date, so it costs at most 1 credit per interval per stock per day. Quotes are cached for 60 seconds.
- **Credits.** One shared limiter serves both the monitor and lookups: Twelve Data's per-minute allowance resets at each minute boundary, and 800 credits are available per day. A lookup uses only what is left in the current minute, so at worst a monitor batch waits for the next minute boundary, as it already does when a batch exceeds the allowance. Lookups never touch the daily reserve kept for monitoring (300 credits).
  - A lookup that would exceed the per-minute allowance returns a retryable "busy" result instead of waiting.
  - Lookups stop when daily use passes a reserve that keeps the monitor running.
  - The daily counter is in memory; a restart under-counts, and the provider's own 429 still backs off.
- **Scope.** US listings only, as the built-in calendar and the free plan support. Other exchanges are reported as unsupported.

## Phase 2a implementation

- **`src/market-credits.ts`.** A `CreditBucket` shared by `StockMonitor` and the lookup. The monitor's per-minute behaviour is unchanged. Optional work uses `tryTake`, which respects the minute's remainder and a 300-credit daily reserve; the daily count is UTC.
- **`src/stock-provider.ts`.** An optional `history(ref, interval, outputsize)` method. Twelve Data's implementation calls `/time_series` with `mic_code`, `order=asc` and `adjust=splits`. `parseBars` rejects a malformed or duplicate bar for the whole series.
- **`src/stock-stats.ts`.** Pure `computeStats`:
  - averages over completed sessions;
  - ranges and all-time figures that include today's bar and price, with dates;
  - `null` with a reason below 90% coverage.
- **`src/stock-lookup.ts`.**
  - **Resolution.** A watched stock (by ID or ticker) resolves without a search. Other symbols go through the same exchange picker as `watchlist_add` and are cached for the UTC day.
  - **Data.** Non-US listings are refused. The quote is cached for 60 seconds, and history for the exchange trading day.
  - **Results.** A `busy` result is returned rather than waiting for credits.
- **Tool and agent.** `stock_lookup` is a read operation in the `watchlist` domain, gated on market data and granted to `core/stocks`, whose instructions now cover "ask now" questions, provenance, null figures and busy results.

## Phases

| Phase | Ships                                                                                    | Schema        |
| ----- | ---------------------------------------------------------------------------------------- | ------------- |
| 2a    | Statistics layer, shared credit limiter, read-only `stock_lookup` for the stocks agent   | None          |
| 2b    | General rules, deterministic evaluation, alerts, the "every holding" subject (IBKR cost) | Migration 027 |
| 2c    | Daily digest and the agent's rule-writing guide                                          | None expected |

Each phase has its own PR, tests, independent review, journal update and release record.

## Out of scope

Trading, buy or sell recommendations, paid market-data plans, non-US exchanges on the current plan, model calls in monitoring, and automatic watch creation from holdings.
