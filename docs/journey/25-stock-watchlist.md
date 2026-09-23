# 25 — Stock watchlist drop alerts

Work date(s): 2026-09-20, 2026-09-23. Written/revised: 2026-09-23.
Status: merged and installed with migration 018 during the v0.3.19 rollout (see [27](27-multiple-gmail-accounts.md#verified-release--21-september-2026)); provider not yet configured on the host, so monitoring is inert. A 2026-09-23 follow-up below fixes error classification before activation.

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
- **Session/calendar correctness**: an external review round found Twelve Data's `/exchange_schedule` is Ultra-tier at 100 credits/call — unusable on the free plan the owner approved. Replaced with a built-in US market calendar (`src/market-calendar.ts`: regular 09:30–16:00, 13:00 early closes, NYSE holidays; non-US MICs rejected at add). A consequence: only US exchanges are coverable until a second calendar is added.
- **Threshold semantics**: the issue's "drops more than" is implemented strictly — a decline exactly equal to the threshold does not alert.
- **Split artifacts**: computed moves of ≥40% that the provider's own percent_change does not corroborate are suppressed as `suspect`; a corroborated crash still alerts.
- **Failure handling**: per-item exponential backoff bounded at 4 hours, so one failing symbol does not block others and a rate-limit burst does not hammer the provider.

## Implementation and review

- `db/018_watchlist.sql`: `stock_settings`, `watchlist_items` (user+symbol+mic unique, cascading cleanup), `stock_alerts` (unique per item+trading_date, outbox states incl. `muted`), `stock_observations` (bounded decision log).
- `src/market-calendar.ts`: built-in US sessions/holidays (the provider calendar endpoint is Ultra-tier).
- `src/stock-provider.ts`: provider interface plus a Twelve Data implementation (symbol search, credit-batched quotes with optional `prepost`; 15s timeout; retryable 429/5xx).
- `src/stocks.ts`: `WatchlistTools` (foreground-only mutations, owner-scoped, ambiguity-aware add, non-US rejection), `StockMonitor` (static-calendar session gate, quote validation, strict threshold compare, once-per-day dedupe, credit pacing, enqueue pause recheck, per-item backoff, bounded observations), `StockDelivery` (pending→sending→sent/uncertain outbox with pause-aware claim, recovered on boot).
- `src/telegram.ts`: `stk:` callback buttons on alerts pause the single stock or all alerts — direct owner-scoped writes, never queued behind the model.
- `compose.yaml`: migration entry plus `MARKET_DATA_PROVIDER`/`MARKET_DATA_EXTENDED`/`TWELVE_DATA_API_KEY` passthrough; the feature is inert without them.
- `scripts/deploy-watchlist.py` + offline tests: operator-only rollout reusing the migration-017 procedure shape.

Review outcome: independent review of head `26e29df36d188aeaba653a7ada9a5e3dd1e45e0e` returned APPROVE (Devin reviewer session, `npm ci` + `npm run check` + rollout tests all green at that SHA) with three low findings; two were fixed in the follow-up head (pausing now terminal-mutes a queued alert, and non-retryable provider errors pause the item instead of looping on a schedule). Re-review approved `bc0a7fb`, then `3b71556` and `4a8fec6` after rebase.

External review (second reviewer, owner-reported) then found five substantive defects at `4a8fec6`, reproduced where indicated: (P1) `/exchange_schedule` is Ultra/Enterprise at 100 credits/call — the free plan cannot run it; (P1) freshness used `timestamp`, the interval open, so fresh declines were discarded as stale — now `last_quote_at`; (P2) a pause landing while the quote request is in flight could still deliver — enqueue now rechecks status/pause and the delivery claim re-joins active+unpaused with a pending-mute sweep; (P2) `prepost=true` was never sent and is Pro+-only — extended opt-in is gated on `MARKET_DATA_EXTENDED`, extended quotes validated by their own timestamp, and missing extended data skips instead of substituting the regular price; (P2) batches could exceed 8 credits/minute — a shared token bucket now chunks requests at the provider's rate. The `stock_exchange_hours` cache table was dropped from migration 018.

A second external round then found: (P2) the token bucket refilled continuously while Twelve Data resets the allowance at each minute boundary — replaced with a boundary-aligned window; and (P2) freshness was checked on the regular `quoteTime` before considering the extended quote, discarding fresh post-market prices — the active session's own timestamp is now selected first. A third round found: (P2) credits were debited only on success, so a timed-out request freed credits it may have consumed — now reserved before dispatch; and (P2) the extended path still used the regular quote's metadata downstream, storing a Friday pre-market alert under Thursday — the selected session's timestamp now feeds dedupe, observations and alert text. Each round superseded prior approval; the final head was re-approved.

## Verification and outcome

- `npm run check`: all tests pass (existing suites plus the watchlist and offline rollout tests); typecheck clean; changed files formatted. New regression tests cover: `last_quote_at` freshness, pause-during-poll suppression, claim-time pause recheck, ≤8-credit batch pacing, non-US MIC rejection and the extended-opt-in plan gate.
- During development, adding five tool operations grew the fixed prompt enough to evict a saved-answer retrieval marker in `custom-runtime.test.ts`; resolved by gating `watchlist_*` operations behind `availability.stocks` so they are only offered when a provider is configured — the right behavior regardless of test pressure.
- Not verified: live Twelve Data responses, real Telegram alert delivery, production poll cadence. First live acceptance is an owner watch on a US stock during a session.

### Release closure — pending

[PR #63](https://github.com/akhilvuputuri/companion-agent/pull/63), CI green. Independent reviewer (Devin session) verdicts, recorded on the PR: APPROVE on `26e29df`, `bc0a7fb`, `3b71556`, `4a8fec6`, `6ea1ac5` (first external round), `1d10d7c` (post-review hardening), `87f6e90` (docs-only), `9e4ae43` (second external round: boundary-reset pacing + session-aware freshness), `3283a08` (docs-only), and final head `d0cf9ce70bc0345459bcbc4331a782ba411b7db2` (third external round: credit pre-reservation + session timestamp carried through dedupe/alert). Merge and the reviewed operator rollout (migration 018, `TWELVE_DATA_API_KEY` on the host) are still outstanding — the ordinary release will refuse the DB/Compose change by design.

### Follow-up — 2026-09-23: body error codes before activation

- **Observation (code reading, not a live response)**: the owner supplied a Twelve Data key for activation. Before it goes live, reading `TwelveDataProvider.get` showed that a JSON body with `status: "error"` was classified retryable only when the HTTP status was ≥500, which had already been handled one line earlier, so every body-reported error was non-retryable. Twelve Data reports the real status in the body `code`, including credit exhaustion (`429`). If that arrives with HTTP 200, the first exhausted minute or day would pause every item in the batch as a "non-retryable provider error", and the items would stay paused until resumed by hand.
- **Change**: body `code` 429 or ≥500 is now retryable (bounded per-item backoff). 400/401/403/404 stay non-retryable and still pause the item, so a symbol the plan cannot serve does not keep using credits.
- **Synthetic check (tested)**: a new test drives the real adapter with mocked `fetch` responses and fails on the previous code (`expected true, actual false`). `npm run check`: 344 + 10 tests pass.
- **Not verified**: the live HTTP status Twelve Data pairs with each body code. The cloud session's network policy denied `api.twelvedata.com`, so no live request was made. The fix is correct whichever HTTP status accompanies the body.
- **Activation boundary**: the key lives only in the host `.env` (`MARKET_DATA_PROVIDER=twelvedata`, `TWELVE_DATA_API_KEY`). The restricted release command refuses `.env` paths and accepts only `deploy <SHA>`/`diagnose`, so a cloud task cannot set it. The operator adds both lines on the host. The gateway reads them when it is next recreated (any release, or a manual gateway recreate).

## Follow-up and next iteration

- Non-US listings need a paid plan or a different provider decision; the schema keeps `mic_code`/`exchange` so the choice is per-instrument, not global.
- News digest/feedback ranking remains domain work on the routine contract.
- If delayed quotes prove too slow for the owner's use, the provider adapter boundary allows a swap without touching the monitor.
