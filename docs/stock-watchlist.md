# Stock watchlist: daily-drop alerts (issue #46)

The owner keeps a small list of stocks and is alerted in Telegram when one drops
more than its threshold versus the previous trading-session close. Monitoring is
a deterministic in-process poller — no model calls, no routines and no LLM per
poll — so alerts are cheap and explainable. The conversational agent only
manages configuration.

## Setup

1. Create a free [Twelve Data](https://twelvedata.com/) API key (free plan:
   8 credits/minute, 800 credits/day, US-listed symbols, delayed quotes).
2. Set `MARKET_DATA_PROVIDER=twelvedata` and `TWELVE_DATA_API_KEY` in `.env`.
   An empty `MARKET_DATA_PROVIDER` disables the feature entirely: no scheduler
   work, no `watchlist_*` tools offered, no provider calls. On a paid Pro+ plan
   only, `MARKET_DATA_EXTENDED=true` additionally enables extended-hours
   monitoring (`prepost` quotes); the free plan leaves it unset.
3. Apply migration `018_watchlist.sql` through the reviewed operator procedure
   (`scripts/deploy-watchlist.py`, see below). The gateway refuses to start if
   runtime_migrations lacks version 18.

## Conversational management

`watchlist_add(query,exchange?,dropPct?)` resolves the instrument via the
provider symbol search. If several exchanges match, the tool returns candidates
and the agent must ask the owner to pick — it never silently chooses an
exchange. `watchlist_list` shows items with effective thresholds, the latest
alert and the last observation verdict. `watchlist_update` changes a per-stock
threshold (`null` restores the account default) or pauses/resumes one item.
`watchlist_remove` deletes the item with its alert/observation history.
`watchlist_settings` sets the account default drop percentage, a master pause,
the poll cadence (5–240 minutes, default 15) and extended-hours opt-in. The
opt-in is refused unless the provider can actually serve `prepost` quotes
(`MARKET_DATA_EXTENDED`, Pro+ plan); free-plan watchlists stay regular-hours.

Both `watchlist_settings` and `watchlist_update` accept a monitoring `window`;
see [Monitoring windows](#monitoring-windows).

Mutations are foreground-only: a background routine or scheduled job cannot
change the watchlist, matching the routine-management boundary.

## Alerting semantics

- **Trigger**: `(observed price / previous trading-session close − 1) × 100`
  drops strictly below the item's threshold (default 5%). The comparison uses
  the price and the trigger level `prevClose × (1 − threshold/100)` directly, so
  a drop exactly at the threshold does not alert.
- **Session gate**: trading sessions come from a built-in US market calendar
  (`src/market-calendar.ts`, America/New_York) — the provider's
  `/exchange_schedule` endpoint is Ultra-tier at 100 credits/call, which the
  free plan cannot serve. The calendar encodes regular hours (09:30–16:00, or
  13:00 on early closes), weekends and the NYSE holiday list, so symbols on
  exchanges without a calendar (non-US MICs) are rejected at add time. Regular
  hours only unless the owner opts into extended sessions; opted-in items then
  use the extended quote's price and percent change for the comparison, and an
  item whose extended quote is missing or stale is skipped rather than
  silently compared against the regular-session price.
  Nasdaq listing segments `XNGS`, `XNMS` and `XNCM` use the same US sessions
  as operating MIC `XNAS`; the provider's original segment MIC is retained
  for instrument identity and quote requests. Unknown/non-US MICs still fail
  closed. See the [ISO MIC registry](https://www.iso20022.org/market-identifier-codes).
- **Once per stock per trading day**: at most one alert row per
  `(item, trading_date)`; repeated breaches the same day are logged as
  `suppressed_today`. A new trading day may alert again. Enabling a watch that
  is already breached alerts once on the next valid observation.
- **Data hygiene**: missing quotes, non-positive price/previous close, currency
  mismatches and stale timestamps (older than `max(2×poll, 20 minutes)`, or
  more than 5 minutes in the future) are logged and skipped; freshness uses the
  provider's `last_quote_at` (the last update time), not `timestamp`, which is
  the interval's opening time. Moves of ≥40%
  without provider corroboration (`percent_change` within 3 points) are logged
  `suspect` and suppressed — likely a split/adjustment artifact.
- **Alert content**: company, ticker, exchange, observed price and currency,
  percent decline, previous close, quote time in the exchange timezone with a
  delayed marker, session (regular/extended), provider name, threshold basis
  and a quote-page link, with buttons to pause that stock or all stock alerts.

## Monitoring windows

Added for the owner's request to watch only "from the open until midnight
Singapore time" (migration 020, [journal 39](journey/39-watch-monitoring-window.md)).

- `window={start:"HH:MM", end:"HH:MM"|"24:00", days?:["mon",…]}` in
  **Asia/Singapore** time. An end at or before the start runs past midnight and
  belongs to the day it starts on (`22:00–02:00` on `fri` covers Fri 22:00 →
  Sat 02:00); `24:00` is midnight at the end of the day. Seven days is stored as
  "every day".
- `watchlist_settings(window)` sets the owner default; `watchlist_update(id,window)`
  sets a per-stock override. `null` clears the default, or makes a stock follow
  the default again. A stock that should ignore the default uses
  `00:00–24:00`.
- The window is applied **on top of** the exchange session: a quote is fetched
  only when both are open. "Open until midnight" is therefore any start at or
  before the open (e.g. `20:00`) with end `24:00`; this covers 21:30–24:00 SGT
  in US daylight time and 22:30–24:00 SGT in US standard time.
- Confirmations and `watchlist_list` return `nextChecks`: the next periods, in
  SGT, when each stock will actually be checked, computed from the market
  calendar and the window.
- **Outside the window** no quotes are fetched (saving provider credits) and a
  single `outside_window` observation marks the transition. When the window
  reopens the first tick polls immediately, and alerts only if the stock is
  still below its threshold against the previous close for that trading day.
  A drop that recovers while the window is closed is not reported. This was the
  owner's choice over holding alerts for later delivery.
- Delivery rechecks the window: an alert queued just before the window closes
  and not yet sent is muted (`outside_window` observation with its alert id),
  not delivered late, and it still counts as that trading day's alert. An alert still
  pending from an earlier window occurrence (for example across a gateway
  outage) is muted too, rather than sent when the next window opens.
  An alert muted only because the window closed before it was sent is marked
  `windowMuted`. If the window reopens within the same US trading day and the
  stock is still below its threshold, that alert is re-armed and sent. Alerts
  muted by a pause still keep the day silent.
- At the open, a delayed feed can still return the previous session's quote,
  which is logged as `stale`. On the first poll after a gate, that result is
  retried after 15 minutes instead of waiting the whole interval, once per
  opening.
- Gated checks (market closed or outside the window) no longer consume the
  poll cursor, so with a 60-minute cadence the first check happens at the open
  rather than up to an hour later. The gate is logged once per transition and
  cached in memory, so gated items are not re-queried each tick.

## Provider limits

Free-plan calls: symbol search at add time, then batched `/quote` requests —
no calendar calls at all. Batches are paced against the provider's
credits/minute allowance (8 on free), which Twelve Data resets at each minute
boundary rather than refilling continuously: at most 8 symbols per request,
and items left unfetched when the window empties wait for the next boundary
(polled in last-polled order). At the default 15-minute cadence a US watchlist uses about
26 quote calls per symbol per day, so ~10–15 symbols fit inside 800/day.
Non-US listings typically require a paid plan and have no built-in calendar;
`watchlist_add` rejects them and surfaces the provider's `access` field when a
symbol is marked paid-tier only. The monitor never buys data and there is no
paid fallback.

## Failure and observability

Every poll writes a bounded `stock_observations` row (latest 200 per item):
observation time, quote time, price, reference close, computed change, market
state, the decision (`alerted`, `below_threshold`, `suppressed_today`,
`market_closed`, `outside_window`, `stale`, `invalid`, `suspect`, `error`) and detail including
the threshold and suppression reason. `watchlist_list` exposes the latest
observation per item.

Provider failures back off per item: `error_count` doubles the delay from the
poll interval up to a 4-hour cap via `next_retry_at`, and a successful poll
resets it. A failure the provider marks non-retryable (e.g. a symbol the free
plan cannot serve) pauses the item instead of retrying, so a permanent error
does not quietly consume daily credits; resuming re-enables it. Twelve Data can
report errors with HTTP 200 and the real status in the body `code`: body
`429` (credits exhausted) and `5xx` back off like transport failures, while
other body codes (400/401/403/404) pause the item. This applies to errors
covering the whole request. A per-symbol error row inside a successful batched
response is currently dropped and logged `invalid` ("provider returned no
quote") without pausing, so that item keeps being polled. Pausing an
item — via `watchlist_update`, `watchlist_settings`, or the alert's pause
button — also terminal-mutes any still-`pending` alert so a queued
notification cannot deliver after the pause. Two further races are closed:
the monitor rechecks item status and the master pause right before inserting
an alert (a pause landing while the quote request was in flight becomes
`suppressed_today`, leaving no alert row — resuming can still alert that
day), and delivery first mutes pending rows of newly-paused items then
claims only alerts whose item is active and unpaused (a `muted` row keeps
the day silent even after resume, matching the once-per-day dedupe). The
monitor's outer tick is guarded so a stuck tick never overlaps.

Alerts follow the same outbox contract as routine delivery:
`pending → sending → sent`; an exception or restart during send becomes
`uncertain` and is never retried automatically (Telegram may already have shown
it). `StockDelivery.recover` runs at startup; an operator can inspect uncertain
rows in `stock_alerts` and reset them to `pending` deliberately.

## Deployment (operator-reviewed migration 018)

1. Independently review the exact PR head and run `npm run check` plus
   changed-file formatting. Review `scripts/deploy-watchlist.py` too.
2. Merge only after approval and CI. The ordinary release refuses the
   DB/Compose change.
3. Verify live `RELEASE` is one of the script's reviewed baselines (the
   `BASES` set in `scripts/deploy-watchlist.py`: the verified v0.3.15 release,
   its record commit, or the v0.3.16/v0.3.17 library releases). If newer,
   reconcile and re-review the operator script; do not bypass the guard.
4. Transfer a Git archive of the exact reviewed main SHA and the reviewed
   operator script using the existing local operations connection. Run
   `python3 deploy-watchlist.py ARCHIVE SHA` on the host. It validates
   historical migrations and Compose, locks releases, builds before stopping,
   refuses active work/input, applies only 018 and checks health. Add
   `TWELVE_DATA_API_KEY` to the host `.env` (never committed) before or after
   rollout; without it the feature stays inert.
5. Verify release SHA, health, migration marker `18` and preservation of
   existing records. No paid plan and no live alert is created by the rollout.

Rollback restores the previous application/Compose/source, retaining the
additive watchlist tables and any alerts already recorded. Never delete
watchlist state or replay uncertain deliveries during recovery.

## Deployment (operator-reviewed migration 020, monitoring windows)

Same shape as 018/019: independent review of the exact head, `npm run check`,
`python3 scripts/test-deploy-watch-window.py`, then merge (the ordinary release
refuses the DB/Compose change). Verify live `RELEASE` is in `BASES` of
`scripts/deploy-watch-window.py`; if newer, reconcile and re-review the script.
Transfer the exact main archive and script and run
`python3 deploy-watch-window.py ARCHIVE SHA` on the host. It applies only 020
with the gateway stopped and checks health; rollback keeps the additive columns.
The gateway refuses to start without migration 20.
