# 39 — Stock monitoring hours in Singapore time

Work date(s): 2026-09-27. Written/revised: 2026-09-27.
Status: tested; in review. Needs migration 020 through the reviewed operator procedure. Not deployed.

## User-visible problem and preceding iteration

The stock watchlist ([25](25-stock-watchlist.md)) polls US listings during the exchange's regular session at a configurable interval. On 27 September 2026 the owner asked (in Telegram) to monitor only "from the opening until 12 midnight Singapore time, once every hour", because they sleep after midnight. The assistant correctly set the interval to 60 minutes and said it could not stop alerts after midnight. The US regular session runs about 21:30–04:00 SGT in US daylight time (22:30–05:00 in standard time), so an alert at 2am SGT was possible.

## Evidence

- **Owner report and production inspection (observed, read-only, 27 September 21:14–21:18 SGT):** the tool journal shows `watchlist_list`, then `watchlist_settings(pollMinutes=60)`, then the assistant's accurate "can't set which hours" reply. One watch was active. No alert had been sent; the only recorded observation was `market_closed`.
- **Code reading:** `stock_settings` held `default_drop_pct`, `paused`, `poll_minutes` and `include_extended` only; `StockMonitor.tick` gated on the exchange calendar alone.
- **Secondary finding (code reading, tested):** a gated check (market closed) wrote `last_polled_at`, so with a 60-minute cadence the first check after the open could come up to an hour late. The existing 09:10 → 09:30 ET boundary test passed only because it used the 15-minute default.

## Diagnosis and alternatives

- The window is **applied on top of** the exchange session rather than replacing it, because the owner's "from the opening" is the exchange's open. "Open until midnight" is expressed as `20:00–24:00`, and the confirmation shows the combined result (`Mon 28 Sep 21:30–24:00 SGT`) so the owner does not have to combine two rules in their head.
- **Drops outside the window (owner decision, 27 September):** skip polling and recheck at reopen. The alternative was to keep polling silently and hold a "while you were away" alert until the window reopened. The owner chose skipping: it uses no provider credits outside the window, and a stale alert up to about 20 hours late has little value. Consequence: a drop that recovers while the window is closed is never reported. Because the next window usually opens on a new US trading day, a drop late in one session is compared against that session's close on the following day.
- Owner default plus per-stock override (`null` inherits). Fixed `Asia/Singapore`, which has no DST; US DST is handled by the existing calendar and the intersection.
- Delivery rechecks the window. An alert queued at 23:59:50 whose send would land after midnight is muted instead of sent late.

## Implementation and review

- `db/020_watch_window.sql`: additive nullable `window_start/window_end/window_days` on `stock_settings` and `watchlist_items`, with all-or-none CHECKs. The one non-additive statement widens `stock_observations_decision_check` with `outside_window`; older images never write it.
- `src/watch-window.ts`: validation, `inWindow` (an overnight span belongs to its start day; `24:00` is the end of the day), and `upcomingChecks` (session ∩ window intervals, formatted in SGT).
- `src/stocks.ts`: the window gate in `tick`; gated checks no longer consume the poll cursor, and the gate is logged once per transition with an in-memory cache; delivery mutes a late alert; `watchlist_settings`/`watchlist_update` accept `window` and return `nextChecks` and the outside-window rule; `watchlist_list` shows the effective window.
- `src/protocol.ts`, `src/runtime.ts`: schema and tool descriptions. The picker description is unchanged, so no picker eval was needed.
- `src/main.ts`: refuses to start without migration 20. `compose.yaml`: migration entry.
- `scripts/deploy-watch-window.py` and its offline tests: the migration-019 procedure with only its constants changed. The single allowed baseline is the live release. That was `211b657` when first written, and became `7e6e62c` after #107 was released (that release changed no db/ or Compose file), so the script was rebased onto it.

**Review round 1 (Devin Review, automated, on `d25956a`):** two valid findings. (1) A pending alert that survived a gateway outage would be sent when the _next_ window occurrence opened, which delivers a stale drop. Delivery now also mutes an alert created before the current window occurrence began (`windowOccurrence`). (2) `watchlist_settings` wrote the other fields before validating the window, so a rejected window still changed, for example, the poll interval. The window is now validated first and all fields are written in one statement. Both have regression tests.

**Review round 2 (Opus 5.5, independent, on `d25956a`): APPROVE, with one P2 and three P3s.** The approval is historical, because the head has changed since.

- (P2) With 60-minute polling, the first check now fires exactly at the open. There, a ~15-minute-delayed quote is most likely still yesterday's, so it is `stale` and the hour is spent. The first stale result after a gate now retries after 15 minutes.
- (P3) Settings were not atomic; this was already fixed in round 1.
- (P3) An alert muted by the window blocked a re-alert when the window reopened within the same trading day. It is now re-armed (`windowMuted`); pause-muted alerts keep the day silent.
- (P3) `days: null` is now accepted.

Each has a regression test. The reviewer's own probes confirmed DST and holiday handling in `upcomingChecks`, the overnight and 24:00 edges, idempotency and NULL behaviour of the CHECK constraints, and that the rollout script changes only constants.

**Review round 3 (Opus 5.5, on `9cfa1a6`): APPROVE, with three P3s.**

- An all-day window (00:00–24:00) muted an alert queued at 23:59:59 and sent after midnight. Touching occurrences now count as one span.
- The early retry is lost after a restart or when the credit budget defers the first tick. The worst case is the earlier behaviour, and this is accepted.
- The re-arm now checks that its UPDATE matched before logging `alerted`.

Afterwards the branch was rebased onto `7e6e62c` (#107). The journal became 39 because main already has a 38, and the rollout baseline became `7e6e62c`.

## Verification and outcome

- Synthetic (PGlite, mocked provider): 7 new tests. They cover validation, overnight and weekday ownership, DST-correct `nextChecks` (21:30 SGT in September, 22:30 SGT in January, MLK Day skipped), the owner's scenario (checked at 23:30 SGT, silent at 00:30 with one `outside_window` row and no quote call, alert at the next reopen when still down), a recovered drop that is not reported, the first poll at the open with a 60-minute cadence, override/inherit/clear, and a late alert muted at delivery. The full `npm run check` passed 453 application and 21 script tests. The 14 offline rollout tests passed. Migration 020 applied twice in PGlite, and the CHECKs rejected a partial window, an unknown day and start = end.
- Not verified: live behavior, real quote timing at the open, and owner Telegram acceptance.

## Follow-up and next iteration

Pending: independent review, merge, operator rollout of migration 020, then asking the owner to set the window in Telegram and confirming the stored settings and `nextChecks`.
