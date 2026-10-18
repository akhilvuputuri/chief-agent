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

This was a capability-selection gap, not missing code. The live list already existed as the briefing kind; the agent had no reason to choose it.

Alternatives considered:

- **A new `includeTasks` flag on reminders.** Deferred: it is a schema and behaviour change, while the briefing kind already does this.
- **Done/Snooze buttons on reminders.** A separate, larger change, and still the next step.

## Implementation and review

- **`schedule_create` gets a tool description.** It says a reminder sends its content as written now, a briefing lists live open to-dos at send time, and reminders about the to-do list, tasks or a checklist should be briefings.
- **The daily agent definition (`plugins/core/agents/daily.md`)** says the same. The `core` package hash in `plugins/registry.json` is re-pinned.
- **Test:** `tests/daily.test.ts` pins both texts.

Independent review: pending.

## Verification and outcome

- Local checks: typecheck and Prettier pass. The plugin and agent tests pass with the new pin.
- Not observed yet: a real to-do reminder request going to a briefing.
- Existing frozen to-do reminders in production are not converted. That needs the owner's request, because it changes saved schedules.

## Follow-up and next iteration

- Done and Snooze buttons on reminders and briefings.
- Offer an opt-in daily brief once.
