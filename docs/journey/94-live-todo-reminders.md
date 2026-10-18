# 94 — Why did to-do reminders say "review your list" instead of showing the list?

Work date(s): 2026-10-18. Written/revised: 2026-10-18.
Status: in review.

## Problem and preceding iteration

On 7 October two scheduled to-do reminders sent generic text. The owner asked "what was this?" and complained the next morning. Between 8 and 11 October the owner started several coding jobs to fix it. One was approved, failed during implementation and was never picked up again (see [92](92-uncertain-coding-write-lock.md) and [93](93-open-loops-context.md) for the related failures in that work).

## Evidence

- **Reported,** in the two-week review: two generic to-do reminders drew a "what was this?" message and a complaint.
- **Code-confirmed at `a9f4547`:**
  - `DailyWorker` sends `Reminder: ${content}`, which is the text fixed when the schedule was created.
  - The `briefing` kind already builds its message at send time from the owner's open to-dos (up to 10), plus optional calendar and email, without a model call.
  - The `schedule_create` tool had no description of the difference.
  - The daily agent was told only to use `schedule_create` "for fixed reminders and briefings".

## Diagnosis and alternatives

This was mostly a capability-selection gap: the agent had no reason to choose a briefing. Independent review then showed the briefing itself was not a fix as built. It ignored the schedule's own text, arrived as a generic "Daily brief — date", and put the tasks behind the Sections tab. Steering a to-do reminder there would have repeated the 7 October confusion.

Two options were considered:

- **A new `includeTasks` flag on reminders.** Deferred: it needs an additive column, which means an operator migration.
- **Make the existing briefing worth choosing, then steer narrowly.** Chosen: no schema change.

Done/Snooze buttons are a separate, larger change.

## Implementation and review

- **The briefing builder moves to `src/daily-briefing.ts`** (out of `main.ts`), with the same Calendar and Gmail calls.
  - The message now leads with the schedule's own text and the date.
  - It lists the live open to-dos inline (up to 10, owner-scoped, tasks only).
  - Calendar and unread email remain optional sections.
- **Steering is narrow.** Both the `schedule_create` tool description and the daily agent say:
  - use a reminder for a specific action or a checklist kept in a note;
  - use a briefing when the owner wants to be reminded to review or work through the to-do list.

  The `core` package hash in `plugins/registry.json` is re-pinned.

- **Tests:**
  - `tests/daily-briefing.test.ts` has 2 cases: the lead text and inline tasks with exclusions (done, notes, another owner); and no tasks with optional sections and calls.
  - `tests/daily.test.ts` pins both guidance texts.

Independent review of `0eb79fe` (Opus 5.5): REQUEST CHANGES.

- **Blocking.** The guidance steered checklist reminders to a briefing that never showed the checklist, dropped the owner's wording and arrived as a generic "Daily brief".
- **Non-blocking:**
  - single-task reminders could be misrouted;
  - this entry links entries 92 and 93, which merge first;
  - the trade-offs were missing;
  - the test only pinned wording.

Fixes: the briefing builder change, the narrow steering above, a single-action carve-out, behaviour tests, and this record. Re-review is pending.

## Verification and outcome

- Local checks: typecheck and Prettier pass. The briefing, daily, plugin and agent tests pass with the new pin.
- Not observed yet:
  - a real to-do reminder request becoming a briefing;
  - the rendered Telegram layout.
- Existing frozen to-do reminders in production are not converted. That needs the owner's request.

## Follow-up and next iteration

- Done and Snooze buttons on reminders and briefings.
- Offer an opt-in daily brief once.
