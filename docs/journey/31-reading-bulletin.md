# 31 — Daily reading bulletin: how can a feed learn from explicit votes without a model per edition?

Work date(s): 2026-09-23. Written/revised: 2026-09-23.
Status: implemented and tested; independent review, merge and the operator rollout of migration 019 pending. No feeds, interests or schedule have been configured in production.

## User-visible problem and preceding iteration

[Issue #50](https://github.com/akhilvuputuri/chief-agent/issues/50) asks for five useful readings a day in Telegram, each with Like / Dislike, where later selections improve from that explicit feedback. Interests, sources and delivery time must be obtained from the owner, not assumed.

Preceding iterations: [24 — Scheduled routines](24-scheduled-routines.md) supplied a timer for agent jobs and explicitly left feeds and ranking to domain work; [25 — Stock watchlist](25-stock-watchlist.md) showed that a deterministic in-process monitor with its own outbox fits better when a model call per run is unnecessary and the output needs buttons.

## Evidence

- **Design review (documented)**: a routine occurrence runs the full agent and delivers model prose. That would cost model usage every day, could not attach per-item callbacks to its answer, and could produce a different selection when retried. The bulletin therefore reuses the watchlist pattern — a deterministic tick on the existing 15-second timer and a persisted edition outbox — instead of the routine executor. The owner's issue comment asked domain features to use `routine_*` for owner-selected times; this entry records the deviation and its reason, as journal 25 did.
- **Synthetic checks (tested)**: 19 PGlite/mocked tests in `tests/reading.test.ts`: RSS/Atom/CDATA/entity parsing with hostile markup, bidi characters, `javascript:` links, DTD entities and future/missing dates; URL canonicalization; the DNS guard against private, metadata and mapped addresses; explicit-configuration gating, foreground-only mutation and owner scope; edition content (five distinct stories, duplicate cluster collapsed, discovery pick, excerpt/reason/link, callback length); explicit shortfall with a failed feed; owner-bound, replay-safe buttons with change/undo and restart persistence; hard mutes versus weak dislikes; offline ranking fixtures (neutral no-feedback items, likes moving similar candidates, bounded/decaying weights, reason targeting, overrides, diversity caps, labelling); scheduler timezone/day boundaries, DST, latest-only catch-up, database-level duplicate refusal and allowlist; all-feeds-failed retry then disclosure; uncertain delivery never resent; pause muting; override/reset/explain/metrics. These verify implementation logic, not real feeds, Telegram rendering or reading quality.
- **Rollout procedure (tested)**: `scripts/test-deploy-reading.py` runs 12 offline checks against `scripts/deploy-reading.py` (exact v0.3.22 baseline, additive-only 019, exact Compose addition, rollback paths). The script differs from the reviewed watchlist script only in baseline, migration name/marker and the absence of environment changes.
- **Development failures (tested)**: the first run failed four tests. Two were real defects: feed-add wrote `last_fetched_at` with database time instead of the injected clock, so later refreshes were wrongly treated as cached; and a per-topic cap blocked source diversity when the owner has a single dominant interest (selection now relaxes the topic cap before the source cap). Vote timestamps and edition creation time now also use the injected clock, which a reset test exposed.

## Diagnosis and alternatives

- **Model summaries vs feed excerpts**: v1 shows the feed's own description, labelled “Feed excerpt”, or says only the headline was available. This is the most grounded option with no model cost; it is not a full-text summary. A cached model summary per selected item remains possible later.
- **Direct feed fetch**: other retrieval goes through hosted providers. RSS must be read as XML repeatedly, so the gateway fetches feeds itself behind a connection-time DNS guard (any non-public answer refuses the connection) plus the existing public-HTTPS hostname check. This is a new egress path and a review focus.
- **Learning rule**: a pure function of current votes (like +1/+0.5, more +2/+1, plain dislike −0.3/−0.15, reasons target topic or source), 30-day half-life, ±3 per key, ±1.5 total effect. Rejected: incremental counters (double counting on replay/undo), model fine-tuning, and blacklisting on dislike. A mute is the only hard exclusion and is always an explicit owner action.
- **Diversity and discovery**: near-duplicate titles cluster (Jaccard ≥ 0.6), at most two per source and topic when alternatives exist, and one discovery slot for non-interest items that are not disliked. Fewer items are delivered rather than padding.
- **Topic matching is lexical** (phrases and owner keywords). Semantic classification would need a model call per candidate; deferred until lexical misses are observed.

## Implementation and review

See [the runbook](../reading-bulletin.md). `db/019_reading.sql` adds settings, feeds, candidates, preference versions, editions (unique per owner-local date for scheduled editions), items, votes and feedback events. `src/reading-feed.ts` parses and fetches; `src/reading.ts` ranks, learns, builds, schedules, delivers and handles buttons; seven `reading_*` tools are offered only when migration 019 is present. `src/telegram.ts` adds the `rd:` callback handler; `src/main.ts` wires the scheduler and outbox behind the migration check; `compose.yaml` lists migration 019.

Independent review: pending.

## Verification and outcome

- Tested 23 September 2026 at the PR head: `npm run check` passed (typecheck; 362 application tests including the 19 reading tests; 10 script tests). `python3 scripts/test-deploy-reading.py`: 12 passed. `npm run format:check` clean. Package version bumped to 0.3.23 per the patch-only policy (candidate; not a release).
- Not verified: real feeds, delivery time on the phone, button rendering, excerpt quality, and whether votes improve perceived usefulness. Like rate and rating coverage start accumulating only after activation; a few votes are not evidence of improvement.

### Release closure — pending

Requires independent approval of the exact PR head, merge, the reviewed operator rollout of migration 019 from baseline `c936d7d` and verification of release SHA, health and migration marker. The owner then configures interests, feeds, time and timezone; first acceptance is an on-demand preview followed by one scheduled edition.

## Follow-up and next iteration

- Compare `inBaseline` picks against feedback-only picks once enough items are rated.
- Consider optional cached model summaries and semantic topic tagging if feed excerpts or lexical matching prove weak.
- Public search as a candidate source and plugin packaging remain deferred.
