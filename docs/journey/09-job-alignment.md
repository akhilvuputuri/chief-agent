# From generic research to job alignment

Work date: 2026-09-12. Revised: 2026-09-14.
Status: released v0.3.0; semantic quality and comparative cost unmeasured.

## Problem and intended behavior

Generic delegation's short summaries and two source quotations were insufficient for deep role interpretation, qualified interview research and personalized preparation. The requirement concerns purpose, not cardinality: selected roles and all saved roles need the same standards. Internal batching must not become user-managed work.

## Change

Add an owner-scoped frozen assessment scope, a versioned job-alignment skill, richer validated reports and retrieval. Reuse the specialist runner and existing Postgres events/calls. Preserve exact identities, qualified evidence and unknowns; snapshot selected background instead of sending the full conversation. Resume pending internal batches without changing the target set. Reconstruct coverage from the child's persisted report so parent interruption does not erase completed assessment work.

## Validation and limits

Focused mocked regression tests cover selected/all scope, added records between batches, owner isolation, invalid source/background claims, interview applicability declarations and recovery. Existing specialist tests cover shared budgets/cancellation. Scope, instruction version and actual child inputs/results are traceable. Source applicability and preparation synthesis remain model judgments, not certified by string matching. Cross-role semantic deduplication is instructed and uses existing preparation tools; it is not a new deduplication engine. No paid quality or cost claim is made.

## Release process

The release required a merge request, independent Astra review, fixes and re-review, passing checks and exact deployment/health verification. The closure below records that outcome; the linked PR retains the intermediate revisions. No schema migration or new service. Private trace exports and Python analysis remain separate work.

## Release closure — 14 September 2026

[v0.3.0](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.0) shipped [PR #30](https://github.com/akhilvuputuri/companion-agent/pull/30) at `1c625cbe9dd56292347970f257513cfc7dcd9ada`. The [release workflow](https://github.com/akhilvuputuri/companion-agent/actions/runs/34698539900) completed successfully for that exact SHA; published release evidence records deployment and health verification. Independent Astra review approved final head `7ebdd38e820e01b4563154186366aa70db018fb6` after a pagination fix and incorporation/re-review of the [foundation correction](10-foundation-review.md). The release records 107 tests, typecheck, build and formatting. These establish tested scope, evidence and recovery behavior; source applicability and synthesis remain model judgments.
