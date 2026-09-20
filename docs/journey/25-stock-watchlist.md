# 25 — Stock watchlist drop alerts

Work date(s): 2026-09-20. Written/revised: 2026-09-20.
Status: implemented and tested; PR review and deployment pending. State the current outcome and limitations; add the dated release closure below when verified.

## User-visible problem and preceding iteration

[Issue #46](https://github.com/akhilvuputuri/companion-agent/issues/46): the owner wants a configurable stock watchlist that alerts in Telegram when a stock drops more than its threshold versus the previous trading-session close, managed conversationally, once per stock per trading day.

The preceding iteration was [24 — Scheduled independent agent work](24-scheduled-routines.md), which shipped the routine foundation (v0.3.15) and explicitly deferred data feeds and conditional notification delivery to domain issues.

## Evidence

- **Design review (tested/documented)**: issue #46 requires "no model tokens per poll" and "notify only if triggered". A `routine_*` occurrence runs a full agent task per occurrence, so the routines contract cannot satisfy the issue; the routines runbook itself says data feeds and conditional silence belong to the domain. Chosen instead: a deterministic `StockMonitor` tick inside the existing 15-second worker interval, plus a `stock_alerts` outbox mirroring `RoutineDelivery`. Reported as design decision, documented in [stock-watchlist.md](../stock-watchlist.md).
- **Provider selection (owner decision)**: the owner selected Twelve Data's free tier, accepting the US-only watchlist scope (issue required no paid data without approval).
- **Provider limits (documented)**: free plan is 8 credits/minute and 800 credits/day with delayed quotes; symbol-search `access` metadata is surfaced on add when a listing needs a paid plan.
- **Synthetic checks (tested)**: 16 new PGlite/mocked tests in `tests/stocks.test.ts` cover below/exact/above threshold, per-item overrides, already-breached activation, trading-day rollover, closed markets, holidays, session boundary, stale/missing/invalid quotes, split-artifact suppression, per-item backoff, restart recovery, duplicate suppression, extended-hours opt-in, the foreground-only boundary and provider gating. These verify implementation logic only — not real quote timeliness, Telegram delivery or provider availability.
- **Rollout procedure (tested)**: `scripts/test-deploy-watchlist.py` runs 13 offline checks against `scripts/deploy-watchlist.py` (baseline guard, additive-only migration, exact Compose additions, rollback paths).

## Diagnosis and alternatives

- **Polling vs event feeds**: no free official push/stream exists for this use case; polling at a configurable cadence with a per-day dedupe is the bounded option. Rejected alternatives: a routine-driven LLM check (violates the no-token and conditional-silence requirements), and unofficial Yahoo scraping (fragile, undocumented).
- **Ambiguity**: ticker search hits can span exchanges; the tool returns candidates and the agent must ask rather than guess — instruments differ across exchanges even with the same ticker string.
- **Session/calendar correctness**: exchange schedules (with timezone, holidays, DST) come from the provider and are cached per trading day in `stock_exchange_hours`, so a holiday produces `market_closed` observations instead of quote calls.
- **Threshold semantics**: the issue's "drops more than" is implemented strictly — a decline exactly equal to the threshold does not alert.
- **Split artifacts**: computed moves of ≥40% that the provider's own percent_change does not corroborate are suppressed as `suspect`; a corroborated crash still alerts.
- **Failure handling**: per-item exponential backoff bounded at 4 hours, so one failing symbol does not block others and a rate-limit burst does not hammer the provider.

## Implementation and review

- `db/018_watchlist.sql`: `stock_settings`, `watchlist_items` (user+symbol+mic unique, cascading cleanup), `stock_alerts` (unique per item+trading_date, outbox states incl. `muted`), `stock_observations` (bounded decision log), `stock_exchange_hours` (per-day schedule cache).
- `src/stock-provider.ts`: provider interface plus a Twelve Data implementation (symbol search, batched quotes, exchange schedule; 15s timeout; retryable 429/5xx).
- `src/stocks.ts`: `WatchlistTools` (foreground-only mutations, owner-scoped, ambiguity-aware add), `StockMonitor` (session gate, quote validation, strict threshold compare, once-per-day dedupe, per-item backoff, bounded observations), `StockDelivery` (pending→sending→sent/uncertain outbox, recovered on boot).
- `src/telegram.ts`: `stk:` callback buttons on alerts pause the single stock or all alerts — direct owner-scoped writes, never queued behind the model.
- `compose.yaml`: migration entry plus `MARKET_DATA_PROVIDER`/`TWELVE_DATA_API_KEY` passthrough; the feature is inert without them.
- `scripts/deploy-watchlist.py` + offline tests: operator-only rollout reusing the migration-017 procedure shape.

Review outcome: independent review of head `26e29df36d188aeaba653a7ada9a5e3dd1e45e0e` returned APPROVE (Devin reviewer session, `npm ci` + `npm run check` + rollout tests all green at that SHA) with three low findings; two were fixed in the follow-up head (pausing now terminal-mutes a queued alert, and non-retryable provider errors pause the item instead of looping on a schedule) with a re-review required on the updated head before merge.

## Verification and outcome

- `npm run check`: 328 tests pass (all existing suites plus the new watchlist and offline rollout tests); typecheck clean; changed files formatted.
- During development, adding five tool operations grew the fixed prompt enough to evict a saved-answer retrieval marker in `custom-runtime.test.ts`; resolved by gating `watchlist_*` operations behind `availability.stocks` so they are only offered when a provider is configured — the right behavior regardless of test pressure.
- Not verified: live Twelve Data responses, real Telegram alert delivery, production poll cadence. First live acceptance is an owner watch on a US stock during a session.

### Release closure — pending

PR, approved head, deployed SHA, release run and health evidence to be appended after the review loop and the reviewed operator rollout.

## Follow-up and next iteration

- Non-US listings need a paid plan or a different provider decision; the schema keeps `mic_code`/`exchange` so the choice is per-instrument, not global.
- News digest/feedback ranking remains domain work on the routine contract.
- If delayed quotes prove too slow for the owner's use, the provider adapter boundary allows a swap without touching the monitor.
