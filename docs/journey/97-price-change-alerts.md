# 97 — How does Chief flag a price change without changing the tracker on its own?

Work date(s): 2026-10-19. Written/revised: 2026-10-19.
Status: in progress. Implementation and tests pass locally; independent review, merge and release pending.

## User-visible problem and preceding iteration

[Journal 93](93-invoice-backed-tracker.md) (v0.3.83) lets the owner ask Chief to update the tracker from gathered invoices, and reports a `priceChange` in that reply. Nothing told the owner about a price change they had not asked about. That covers an invoice matched in a background gathering pass, and a price increase the owner had been told about in advance. Issue 132 asks for both: flag price increases once per change (R11), and show an announced price before its effective date and apply it on that date (R8).

## Evidence

- Tested: background gathering passes run with `work_turns.background = true`. Tracker writes are refused there, so a background pass cannot apply a new price, only report it.
- Tested: linked subscription reminders already plan, withdraw and deliver dates model-free. The `DailyWorker` delivery check required `reminderEnabled`.
- Measured (offline, 19 October 2026, `runtimeContext` with every integration flag on, against main `3b93fa7`):
  - Chief's coordinator tools and state are unchanged at 11,862 characters. The new behaviour lives in delegated tools and agent skills.
  - The four tracker tool schemas offered to agents grow from 5,706 to 6,488 characters.
  - The gathering tool schemas grow from 11,250 to 11,436 characters.
  - This is a character inventory, not tokens or cost.
- Deferred: paid evals and live owner acceptance.

## Diagnosis and alternatives

Two separate needs share one setting:

- **Announced prices** are owner-stated data with a date. They are stored as `pendingAmount`, `pendingCurrency` and `pendingEffectiveDate`.
  - A host job that rewrites records on the date was rejected: background tracker writes are disallowed, and a revision bump would invalidate the item's other linked reminders.
  - Instead, reads, totals and reminders treat the pending price as current from its Singapore date, and the owner's next update records it in history.
  - The notice before the date reuses the linked-reminder machinery and fires even when general reminders are off, because it is the alert the owner asked for.
- **Invoice disagreements** are detected, not known. The host cannot pick a recurring total from an invoice's amounts deterministically, but it can tell when none of them equals the saved price.
  - Each successful match is compared with the one item it can belong to, using journal 93's issuer, plan and account rules.
  - A foreground agent reports the comparison in its answer.
  - A background pass sends one Telegram alert, deduplicated by an ID derived from the item and the invoice. This gives one alert per item and invoice, needs no migration, and leaves applying the price to the owner. Each later invoice that still shows a new price alerts again until the tracker is updated.

Alternatives deferred: reading merchant price-change emails, and a scheduled monthly invoice refresh. Both belong to the responsibility-driven phase 3 of issue 132.

## Implementation and review

- Schema: the pending trio and `priceAlerts` on records; `priceAlerts` on settings ([src/subscription-schema.ts](../../src/subscription-schema.ts)).
- Tracker ([src/subscriptions.ts](../../src/subscriptions.ts)):
  - `effectiveRow` applies a due pending price in reads, lists and the base of updates;
  - a `price change` reminder event;
  - `priceOn` quotes the price in force on each reminder date;
  - `priceCheck` and `queuePriceAlert`;
  - `identityRefusal`, shared with invoice evidence.
- Gathering ([src/gathering/controller.ts](../../src/gathering/controller.ts)) adds `trackerPriceCheck` to match results and queues the alert in background lanes.
- The `DailyWorker` delivery check accepts a price-change notice when alerts are on ([src/daily.ts](../../src/daily.ts)).
- The Mini App shows the pending or applied price, the alert setting and applied changes in history.
- The shared skills cover pending prices and `trackerPriceCheck`.
- Design: [subscriptions](../subscriptions.md#price-change-alerts).

Review, 19 October 2026: the independent reviewer (Claude Opus 5.5) requested changes at `5f5a65d`.

- **Blocking.** With reminders on, `priceAlerts=false` did not remove the price-change notice; the filter applied only when reminders were off.
- **Non-blocking.** At schedule capacity, saving a price change was refused with a message about reminders only.
- **Non-blocking.** The journal said "one per change", where the code sends one per item and invoice.
- **Non-blocking.** A pending date already past was accepted, and clearing a change already in effect silently kept it.
- **Non-blocking.** A capacity-dropped alert left no log.

Fixes:

- The setting filters the notice in every case, and grouped dates use only their remaining events' leads.
- The capacity refusal names the price-change slot.
- Pending dates must be in the future.
- The write that first records an applied change returns a `priceChange`.
- Skipped alerts log `subscription.price_alert_skipped`.
- The docs say once in effect, correct the amount directly.

Regression tests cover these. Re-review pending.

## Verification and outcome

Tested with PGlite:

- partial pending prices are refused;
- the notice is planned 3 days ahead at 09:00 Singapore with reminders off, and delivered model-free;
- `priceAlerts=false` withdraws the notice;
- from the effective date, reads and totals use the new price, and the next update records it;
- renewal reminders after the date quote the new price;
- price checks return unchanged, differs, `not_newer` and ambiguous, and honour a pending price in force on the invoice date;
- alerts are deduplicated and the setting is respected;
- a real `gather_match` reports the check in the foreground and queues exactly one alert across repeated background matches.

Not established: how often the saved price is absent from an invoice that did not change, for example a saved pre-tax price on a total-only invoice; and live Telegram delivery.

## Follow-up and next iteration

Owner acceptance: save an announced price change and confirm the notice and the applied price on the date. Let a background pass match an invoice whose price differs, and confirm one alert. A responsibility that watches receipts and price-change emails (issue 132 phase 3) and the monthly summary (S7) remain separate.
