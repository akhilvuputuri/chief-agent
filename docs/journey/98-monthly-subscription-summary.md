# 98 — Can the monthly subscription summary be built without a model?

Work date(s): 2026-10-19. Written/revised: 2026-10-19.
Status: in progress. Implementation and tests pass locally; it builds on price-change alerts ([journal 97](97-price-change-alerts.md), PR 258). Independent review, merge and release are pending.

## User-visible problem and preceding iteration

Issue 132 S7 asks for one opt-in message a month: per-currency totals, what changed since last month (new, cancelled, price changes), and the next 30 days of renewals and trial ends. R10 requires it to be deterministic and built from saved records with no model call, like the news bulletin. Journals [54](54-subscriptions.md), [93](93-invoice-backed-tracker.md) and [97](97-price-change-alerts.md) left the records it needs: append-only history with exact patches, invoice provenance and applied price changes. Nothing read them back as a monthly view.

## Evidence

- Tested: `DailyWorker` already claims, leases and delivers `briefing` schedules through `buildBriefing`, which makes no model call. Its five-field cron supports a monthly day in Singapore time.
- Tested: `daily_schedules.kind` allows only `reminder` and `briefing`. A new kind or a per-owner settings column would need a migration.
- Measured (offline, 19 October 2026, `runtimeContext` with every integration flag on, against the price-alerts head `04a2811`):
  - Chief's coordinator tools and state grow from 11,862 to 11,883 characters, from the longer subscriptions-agent description.
  - The tracker tool schemas offered to agents grow from 6,488 to 7,670 characters.
  - This is a character inventory, not tokens or cost.
- Deferred: paid evals and live owner acceptance.

## Diagnosis and alternatives

The summary is one `briefing` schedule per owner, identified by an ID derived from the owner; `buildBriefing` builds the summary for that ID.

- **Why this way.** It reuses delivery, leases, capacity and the no-replay rules, and needs no migration.
- **Rejected:** adding a section to the existing daily briefing on the 1st (open question 3 in the issue). It would make the summary depend on a briefing schedule the owner may not have.

Changes are found by replaying each item's history, because a patch records only new values. The replay starts at the first revision so a price change can quote the price it replaced. Saved price changes are dated on their effective day, whether or not a later write has recorded them yet. Next-30-day dates come from the stored row, so a price change stays listed on its day.

## Implementation and review

- [src/subscription-summary.ts](../../src/subscription-summary.ts):
  - schedule ID, set and status;
  - `buildSubscriptionSummary`: totals, the month's changes, the next 30 days, and items left out of the totals.
- Operations ([src/subscription-schema.ts](../../src/subscription-schema.ts)):
  - `subscription_summary(month?)`, a read-only preview;
  - `subscription_summary_set(enabled, day?, time?)`, foreground-only.
- [src/daily-briefing.ts](../../src/daily-briefing.ts) routes the summary schedule to the builder.
- Agent wiring: the `subscriptions` agent, the registry grants and delegation, and the `subscription-ledger` skill.
- Design: [subscriptions](../subscriptions.md#monthly-summary).

Review: pending.

## Verification and outcome

Tested with PGlite:

- **Setting.** Default and custom schedules give the right next run in Singapore time. Turning it off cancels the schedule. The setter is refused in a background lane, and the preview is a read.
- **Month boundaries.** A change at 23:30 on 30 September Singapore time counts for September; one at 00:30 on 1 October does not.
- **Changes.** New, ended and owner price changes are listed with the price they replaced.
- **Saved price changes.** They are reported in their effective month exactly once, before and after a later write records them. Upcoming dates quote the price in force on each date.
- **Isolation.** Another owner's summary contains none of the first owner's items.
- **Delivery.** The scheduler sends the summary with calendar and Gmail stubs that throw if called, and there is no model in the path.

Not established: whether the message reads well on a phone, and live delivery.

## Follow-up and next iteration

Owner acceptance: turn the summary on, preview it, and check the first delivered message. Issue 132's remaining work is the responsibility-driven automatic phase (receipt and price-change email monitoring) and merchant cancellation handoffs.
