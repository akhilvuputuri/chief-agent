# Stock questions, rules and digests (issue #146, Phase 2)

Status: **Phase 2a released in v0.3.37; Phase 2b (rules) released in v0.3.41 on 4 October 2026; Phase 2c (digest) next.****plan agreed with the owner on 3–4 October 2026. Phase 2a is released in v0.3.37; Phase 2b (rules) is implemented on `feat/stock-rules-2b`, pending review and the migration-029 rollout.** Builds on the deterministic [stock watchlist](stock-watchlist.md) and read-only [IBKR holdings](ibkr-portfolio.md). Journal: [60](journey/60-stock-rules.md).

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
  - Daily bars: the latest 300 sessions, `1day`, split-adjusted. A live check on 4 October 2026 (demo key, AAPL, `outputsize=300&order=asc`) returned the latest 300 sessions, 2025-07-25 to 2026-10-02. Daily history ending more than 7 days before the quote date is treated as stale (`null` with the reason).
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
- **Independent review of `e2569bd` (REQUEST CHANGES), all fixed:**
  - **Blocking.** The shared bucket could reopen a past minute when the monitor's tick-start timestamp interleaved with a later lookup, letting both exceed the per-minute allowance. Windows now only move forward.
  - **Blocking.** All-time extremes inside the daily range were dated by their month's first day. Daily bars now take precedence, so an exact date wins a tie.
  - **Weekends and after the close.** The quote date's bar now counts as completed once the market is closed.
  - **Reserve.** A busy result caused by the daily reserve gives the seconds until the 00:00 UTC reset.
  - **Failed series.** A failed history series yields `null` figures with reasons and is not fetched again that day.
  - **Searches.** `watchlist_add` searches are counted in the shared bucket.
  - **Cache bounds.** The quote cache is bounded.
- **Re-review of `9b2339e`: approved.** Its non-blocking follow-ups were also applied:
  - after the close, the quote price replaces the close of today's cached mid-session bar, and widens its range;
  - a transient history failure (429, 5xx or timeout) is fetched again, and only a permanent one is cached for the day;
  - the ranges window no longer reaches one extra bar back once the market is closed.
- **Known limits.**
  - History is fetched once per exchange trading day, so today's intraday range is as of that fetch, plus the current price.
  - The 300-credit daily reserve is fixed. At the default 15-minute cadence a full US session uses about 26 credits per watched stock, so the reserve covers about 11 stocks; it should be revisited if the watchlist grows beyond that.
- **Tool and agent.** `stock_lookup` is a read operation in the `watchlist` domain, gated on market data and granted to `core/stocks`, whose instructions now cover "ask now" questions, provenance, null figures and busy results.

## Phase 2b implementation

The owner agreed the defaults on 4 October 2026:

- holdings rules cover only holdings that are on the watchlist; Chief offers to add the others, after the exchange is confirmed;
- a close-based alert is held for the next monitoring window;
- IBKR cost older than 26 hours is treated as unknown;
- at most 50 rules.

**Storage.** Migration `029_stock_rules.sql` (027 and 028 were taken by other work) adds three tables, all additive, so `stock_alerts` and daily-drop alerts are unchanged and an older image keeps working after a rollback:

- `watch_rules`: scope, direction, reference, margin, basis, notify, status and the owner's restated label;
- `watch_rule_states`: armed state and the latest evaluation, per rule and watched stock;
- `watch_rule_alerts`: an outbox with `UNIQUE(rule, stock, trading_date)` and a `hold_for_window` flag.

**`src/stock-rules.ts`.**

- **`ruleReferences`.** Reference levels **exclude today's bar and price**, so "below its 52-week low" means a new low.
  - Averages, lows and highs come from completed sessions before today.
  - All-time levels use whole earlier months plus prior daily bars; the current month's bar is never used.
  - Too-short or stale history gives `null` with a reason.
  - `prev_close` comes from the quote, and `avg_cost` from fresh IBKR holdings (`currentHoldings` in `src/portfolio.ts`). The holdings must come from the current grant, be at most 26 hours old and be `STK` positions, matched by provider symbol (`BRK B` → `BRK.B`) and currency.
- **`RuleEngine`.** Called by `StockMonitor` only after its existing quote checks.
  - **Intraday rules** run on regular-session quotes.
  - **Close rules** get one extra quote 5 to 180 minutes after the regular close, accepted only if it is the final quote for that session date. The daily-drop logic never sees it.
  - **Alerting.** An alert is created on crossing, then waits for a recovery of 1% past the trigger; `daily` alerts once per trading day while the condition holds. The rule, the stock and the owner's pause are rechecked before each alert is queued.
  - **History.** Fetched through the shared `MarketHistory` with `tryTake(…, 0)`. With no credits this minute, the rule records "references pending" and runs on the next poll.
  - Rule errors are logged and never affect daily-drop monitoring.
- **`RuleDelivery`.** The same uncertain-send outbox contract as daily-drop alerts.
  - Intraday alerts are muted outside the window, as daily-drop alerts are.
  - Close alerts wait for the next window and are dropped after 4 days.
  - Pauses mute queued alerts.
- **`RuleTools`.** `stock_rule_add`, `stock_rule_update` and `stock_rule_remove` are foreground-only writes; `stock_rule_list` is a read. Validation covers the watched item, ownership, `avg_cost` scope, duplicates and the limit. A holdings rule reports `coverage`: which holdings are monitored and which are not watched.
- **Wiring.** `stock_rule_*` belongs to the `core/stocks` agent, whose limits rise to 120 s, 8 model calls and 20 tool calls. The instructions map phrases to rules and require the owner's confirmation of the restated rule.
  - Rule alerts go to the Markets topic with "Pause this rule" and "Pause all stock alerts" buttons, and can be read with `feed_read`.
  - Startup requires migration 29 (`STARTUP_MIGRATION_029`).
- **Independent review of `e55b3c9` (REQUEST CHANGES), all fixed with regressions:**
  - **Blocking.** With 7 or more watched stocks polled together, the quote batch used every credit in the minute, so history-based rules never loaded and never alerted. Evaluations waiting for history are now queued. `RuleEngine.warm()` runs at the end of each tick, loads their history from leftover credits on quiet ticks, and re-runs them with the same validated quote (intraday quotes only while at most 20 minutes old). Eight synchronized stocks now all alert within 3 minutes.
  - **Blocking.** A delayed feed could hand back a 15:50 quote as the close. `acceptsClose` now also requires the quote to be stamped at or after the regular close (early closes included), and otherwise retries.
  - **Long cadences.** The closing check bypasses the poll cadence, spaced at least 10 minutes apart, so a 240-minute cadence still gets it.
  - **Extended hours.** Close rules follow the regular session, so extended-hours stocks get them too, through the closing check or an ordinary post-market poll.
  - **Pauses.** The rule-delivery claim rechecks rule, stock and owner pauses, and `mutePending` ("Pause …" buttons and settings) now also mutes queued rule alerts.
  - **Delivery queue.** The scan covers up to 500 pending alerts, so held alerts cannot block deliverable ones.
  - **Isolation and ordering.** Each rule is isolated, so one failure never blocks a stock's other rules. Rule checks run after the batch's daily-drop decisions.
  - **Text and duplicates.** The cost alert wording was fixed ("below your IBKR average cost"), and margin updates are checked for duplicates.
- **Re-review of `4e84742`: approved.** Its follow-ups were also applied:
  - **Logging.** Per-rule failures are logged again (`stock.rules_failed`).
  - **Closing attempts.** A closing check without a final quote is visible ("waiting for the final close quote (attempt n)"). After 6 attempts, about an hour, the day ends with "close not confirmed: no final quote", so a thinly traded stock cannot spend credits for the whole closing window.
  - **Late re-checks.** An intraday re-check by `warm()` only happens inside the monitoring window, so a crossing cannot be used up by an alert that would be muted.
  - **Known paid-plan limit (not fixed).** For an extended-hours stock on a long cadence, a closing-only fetch moves `last_polled_at` and can delay the next post-market daily-drop poll.
- **Rollout.** `scripts/deploy-stock-rules.py`, with 15 offline tests. It permits only migration 029 and its Compose entry, and its baseline must equal the live release.

## Phases

| Phase | Ships                                                                                    | Schema                                            |
| ----- | ---------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 2a    | Statistics layer, shared credit limiter, read-only `stock_lookup` for the stocks agent   | None                                              |
| 2b    | General rules, deterministic evaluation, alerts, the "every holding" subject (IBKR cost) | Next additive migration (027 is the coding squad) |
| 2c    | Daily digest and the agent's rule-writing guide                                          | None expected                                     |

Each phase has its own PR, tests, independent review, journal update and release record.

## Out of scope

Trading, buy or sell recommendations, paid market-data plans, non-US exchanges on the current plan, model calls in monitoring, and automatic watch creation from holdings.
