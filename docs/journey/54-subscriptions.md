# 54 — Keeping recurring payments and decision dates together

Work dates: 1–3 October 2026. Written: 1 October; revised: 3 October 2026.
Status: manual milestone released as [v0.3.34](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.34); owner Telegram acceptance and source/monitoring milestones remain separate.

## User-visible problem and preceding iteration

[Issue 132](https://github.com/akhilvuputuri/chief-agent/issues/132) proposes a recurring-payments ledger. The owner requested an implementation plan informed by Dots, Grok Bot, Muse and Manus 2, then directed the feature away from an email focus and authorized the first milestone. The resulting scope is owner statements, a maintained tracker and reminders for renewal/trial/cancellation dates. Source adapters and automatic monitoring remain later work.

This builds on [parcel provenance](33-delivery-tracker.md), [scheduled routines](24-scheduled-routines.md), [typed domain agents](49-coordinator-agents.md) and [feed destinations](53-feed-destinations.md). Those foundations establish durable state and scoped tools; they do not establish subscriptions correctness or account coverage.

## Evidence

- Reported requirement: accepting an ongoing outcome, showing work/decisions and maintaining one artifact should guide the design. Primary references: [Dots responsibilities](https://learn.chatgpt.com/docs/dots/tasks-and-memory), [Grok skills/routines](https://docs.x.ai/grok-bot/skills-routines-and-automations), [Muse design](https://introducing.muse.ai/) and [Manus schedules](https://manus.im/blog/manus-schedules). These describe products, not comparative accuracy measurements.
- Inspected baseline: freshly fetched main `9b76fc5`, then incorporated documentation-only main `78ad212` during implementation. Production operator RELEASE and startup health independently matched `78ad212`; [exact release](https://github.com/akhilvuputuri/chief-agent/actions/runs/36885999446) passed.
- Measured offline on 1 October: all existing integration flags on, empty owner/work state, coordinator with no loaded domains. Tool-schema/runtime-state envelope: 8,092 characters baseline/off; 8,364 on (+272). Three domain schemas: 3,688 characters. Common instructions unchanged; no token/cost/latency inference.
- Synthetic verification: PGlite captures, revisions, retries, mixed-currency rational totals, exact matching, owner/background boundaries, date edits, cancellation, grouped reminders, delivery/recovery and authenticated read APIs. Dense-label/history fixtures check bounded projections and pagination. Operator script has 14 offline tests covering baseline/archive/migration/Compose guards, busy work, health failure and rollback. Full checks passed: 578 application tests, 21 JavaScript script tests and 30 Python tests; formatting and build passed. The 14 operator tests passed separately.
- Local browser verification: real read-only Mini App against synthetic PGlite records and a synthetic Telegram session; list/detail, timeline, currency totals, history and Singapore firing times rendered. Phone-width detail inspected at 390 × 844. This is not real signed Telegram acceptance.

## Diagnosis and alternatives

A subscription needs multiple independent dates. A reminder seven days before renewal can miss an earlier cancellation deadline. Cadence and a last-known amount also do not establish a future charge. The implementation therefore keeps dates explicit and totals labelled normalized estimates.

The ledger is integration-independent, with owner-only provenance in this milestone. Existing Gmail tool history and PDF sources can retain body text, so enabling financial extraction would need a separate persistence/privacy boundary. No claim that generic source ingestion already meets that boundary is made.

The existing reminder scheduler is reused; consistency is enforced by atomically saving ledger/history/linked schedules and checking current revision before delivery. Completed or uncertain attempts remain inspectable and cannot be replayed by a casual edit. A narrow send/edit race remains after the final check and is disclosed.

## Implementation and review

See [subscriptions contract and rollout](../subscriptions.md). New domain schemas/tools, core plugin and picker domain use existing grants and model tiers. The current row and immutable patches retain field provenance and host input references. Mini App routes are authenticated reads, with DOM text rendering rather than executable generated markup.

Initial focused checks exposed an untyped unused SQL parameter and PostgreSQL date serialization differences; both were corrected. The full application/JS checks passed, then the Python picker config validator exposed its separately maintained domain inventory; that inventory was updated. A new provenance fixture needed a real runtime row for the existing input/run ownership FK. Rollout tests were adapted to permit additive `ON DELETE CASCADE` declarations while still refusing destructive migration statements, and now verify paused reminders before app rollback.

### Independent review follow-up — 2 October 2026

GPT-6 Astra independently requested changes at exact head `d0470c0c6899ccd6446fbef716e03fff0cab4da2` in [PR 142](https://github.com/akhilvuputuri/chief-agent/pull/142). Its six adversarial tests reproduced three failures: identical concurrent update retries returned a false revision conflict, two creates at 49 schedules left 51, and restoring a withdrawn started date returned no warning although it stayed unscheduled. It independently passed the original 15 subscription and 14 rollout tests.

Fixes recheck request identity after a lost conditional update; use a shared transactional AFTER-trigger capacity counter across every schedule writer; and warn on cancelled occurrences whose attempt already started. The counter counts actual upsert outcomes, not attempted INSERTs; replacement reminders withdraw old slots first. Original reviewer reproductions now pass all six cases. Five permanent regressions add shared generic/domain races, full-capacity replacements, retry slots, no-replay warnings and owner-cascade cleanup. Updated full checks passed: 583 application, 21 JavaScript and 30 Python tests, plus 14 offline rollout tests; build and formatting passed. Re-review of the updated head is pending.

Additional mocked end-to-end verification passed Chief → subscriptions child → ledger/reminder → agent report → Chief reply with Gmail disconnected (two coordinator and two child calls). The first temporary harness used an incorrect child-prompt detection phrase; correcting the injected factory identification required no app change.

## Verification and outcome

No paid provider smoke/eval, production mailbox search, external account mutation or Telegram message has been performed. A deployed-module database smoke was subsequently executed and rolled back; see release closure. This is the manual milestone only; issue 132 remains open for reviewed source intake, price changes, summary and responsibility monitoring. GitHub access and the operator connection were verified in this session; that does not prove another cloud session inherits either.

The review/release was pending at this earlier checkpoint. The dated release closure below records final approval, migration 025, exact deployed SHA, preservation checks and published version.

## Follow-up and next iteration

First owner acceptance: add a manual recurring payment, open Subscriptions, edit its decision date, enable a reminder and confirm its Singapore firing time. Later adapters should emit the same typed observations after content minimization and owner review; responsibilities should supply source scope and attention policy through issue 131 rather than adding a private subscriptions timer.

### Review follow-up and checkpoint — 2 October 2026

Astra requested changes at `e3cc824558011ae32f2d4415734b1eda97a67638` after confirming the original retry/quota fixes, then reproducing a long-history variant of the no-replay warning plus date-certainty, settings-read classification and source-reference defects. The candidate now queries exact planned dates for warnings, requires explicit date certainty, makes settings mutation-only with inspection through the read tool, and binds exact validated source input IDs. Four additional permanent regressions pass; the focused suite is 24 tests and build passes. Full checks and independent re-review of this latest revision remain pending.

The owner requested that previous changes be pushed as a checkpoint before broader harness research/planning. PR142 remains draft, unmerged and undeployed. Fresh main is `3382c5d63a6551ea960615332d0fc0cd3643e672` (Libby refusal handling); its changes and patch version must be incorporated, and the operator baseline reverified/reviewed before release. This checkpoint is not a tested release.

### Checkpoint review outcome — 2 October 2026

GPT-6 Astra APPROVED checkpoint code at exact head `5d2329219672cb468315c6f09438ea89f97f621b`, independently passing 24 subscription, 8 plugin, 6 adapted original adversarial and 3 additional source/contract checks. All earlier findings are resolved. Full local checks subsequently passed 587 application, 21 JavaScript and 30 Python tests; formatting and build passed. Semantic source selection still relies on the agent choosing supporting inputs correctly. Multi-connection PostgreSQL testing remains unavailable locally.

This dated documentation follow-up does not claim approval for a future integrated/released head. The owner directed work to a broader harness plan after pushing the previous changes. PR142 stays draft and undeployed: incorporate main `3382c5d`, reconcile version, reverify/re-review the operator baseline and independently review the resulting exact head before any merge/release. The production smoke was reviewed but not executed.

### Shipping integration — 2 October 2026

The owner explicitly requested completing the tracker first. Fresh main and production RELEASE/health matched `ae0237f4337a640937d36ed6e742c5fdef7ae9b7` ([release 37025370056](https://github.com/akhilvuputuri/chief-agent/actions/runs/37025370056)). Main now includes released responsibilities (migration 023) and the default-off coding foundation (024). These are preserved. The unshipped tracker migration is renumbered 025, patch version is 0.3.34, and Mini App navigation/API conflicts are resolved with both views present. Integrated full checks passed: 670 application, 22 JavaScript and 30 Python tests; build/format passed, plus 14 offline operator rollout tests. Exact integrated-head independent review and migration 025 operator release are pending. No coding runtime activation, responsibility creation or paused-task resumption is part of this work.

### Release closure — 3 October 2026

GPT-6 Astra **APPROVED** exact integrated head `142486080c9094bbab151636d48e767dfc7e7d99` against `ae0237f4337a640937d36ed6e742c5fdef7ae9b7`, independently passing 101 focused tests, 18 adversarial checks and all 14 offline rollout tests. It found no remaining blocker. [PR #142](https://github.com/akhilvuputuri/chief-agent/pull/142) merged to `b79fd27f8cdf5ecadb05622217ab61666a63f70b`, whose tree is identical. [Exact PR checks](https://github.com/akhilvuputuri/chief-agent/actions/runs/37028141224) and [main checks](https://github.com/akhilvuputuri/chief-agent/actions/runs/37029456267) passed; local full validation passed 670 application, 22 JavaScript and 30 Python tests, build/format, plus 14 rollout tests. The mocked Chief → domain agent → ledger/reminder → report → Chief reply passed with Gmail disconnected. The integrated synthetic Mini App retained both Responsibilities and Subscriptions navigation; earlier phone-width verification was 390 × 844.

The [first automatic release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37030123032) refused the database/Compose diff as intended. The independently reviewed operator procedure then installed only additive migration 025 from verified baseline `ae0237f`, preserving 023/024, the trusted release handler and production environment. Exact server RELEASE and startup health matched `b79fd27f8cdf5ecadb05622217ab61666a63f70b`. [Normal release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37030523500) subsequently passed for that exact SHA. [v0.3.34](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.34) immutably labels it; a documentation follow-up is not a new feature version.

Separate bounded private before/after checks confirmed unchanged jobs, memories, parcels and reminder rows (counts and hashes), responsibility/coding-job counts, and no active work or pending input at rollout. Only the pass/fail result is recorded here. The reviewed deployed-module smoke passed manual capture/read/update, other-owner isolation, exact retries, linked-date withdrawal/replacement, cancellation and shared capacity accounting inside one rolled-back transaction. Migration 25, empty new ledger/history, no synthetic owner and capacity consistency were independently checked afterward. Zero Telegram sends and zero model calls were made; no fixture remained.

Limits: this is the manual tracker, not completion of issue 132's intake/monitoring scope or the proposed general execution harness. Live owner Telegram/reminder delivery acceptance, semantic input-choice accuracy, pending-price alerts, email/PDF/browser intake, monthly summaries and merchant cancellation handoff remain separate. Local/reviewer concurrency checks use PGlite; the production smoke uses one real PostgreSQL connection and does not claim a multi-connection production race test. Paid provider evals remain deferred. Already-started delivery retains the disclosed final-check/edit race and no-replay behavior. Coding stays off; no responsibility was created or paused task resumed. The migration still needs the reviewed local operator connection; ordinary releases and exact receipts use the shared GitHub path, and cloud migration parity remains an engineering gap.
