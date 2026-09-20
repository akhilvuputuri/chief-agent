# 24 — Scheduled independent agent work

20 September 2026 — released v0.3.15. [Issue 56](https://github.com/akhilvuputuri/companion-agent/issues/56).

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

The implementation and release are verified below; live model behavior remains unmeasured.

### Review corrections (20 September)

The first full regression run exposed a context-budget regression: repeating scheduling guidance in four tool descriptions displaced an older answer's retrieval reference. The fix uses brief operation-specific descriptions; the existing exact-answer retrieval regression now passes.

Independent Astra review of `a9c5fbd` requested changes for a stale scheduling-state update race and unauthorized owners monopolizing a bounded due scan. Updates now compare scheduling state as well as revision, and revoked owners' routines are paused. Added adversarial regressions for both and an actual Assistant-lane/approval-pause integration test. This preserves the failure and correction, rather than presenting the initial implementation as immediately correct.

### Release coordination

PR #58 merged after approval of `a54fee1` and both CI checks. A parallel Gmail documentation/version closure reserved v0.3.14 before the merge, so routines use v0.3.15. The rollout accepts the exact reviewed Gmail implementation baseline or that documentation/version closure; historical migrations, Compose and the trusted release-handler source must still match. At that checkpoint deployment remained pending; see closure below.

### Verified release closure (20 September)

- [PR #58](https://github.com/akhilvuputuri/companion-agent/pull/58): Astra approved `a54fee18dd0be2201fdcd4b7e464840eccfc40cf` after the recorded fixes; both required checks passed before merge.
- [PR #59](https://github.com/akhilvuputuri/companion-agent/pull/59): Astra approved release coordination at `be34cb2e514922ba57f8ec3e735db465176b2610`. This follow-up was merged before a failed merge-result check was noticed; deployment was held. The failure was an existing library assertion matching the two-character card sentinel inside a random callback UUID. The concurrent reviewed library fix in PR #57 already limited this assertion to message text.
- Astra then approved the **exact integrated release** `c1f8e7088676d4ee3d041993d5e08412e4c73a70`. Its [main checks](https://github.com/akhilvuputuri/companion-agent/actions/runs/35503662403) passed before deployment: 297 application tests plus two script tests. Thirteen offline rollout tests passed independently. Typecheck and formatting passed.
- The reviewed `scripts/deploy-routines.py` rollout reported that exact SHA healthy with migration 017. A separate server read confirmed RELEASE, health and migration marker. Before/after counts for existing jobs, memories, reminders and tasks matched. No routine or paid model invocation was created for this verification.

This is startup/schema and mocked behavior validation, not live Telegram scheduling acceptance or measured answer quality. Existing paused work was not replayed. The source contract is ready for future domain specialists.

The [standard release workflow](https://github.com/akhilvuputuri/companion-agent/actions/runs/35503855161) subsequently passed for the same SHA, and immutable [v0.3.15](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.15) was published at that commit.
