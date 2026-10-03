# 60 — How can one stock agent answer, watch and report on the owner's own stock questions?

Work date(s): 2026-10-03 to 2026-10-04. Written/revised: 2026-10-04.
Status: plan agreed; Phase 2a (statistics layer, shared credits, `stock_lookup`) implemented and tested, pending review. Nothing deployed.

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

## Verification and outcome

Pending.

## Follow-up and next iteration

Phase 2b (rules and migration 027) and Phase 2c (digest).
