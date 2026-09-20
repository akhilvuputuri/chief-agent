# 24 — Scheduled independent agent work

20 September 2026 — implementation candidate, review/release pending. [Issue 56](https://github.com/akhilvuputuri/companion-agent/issues/56).

## Problem and preceding iteration

[Independent jobs](17-rolling-conversation.md) separated foreground conversation from durable work. Existing reminders could send fixed text and briefings, but could not launch a general task at an owner-selected time. Upcoming domain capabilities needed that shared foundation rather than separate stock/news timers.

## Diagnosis and decision

The missing link was durable occurrence → exact work task, not a new cron service. Reuse the existing parser, Postgres and worker. Keep reminders intact. An immutable instruction snapshot prevents a routine edit from changing a running job. Latest-only catch-up and non-overlap prevent a downtime backlog or runaway concurrent copies.

An in-memory timer alone was rejected because it loses identity/recovery state. Re-executing work after a Telegram failure was rejected because it repeats tool effects and costs. Instead, persist response delivery independently and expose uncertainty honestly.

## Change and validation

Added owner-scoped routine create/list/update/history tools, occurrence/task creation in one atomic statement, independent runtime execution and a durable response outbox. No domain agent is required. Background jobs cannot modify schedules, and existing approval/cancellation/budget boundaries still apply.

Synthetic PGlite regressions cover concurrent scheduler ticks, owner isolation, rejected rapid schedules/background creation, immutable snapshots, overlap skips, latest/skip policies, Singapore cron, interval phase, persisted results, ambiguous sends and uncertain-write restart recovery. These are mocked implementation checks, not evidence of real-world punctuality, better answers or reduced costs.

## Limits and next work

Single background worker; execution may start after due time. Paused tasks block subsequent occurrences until resolved. Progress delivery is best-effort. A crash before outbox capture requires inspection of saved runtime history. No realtime stock monitoring or news feedback, and no conditional silence policy yet. Domain agents should reuse the contract in [scheduled routines](../scheduled-routines.md).

Review/deployment closure will be appended after verification; no production acceptance claimed here.

### Review corrections (20 September)

The first full regression run exposed a context-budget regression: repeating scheduling guidance in four tool descriptions displaced an older answer's retrieval reference. The fix uses brief operation-specific descriptions; the existing exact-answer retrieval regression now passes.

Independent Astra review of `a9c5fbd` requested changes for a stale scheduling-state update race and unauthorized owners monopolizing a bounded due scan. Updates now compare scheduling state as well as revision, and revoked owners' routines are paused. Added adversarial regressions for both and an actual Assistant-lane/approval-pause integration test. This preserves the failure and correction, rather than presenting the initial implementation as immediately correct.
