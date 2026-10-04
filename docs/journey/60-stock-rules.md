# 60 — How can one stock agent answer, watch and report on the owner's own stock questions?

Work date(s): 2026-10-03 to 2026-10-04. Written/revised: 2026-10-04.
Status: Phase 2a released in v0.3.37; Phase 2b (rules, migration 029) implemented and tested, pending review and rollout.

## User-visible problem and preceding iteration

The [stock watchlist](25-stock-watchlist.md) alerts only on a daily drop against the previous close. With [IBKR holdings](59-ibkr-portfolio.md) connected, the owner asked for "buy the dip" signals: below their average cost, below 12- or 52-week averages, and later all-time lows. They then asked for an overall design, so the stocks agent can handle such questions in their own words, check them at the right times and report. The plan is in [stock rules](../stock-rules.md).

## Evidence

- **Measured on 4 October 2026, with Twelve Data's public demo key.** For AAPL, the `/quote` call at `interval=1min` (as the monitor makes it) returned a `fifty_two_week` range of 330.67–334.54. That range covers recent one-minute bars, not 52 weeks, so it cannot be used for 52-week figures. `/time_series` at `1month`, `outputsize=5000`, `order=asc` returned 551 split-adjusted bars from 1980-12-01.
- **Reported by Twelve Data's documentation (4 October 2026).** `time_series` costs 1 credit per symbol, returns up to 5,000 bars, and defaults to `adjust=splits`.

## Diagnosis and alternatives

A fixed menu of alert types would grow with every new phrasing. Instead, requests are split into four kinds: ask now, watch, scheduled report and advice (which is refused). Watches share one structured rule shape, and every reference comes from one statistics module, so answers, alerts and digests agree. Taking 52-week figures from the quote was rejected on the evidence above.

## Implementation and review

- **Phase 2a** is described in [stock rules](../stock-rules.md#phase-2a-implementation).
- **Shared credits.** The monitor's private per-minute bucket became a `CreditBucket` shared with lookups, so the two cannot exceed the provider's allowance together. Existing monitor tests pass unchanged.
- **Shared resolution.** The watchlist's exchange picker was extracted as `pickInstrument`, so lookups resolve listings exactly as `watchlist_add` does.

- **Independent review.** Opus 5.5 reviewed `e2569bd` and returned **REQUEST CHANGES**, with two blocking findings:
  - the shared credit bucket could refill a past minute when a stale monitor timestamp interleaved with a lookup;
  - all-time extremes within the daily range were reported with the month's first day.

  Non-blocking findings covered stale daily history, a weekend average dropping Friday, the busy retry time under the reserve, a failed history series failing the whole answer, an uncounted `watchlist_add` search, the frozen intraday range, and the unbounded quote cache. All were fixed or documented, with regression tests.

- **Phase 2b (4 October 2026).** Described in [stock rules](../stock-rules.md#phase-2b-implementation). Rule references deliberately differ from the "ask now" statistics: they exclude today, so a crossing means a new level. Rule alerts use their own outbox table, so a rollback cannot break daily-drop alerts. Close-based rules add one closing quote per stock and day; the daily-drop path never uses it.
- **Defects found while testing.** The state upsert needed explicit parameter casts: PostgreSQL error 42P08 was caught by the monitor's guard and logged as `stock.rules_failed`. Two test assumptions were wrong: a 21% fall also trips the default daily-drop alert, and `watchlist_add`'s search spends a shared credit.

- **Independent review of `e55b3c9`.** Opus 5.5 returned **REQUEST CHANGES**, with two blocking findings:
  - history-based rules starved once 7 or more stocks were polled together;
  - a delayed pre-close quote could be accepted as the close.

  It also raised eight non-blocking findings: long cadences and extended-hours stocks skipping close rules, a pause race in delivery, held alerts blocking the queue, a failing rule aborting the others, rule checks delaying daily-drop alerts, the cost alert wording and duplicate margin updates. All were fixed with regressions.

## Verification and outcome

- **Live check, 4 October 2026, with the public demo key.** Daily `outputsize=300&order=asc` for AAPL returned the latest 300 sessions (2025-07-25 to 2026-10-02).
- **Tests.** Synthetic tests cover the statistics, the monotonic credit windows, the tie dates, stale and short history, weekend completion, resolution and caching, and busy and degraded results. Nothing is deployed yet.

## Follow-up and next iteration

Phase 2b (rules and migration 027) and Phase 2c (digest).

### Release closure — 3 October 2026

[PR #161](https://github.com/akhilvuputuri/chief-agent/pull/161) merged at `7e8198517c141b0e64b93cf1d87f16001b9f2876`, with independent approval of exact head `b80ca55` and CI passing on that head. The [automatic release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37137918493) and server checks verified that exact `RELEASE`, a healthy gateway and Twelve Data configured. No schema change. Released in v0.3.37. Pending: owner acceptance of a live question; Phase 2b and Phase 2c.
