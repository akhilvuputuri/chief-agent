# 75 — Let a rejected context summary be corrected before pausing

Work date(s): 2026-10-09. Written/revised: 2026-10-09.
Status: Python 0.1.7 candidate; tests/review/image publication and live acceptance pending.

## Problem and evidence

[Journal 74](74-coding-provider-recovery.md) fixed a reproduced provider-error classification gap and deployed v0.3.54. The owner-authorized first live plan trial then paused at a different boundary: 33 completed model calls, one previous compaction, 73 tools and no saved plan. The last summary used exactly one `notes_update` call with the correct string fields, but its findings were 6,511 UTF-16 units against the 6,000-unit bound. The generation completed; no provider request was rejected. The saved earlier notebook retained correct static-reminder/dynamic-briefing source evidence and unresolved next reads. Cleanup completed; no changed files, approval or publication.

These are measured facts from one real DeepSeek V4.1 Flash high/Python 0.1.6 job with the existing two-hour/400-model/1000-tool allocation. Private task examples, notes and traces remain outside public documentation. This failed acceptance is preserved rather than counted as a successful short-plan result.

## Diagnosis and intervention

The notes schema already published max lengths, but a model can violate them. The old condenser immediately raised `ContextRecoveryError` for a validation failure, despite retaining enough allocation and context to request a correction. Silently slicing findings would lose evidence; raising the size limit would merely postpone the boundary.

Python 0.1.7 makes the limits explicit in the summary instruction and permits one bounded correction. It supplies safe fixed validation guidance and field-length metadata, retaining the complete original history and old notebook until a valid replacement is acknowledged. A recognized transient summary-generation failure may likewise use that single fresh-generation opportunity; authentication and malformed/incomplete wire generations remain fatal. No repository action from a summary response is executed. Every generation consumes existing model allocation; a valid notes update consumes one tool. Before each attempt the condenser checks remaining allocation (including a continuation call), wire size and message limits. Repeated invalid output pauses without compaction or note replacement; uncertain checkpoint writes still stop rather than replay.

## Verification and release boundary

Regressions reproduce the measured 6,511-unit failure followed by a valid correction, two invalid astral-Unicode summaries retaining old history/notes, and insufficient allocation denying repair. Existing acknowledgement/cancellation/replay/compaction tests remain relevant. The initial full 1002-test suite passed, and GPT-6 Astra approved the foundation head `ab9db51a1ee6315b4ee54b20dd1396b4115461f4`. A persisted Devin flag then identified an accepted adapter response without content that would make the retry fail the host schema. Retry messages now use ordinary continuation's allowed-field projection and content:null default, preserving opaque reasoning and tool arguments. The corrected 58 Python tests/Ruff/mypy pass; updated exact-head review and hosted checks remain required.

This is a compatible foundation: production retains Python 0.1.6 until a trusted main-built immutable image is independently verified and pinned in a reviewed follow-up. No model/effort/provider-filter/shared-allocation, database, Compose, permission, implementation approval or old-job migration is part of this change. The original failed job and failed live trial remain paused on their pins.

## Next falsifying test

After verified activation, run new owner-authorized plan-only trials of the same audit and grade the concise complete brief and source-grounded retained understanding, with normal Main delivery. Keep failed attempts in the record. A successful summary correction alone is not successful planning or general coding reliability. See [the cumulative guide](coding-agent-lessons.md).

## Scoped candidate trials and mixed-failure follow-up — 9 October 2026

[PR #198](https://github.com/akhilvuputuri/chief-agent/pull/198) merged at `45eb17651b041dddc621446f3336ae55e3b12977` after final Astra approval of `fed7a22ae3bc4140b4de3721c823ead9354694e1`, 1002-test hosted checks and resolved missing-content retry compatibility. Main-only [image publication](https://github.com/akhilvuputuri/chief-agent/actions/runs/37882422591) produced Python 0.1.7 digest `sha256:4d6f446dec254d27f3782f277cb32d411193f3d6877dee3a5c7958b7dbe25d62`; anonymous hashes/config, all ten installed final-layer source files/root ownership and private plan-only launcher were independently verified. A scoped compatible-host test changed only NEW job image snapshots; the default and old job pins stayed Python 0.1.6. Foundation [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37882930199) succeeded at 2026-10-09T04:17:48Z.

First candidate completed planning in about 2 minutes 26 seconds: 35 model calls, 68 tools, two compactions, one actual empty-answer transient recovery, normal Main delivery, cleanup complete and no changed files/publication. The delivered plan was 420 whitespace-delimited words / 2,929 UTF-16 units. Root inspection found correct static-reminder/dynamic-briefing understanding but repeated fixture details, an unresolved design alternative and stale next-read notes; functional completion passed but the requested presentation/final-handoff acceptance needed improvement.

A separately reviewed second attempt included presentation and finalized-notebook feedback; it is not a controlled reliability replicate. It paused with 34 calls / 63 tools, no plan and cleanup complete: summary generation first hit an empty provider answer, then its fresh generation returned findings of 6,055 units against 6,000. The single combined retry allowance covered the transport recovery but left no validation correction. Both failed output and the failed attempt stay in the evidence record.

Python 0.1.8 separates the two allowances: at most one recognized transient generation recovery and one validation repair, hard maximum three summary generations. Repeated failures of either kind still stop; original history/notes, continuation/wire/tool headroom, uncertainty and existing shared allocations are unchanged. New regression tests both error orders followed by correction. Source/image review and new owner-authorized acceptance trials remain pending; no global 0.1.7 pin or universal reliability claim.

Hosted validation of the combined-recovery candidate caught an unrelated pre-existing privacy-test flake: a raw log-line substring assertion for `0.91` matched the permitted timestamp suffix `.910Z`. The test now inspects the serialized non-timestamp payload and explicitly rejects probability/domain fields. No logger behavior or disclosure boundary changed. The new revision requires fresh exact-head review and CI.
