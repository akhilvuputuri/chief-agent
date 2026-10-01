# Subscriptions and recurring bills

First milestone for [issue 132](https://github.com/akhilvuputuri/chief-agent/issues/132): manual owner statements, a persistent tracker, and linked reminders. Email is not required. Source extraction, automatic monitoring through [responsibilities 131](https://github.com/akhilvuputuri/chief-agent/issues/131), price-change alerts, monthly summaries and merchant cancellation handoffs remain later milestones.

## Owner experience

Tell Chief what to track, for example “Add Netflix, 22.98 SGD monthly, renews on the 5th” or “My gym renews 1 November; I must cancel by 20 October. Remind me seven days before.” Chief records only the stated facts, retrieves saved state on later questions, and confirms actual reminder firing times in Singapore time. A receipt or proposed candidate alone is not an instruction to save it. The new `core/subscriptions` agent receives the owner's instruction through Chief; it has no email, document, account or payment tools.

The read-only Mini App's Subscriptions tab shows per-currency fixed monthly equivalents, a next-30-day timeline, saved items (including inactive items), dates, reminder states and paged history. Every refresh reads the same owner-scoped records. Additions, corrections, cancellation statements and reminder settings stay in Telegram. There are no public write endpoints.

## Saved state and provenance

Migration 023 adds `subscriptions` and append-only `subscription_updates`. The current row contains validated fields plus one deciding update reference per explicitly supplied field. Updates preserve the exact supplied patch, request identity, revision, host run ID and up to ten original input references bound to that run or its coordinator. Source bodies and statement text are not copied into either table. Existing private conversation/history retention is unchanged; this milestone does not promise that arbitrary owner messages disappear from conversation storage.

Fields distinguish amount/currency and fixed/variable/unknown amount, billing cadence, status, next charge date (stated or estimated), trial end, cancellation deadline and paid-through date. Cadence never manufactures a date. Unknown dates stay null; an owner may explicitly clear a field with null. A cancelled item can only be reactivated by a later explicit owner statement. No external observation is accepted in this milestone.

Merchant, plan and account labels are short strings; payment-number and full-address patterns are rejected. There is no free-form notes/body field. This is bounded label validation, not a universal personal-data detector. Image/PDF/email extraction requires separate protection before those contents enter persisted source/tool history.

`subscription_record` creates without an id; an update requires an owner-scoped id and its current `baseRevision`. Each mutation needs a fresh `requestKey`; an exact retry returns the existing item without another observation or reminder. Reusing the key for different data fails. The row, history and reminder changes commit in one SQL statement. The database enforces exact normalized merchant/plan/account identity, including inactive items, and history links enforce the same owner on both tables.

`subscription_list(merchant,plan?,accountLabel?)` performs host matching. Merchant alone remains ambiguous; merchant plus a distinguishing plan/account resolves only when exactly one item matches. The agent must ask on ambiguity and list inactive items before creating another plan for a previously saved merchant. List/history projections are bounded below the runtime's 12,000-character result limit, retain the honesty notice and IDs, and report pagination.

## Totals and dates

Fixed monthly equivalents include only active fixed amounts with a known cadence and currency. Annual divides by 12, quarterly by 3, weekly multiplies by 52/12, and day intervals multiply by 365/(12 × intervalDays). Rational BigInt arithmetic adds unrounded contributions per currency and rounds the total once to that currency's displayed fraction digits. Original decimal strings remain intact. These figures estimate a normalized recurring cost; they are not actual spending or this month's projected charges. Trials, variable/unknown prices and cancelling/cancelled items do not inflate the recurring total. No foreign-exchange conversion occurs.

The timeline shows known/estimated dates in a 30-calendar-day Singapore window, starting today and excluding the upper bound. Renewal, trial end and cancellation deadline remain separate events. Paid-through is informational and does not imply a further renewal or an automatic cancellation.

## Linked reminders

Reminders are opt-in per item. `subscription_settings(id)` reads that item's state; changing it requires a request key and current revision. When enabled, default notice is 7 days for annual renewals and cancellation deadlines, 3 for trial ends, none for other renewal cadences, at 09:00 Singapore. A per-item `daysBefore` overrides all its dates and `time` changes the hour. A monthly renewal needs an explicit lead time. There are no global defaults or monthly-summary settings yet.

Migration 023 adds owner-bound subscription identity, event date and revision to existing `daily_schedules`. One item/date creates one occurrence, grouping trial/renewal events sharing that date. Record edits update a never-started occurrence or cancel obsolete dates. A new date can create a new occurrence. Completed, failed or already-started occurrences are never rearmed automatically, even when a later edit restores their date. Restoring a cancelled occurrence whose delivery had started returns an explicit no-replay warning. Results explain this limitation and return firing times/states. A passed notice window returns a warning and schedules nothing late.

The AFTER trigger avoids reserving a slot for the attempted INSERT path of an upsert that ultimately only updates an existing row. Conditional counter updates re-evaluate the latest locked count under Read Committed; see [PostgreSQL trigger behavior](https://www.postgresql.org/docs/current/trigger-definition.html) and [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

`DailyWorker` remains the scheduler and makes no model call for these reminders. Before sending a claimed occurrence it rechecks both its lease and current subscription revision/status/preferences. Generic `schedule_update` refuses linked reminders: edits must go through subscription settings or the date record. Already-started sends can race a foreground edit after the final check, as with existing reminders; results flag processing/withdrawn occurrences rather than claiming a message was recalled. Recovery marks interrupted attempts failed and never retries them automatically. The existing 50-active-schedule limit is enforced atomically for generic and linked schedules by migration 023’s shared `daily_schedule_capacity` counter and AFTER row trigger. The trigger counts actual upsert outcomes, releases cancelled/completed slots, and rolls the entire write back on exhaustion. Ledger-only edits need no slot. Replacement writes depend on withdrawing obsolete occurrences first. Historical over-capacity rows, if any, are retained; further allocations wait for capacity.

## Capability and prompt cost

The tools are `subscription_record`, `subscription_list` and `subscription_settings`, gated by `availability.subscriptions`; the `subscriptions` picker domain and reviewed core plugin route domain work away from Chief. Gmail connectivity does not affect this agent. With the flag off, the new tools, catalogue entry, domain-loading enum and visibility flag are absent from the model-facing prompt.

Offline measurement on 1 October 2026 against main `9b76fc5` (the later `78ad212` changes only development instructions), all eleven existing integration flags enabled, empty owner/work state and no initially loaded domains: coordinator tool schemas plus runtime state were 8,092 characters before and with subscriptions disabled, and 8,364 with subscriptions enabled, a 272-character increase. Tool count stayed 12; the three domain schemas total 3,688 characters and are offered to its agent/direct mode. Common system instructions are unchanged and excluded from these counts. This is character inventory, not token, latency or provider-cost evidence. Paid picker/model evals remain deferred under the owner's session instruction.

## Reviewed migration rollout

The ordinary release refuses the new database/Compose diff. After current-head independent approval and passing checks, merge, then run the reviewed `scripts/deploy-subscriptions.py ARCHIVE SHA` through the existing operator connection. It accepts baseline `78ad212182a34cf18b77a60c9e0d6d5cce8b7c0b`, independently observed in server RELEASE/health and [release 36885999446](https://github.com/akhilvuputuri/chief-agent/actions/runs/36885999446). Reconcile and re-review any newer baseline; never rewrite RELEASE or bypass the guard.

The operator script validates immutable historical migrations and exactly one Compose insertion, verifies the Git archive's SHA, locks releases, builds before stopping the gateway, and refuses active runtime work or pending input. It applies only 023 and checks its marker/startup health. Failure restores the previous app/source/Compose while retaining additive tables; any pending subscription reminders are paused before restarting an older image that lacks consistency checks. No user task is cancelled or resumed. The trusted release command and production credentials are unchanged.

After rollout, verify exact RELEASE, health, migration marker and preserved-record counts separately. A synthetic transaction-rolled-back deployed-module check can verify owner-scoped capture/read/update and reminder linkage without retaining records or sending Telegram messages. Follow [cloud workflow](cloud-agent-workflow.md) for exact release evidence and [release policy](releases.md) for the immutable patch tag. Actual owner Telegram acceptance remains separate.
