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
