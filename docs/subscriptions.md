# Subscriptions and recurring bills

First milestone for [issue 132](https://github.com/akhilvuputuri/chief-agent/issues/132): manual owner statements, a persistent tracker, and linked reminders. Email is not required. Source extraction, automatic monitoring through [responsibilities 131](https://github.com/akhilvuputuri/chief-agent/issues/131), price-change alerts, monthly summaries and merchant cancellation handoffs remain later milestones.

## Owner experience

Tell Chief what to track, for example “Add Netflix, 22.98 SGD monthly, renews on the 5th” or “My gym renews 1 November; I must cancel by 20 October. Remind me seven days before.” Chief records only the stated facts, retrieves saved state on later questions, and confirms actual reminder firing times in Singapore time. A receipt or proposed candidate alone is not an instruction to save it. The new `core/subscriptions` agent receives the owner's instruction through Chief; it has no email, document, account or payment tools.

The read-only Mini App's Subscriptions tab shows per-currency fixed monthly equivalents, a next-30-day timeline, saved items (including inactive items), dates, reminder states and paged history. Every refresh reads the same owner-scoped records. Additions, corrections, cancellation statements and reminder settings stay in Telegram. There are no public write endpoints.

## Saved state and provenance

Migration 025 adds `subscriptions` and append-only `subscription_updates`. The current row contains validated fields plus one deciding update reference per explicitly supplied field. Updates preserve the exact supplied patch, request identity, revision, host run ID and exact selected original input references validated against that run or its coordinator. Source bodies and statement text are not copied into either table. If the host turn has exactly one original input, it is bound automatically. Multiple inputs require explicit `sourceInputIds`; `subscription_list(sourceInputs=true)` offers stable paged excerpts of the current owner/coordinator inputs, and the host rejects foreign-owner or unrelated-run IDs. Excerpts are selection aids, not automatic evidence. Existing private conversation/history retention is unchanged; this milestone does not promise that arbitrary owner messages disappear from conversation storage.

Fields distinguish amount/currency and fixed/variable/unknown amount, billing cadence, status, next charge date (stated or estimated), trial end, cancellation deadline and paid-through date. Cadence never manufactures a date. A supplied non-null charge date requires explicit `nextChargeEstimated`; clearing the date clears its certainty. Unknown dates stay null; an owner may explicitly clear a field with null. A cancelled item can only be reactivated by a later explicit owner statement. No external observation is accepted in this milestone.

Merchant, plan and account labels are short strings; payment-number and full-address patterns are rejected. There is no free-form notes/body field. This is bounded label validation, not a universal personal-data detector. Image/PDF/email extraction requires separate protection before those contents enter persisted source/tool history.

`subscription_record` creates without an id; an update requires an owner-scoped id and its current `baseRevision`. Each mutation needs a fresh `requestKey`; an exact retry returns the existing item without another observation or reminder. Reusing the key for different data fails. The row, history and reminder changes commit in one SQL statement. The database enforces exact normalized merchant/plan/account identity, including inactive items, and history links enforce the same owner on both tables.

`subscription_list(merchant,plan?,accountLabel?)` performs host matching. Merchant alone remains ambiguous; merchant plus a distinguishing plan/account resolves only when exactly one item matches. The agent must ask on ambiguity and list inactive items before creating another plan for a previously saved merchant. List/history projections are bounded below the runtime's 12,000-character result limit, retain the honesty notice and IDs, and report pagination.

## Totals and dates

Fixed monthly equivalents include only active fixed amounts with a known cadence and currency. Annual divides by 12, quarterly by 3, weekly multiplies by 52/12, and day intervals multiply by 365/(12 × intervalDays). Rational BigInt arithmetic adds unrounded contributions per currency and rounds the total once to that currency's displayed fraction digits. Original decimal strings remain intact. These figures estimate a normalized recurring cost; they are not actual spending or this month's projected charges. Trials, variable/unknown prices and cancelling/cancelled items do not inflate the recurring total. No foreign-exchange conversion occurs.

The timeline shows known/estimated dates in a 30-calendar-day Singapore window, starting today and excluding the upper bound. Renewal, trial end and cancellation deadline remain separate events. Paid-through is informational and does not imply a further renewal or an automatic cancellation.

## Linked reminders

Reminders are opt-in per item. `subscription_list(id)` reads reminder settings. `subscription_settings` is mutation-only and requires a request key, current revision and at least one preference change. When enabled, default notice is 7 days for annual renewals and cancellation deadlines, 3 for trial ends, none for other renewal cadences, at 09:00 Singapore. A per-item `daysBefore` overrides all its dates and `time` changes the hour. A monthly renewal needs an explicit lead time. There are no global defaults or monthly-summary settings yet.

Migration 025 adds owner-bound subscription identity, event date and revision to existing `daily_schedules`. One item/date creates one occurrence, grouping trial/renewal events sharing that date. Record edits update a never-started occurrence or cancel obsolete dates. A new date can create a new occurrence. Completed, failed or already-started occurrences are never rearmed automatically, even when a later edit restores their date. Restoring a cancelled occurrence whose delivery had started returns an explicit no-replay warning. Results explain this limitation and return firing times/states. A passed notice window returns a warning and schedules nothing late.

The AFTER trigger avoids reserving a slot for the attempted INSERT path of an upsert that ultimately only updates an existing row. Conditional counter updates re-evaluate the latest locked count under Read Committed; see [PostgreSQL trigger behavior](https://www.postgresql.org/docs/current/trigger-definition.html) and [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

`DailyWorker` remains the scheduler and makes no model call for these reminders. Before sending a claimed occurrence it rechecks both its lease and current subscription revision/status/preferences. Generic `schedule_update` refuses linked reminders: edits must go through subscription settings or the date record. Already-started sends can race a foreground edit after the final check, as with existing reminders; results flag processing/withdrawn occurrences rather than claiming a message was recalled. Recovery marks interrupted attempts failed and never retries them automatically. The existing 50-active-schedule limit is enforced atomically for generic and linked schedules by migration 025’s shared `daily_schedule_capacity` counter and AFTER row trigger. The trigger counts actual upsert outcomes, releases cancelled/completed slots, and rolls the entire write back on exhaustion. Ledger-only edits need no slot. Replacement writes depend on withdrawing obsolete occurrences first. Historical over-capacity rows, if any, are retained; further allocations wait for capacity.

## Invoice-backed fields

The tracker can take amounts and invoice dates from invoices that [gathering](gathering.md) matched, when the owner asks for that. A matched invoice alone is still not an instruction to save it.

- `subscription_invoices(collectionId?, issuer?, offset?)` lists the owner's matched invoices from each collection's current scope, newest first. Each row has the gathering target, recorded issuer/product labels, invoice dates, service months, every currency amount found in the PDF (up to the 30 that gathering records) and the subscription IDs already linked to it. Paging covers every current match. Amounts include subtotals and tax, so they are candidates, not a verified charge. It is read-only and offered whenever subscriptions are on.
- `subscription_record(..., invoice: {collectionId, artifactId})` cites one matched invoice. The host accepts it only for `amount`/`currency` and the new `lastInvoiceDate` field, and refuses the record unless:
  - the file is a current-scope match owned by this owner;
  - the amount and currency occur in its recorded amounts, compared as decimals;
  - `lastInvoiceDate` is its single recorded invoice date (the match date for an invoice-date match, or the only date on the PDF); a PDF with several invoice dates cannot set it;
  - the item's merchant (or its label when it has no merchant) names the invoice's issuer, ignoring trailing legal or domain suffixes such as "AB", "PBC" or ".ai" unless what remains is under three characters: the same known vendor group, or one name leading the other ("YouTube" and "YouTube Premium"); a shared later word such as "Premium" or "Max" does not count, and the plan never decides the issuer;
  - no plan conflicts with the invoice's product, checked on the plan, the label and their combinations with the merchant or vendor family (a Claude Pro invoice cannot update an item saved as "Claude" plan "Max", "Max 5x" or "Max20");
  - when the invoice was gathered for an account label, the item carries the same `accountLabel` (an unlabelled item cannot take it);
  - once a `lastInvoiceDate` is saved, the cited invoice has a single recorded invoice date that is not older, for any invoice-backed field; the caller's date never orders it;
  - an invoice-backed amount comes with that invoice's `lastInvoiceDate` when the invoice records one;
  - an agent working on a gathering collection cites only that collection; the coordinator and unbound agents may cite any of the owner's collections.
- Accepted fields get `sourceKind: "invoice"` with the collection and artifact IDs in `field_sources`. The update's `source_ref` adds the invoice reference and its gathering receipt. `source_kind` stays `owner`, because the owner authorised the update; no migration is needed. Other fields in the same call stay owner-sourced, and `confidence` reports when any field came from an invoice.
- Any change to the amount/currency pair on an update, including a currency-only change and changes to or from unknown, returns `priceChange` (previous and new pair, and whether an invoice supplied it) and a warning line. Exact retries and request-key reuse rules are unchanged; the invoice reference is part of the request hash only when present, so older retries keep their hashes.
- Writes still need a foreground owner turn. A background gathering pass reports the pending tracker update instead.
- The Mini App shows the last invoice date, marks invoice-sourced items and links each invoice-backed history entry to its collection.

The `core/bills` agent combines gathering and the tracker in one delegation: it gathers the assigned collection, then applies the matched invoices. `core/subscriptions` can apply invoices that were already gathered but cannot fetch new ones. Both read the shared `subscription-ledger` and `invoice-ledger` skills, and `bills` and `gathering` share `invoice-gathering` (see [agents](agents.md#agent-definitions)).

Limits: plan conflicts are recognised for Claude and ChatGPT tiers, including sized names such as "Max 5x". Other vendors rely on the issuer check and the agent's plan matching, so a different product from the same vendor (a Google Cloud invoice for a Google-merchant YouTube item) is not refused. The evidence check runs just before the write, outside its transaction, as source-input checks already do, so a scope revision landing in between is not re-checked. Amount selection among several recorded amounts is the agent's choice, checked only for presence in the document, not for semantic correctness. A single invoice does not establish a fixed recurring price, and cadence is never inferred from invoices. No automatic intake runs without an owner request, and no monthly summary or price alert schedule is added.

## Price-change alerts

Issue 132 asks Chief to flag price increases (S5, R8, R11). Two sources feed alerts; neither changes the tracker in the background.

- **Saved price changes.** An owner-stated future price goes in `pendingAmount`, `pendingCurrency` and `pendingEffectiveDate`, which must be set or cleared together, with a future effective date. The current `amount` stays until that date. Clearing all three before the date drops the change; once it is in effect, correct `amount` directly.
  - From that Singapore date, reads, the Mini App, totals and later reminders use the new price. The timeline still lists the change on its effective day.
  - The next update writes it into the stored record and history (`source_ref.appliedPending`), reports it as a `priceChange` with source `saved price change`, and the amount's field source carries `appliedOn`.
  - No background job writes the record. The change is applied in every view, and history records it with the owner's next update.
- **Price-change notice.** The effective date is a `price change` event for linked reminders, 3 days ahead at the reminder time (09:00 Singapore by default).
  - It is planned when `priceAlerts` is on (the default) even if `reminderEnabled` is off, and never when `priceAlerts` is off. Other reminder dates still need reminders on, and a date shared with other events uses only the remaining events' lead times. With reminders on, the item's `daysBefore` overrides every date's lead, including this notice.
  - Like other linked reminders, the notice takes one of the shared 50 schedule slots. At capacity, saving a price change is refused unless `priceAlerts` is false.
  - `DailyWorker` delivers it model-free, after checking the item's revision, status and that the date is still the saved effective date with alerts on.
- **Invoice price check.** After every successful `gather_match`, the host looks for the one active tracked item the invoice can belong to. It uses the same issuer, plan and account rules as invoice evidence, and compares the price in force on the invoice date with the PDF's recorded amounts. The match result carries `trackerPriceCheck`:
  - `unchanged` or `differs` (an invoice dated before a change already recorded in history is compared with the price that change replaced);
  - `ambiguous`, with candidate IDs, when several items could own the invoice;
  - `not_newer`, when the tracker already reflects a later invoice;
  - `no_saved_price`.

  A failed check is logged as `gathering.price_check_failed` and never fails the committed match.

- **Invoice alert.** In a background gathering pass, a `differs` result for an item with alerts on queues one model-free Telegram message with the saved price and the invoice's amounts. A foreground agent reports the result instead.
  - The message's schedule ID is derived from the item and the invoice, so retries and re-matches never repeat it. That is one alert per item and invoice: each later invoice still showing a new price alerts again until the owner updates the tracker. It counts briefly against the shared 50-schedule capacity; at capacity no alert is queued and `subscription.price_alert_skipped` is logged.
  - The tracker is not changed. Applying the new price needs the owner's request, through the invoice-backed update above.
  - Queued alerts log `subscription.price_alert_queued`.
- **Setting.** `subscription_settings(priceAlerts)` turns both notices off or on per item.

Limits:

- An invoice price differs only when no recorded amount equals the saved price in its currency. A saved pre-tax price on an invoice that lists only a total will alert; that is the price to confirm with the owner.
- Detection runs only when invoices are matched. There is no scheduled refresh: owner-started collections and their background passes are the only automatic source until a responsibility watches receipts (issue 132 phase 3).
- No email price notices are read.

## Monthly summary

Issue 132 S7 and R10: an optional monthly message built from saved records with no model call.

- **Setting.** `subscription_summary_set(enabled, day?, time?)` is foreground-only and owner-wide. It schedules one message on `day` (1–28, default 1) at `time` (default 09:00) Singapore time. Turning it off cancels the schedule, which releases its slot in the shared 50-schedule capacity.
- **Storage.** One `briefing`-kind `daily_schedules` row per owner, with an ID derived from the owner. No migration is needed. `DailyWorker`'s claim, lease, model-free delivery and no-replay rules apply, and `buildBriefing` hands that ID to the summary builder instead of building a to-do briefing. Generic schedule tools can still list, pause or cancel it.
- **Content**, built when sent:
  - per-currency monthly equivalents now, with the excluded count;
  - the previous calendar month's recorded changes: new items, cancellations, and price changes with the price they replaced. Price changes come from owner edits, invoice-backed updates and saved price changes, dated on their effective day.
  - the next 30 days of saved dates, at the price in force on each date;
  - items left out of the totals.

  Month boundaries are Singapore time. Price changes are found by replaying each item's history.

- **Preview.** `subscription_summary(month?)` returns the same content without sending it, plus whether the schedule is on and when it next runs. It is a read.

Limits:

- Only saved records are summarised, not bank or card statements.
- Changes are what was recorded in the month, not what was charged.
- An owner amount edit carries no effective date, so it is dated when it was recorded.

## Capability and prompt cost

[v0.3.34](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.34) shipped through [PR #142](https://github.com/akhilvuputuri/chief-agent/pull/142) at `b79fd27f8cdf5ecadb05622217ab61666a63f70b`. GPT-6 Astra approved exact head `142486080c9094bbab151636d48e767dfc7e7d99` (identical merged tree). It incorporates main `ae0237f`, preserving released responsibilities (023) and default-off coding foundation (024). Reviewed additive migration 025/operator installation, [normal release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37030523500), separate health/preservation and transaction-rolled-back deployed-module verification passed. Owner Telegram acceptance remains separate.

The tools are `subscription_record`, `subscription_list` and `subscription_settings`, gated by `availability.subscriptions`; the `subscriptions` picker domain and reviewed core plugin route domain work away from Chief. Gmail connectivity does not affect this agent. With the flag off, the new tools, catalogue entry, domain-loading enum and visibility flag are absent from the model-facing prompt.

Offline measurement on 1 October 2026 against main `9b76fc5` (the later `78ad212` changes only development instructions), all eleven existing integration flags enabled, empty owner/work state and no initially loaded domains: coordinator tool schemas plus runtime state were 8,092 characters before and with subscriptions disabled, and 8,364 with subscriptions enabled, a 272-character increase. Tool count stayed 12; the three domain schemas total 4,319 characters and are offered to its agent/direct mode. Common system instructions are unchanged and excluded from these counts. This is character inventory, not token, latency or provider-cost evidence. Paid picker/model evals remain deferred under the owner's session instruction.

## Reviewed migration rollout

The ordinary release refuses the new database/Compose diff. After current-head independent approval and passing checks, merge, then run the reviewed `scripts/deploy-subscriptions.py ARCHIVE SHA` through the existing operator connection. It accepts baseline `ae0237f4337a640937d36ed6e742c5fdef7ae9b7`, independently observed in server RELEASE/health and [release 37025370056](https://github.com/akhilvuputuri/chief-agent/actions/runs/37025370056). Reconcile and re-review any newer baseline; never rewrite RELEASE or bypass the guard.

The operator script validates immutable historical migrations and exactly one Compose insertion, verifies the Git archive's SHA, locks releases, builds before stopping the gateway, and refuses active runtime work or pending input. It applies only 025 and checks its marker/startup health. Failure restores the previous app/source/Compose while retaining additive tables; any pending subscription reminders are paused before restarting an older image that lacks consistency checks. No user task is cancelled or resumed. The trusted release command and production credentials are unchanged.

After rollout, verify exact RELEASE, health, migration marker and preserved-record counts separately. A synthetic transaction-rolled-back deployed-module check can verify owner-scoped capture/read/update and reminder linkage without retaining records or sending Telegram messages. Follow [cloud workflow](cloud-agent-workflow.md) for exact release evidence and [release policy](releases.md) for the immutable patch tag. Actual owner Telegram acceptance remains separate.
