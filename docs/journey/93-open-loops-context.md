# 93 — Why did Chief forget plans and cards that were waiting on the owner?

Work date(s): 2026-10-18. Written/revised: 2026-10-18.
Status: in review.

## Problem and preceding iteration

The two-week production review (3–17 October; see [92](92-uncertain-coding-write-lock.md) for the write-lock incident from the same review) found three related gaps:

- **Coding requirements cards expired after 15 minutes.** Five complete plans for the owner's to-do reminder fix lapsed unconfirmed. Chief then started fresh jobs instead of offering the ready plans again. When the owner asked for status, Chief's answer left out two finished plans, because the turn context carried pending Calendar and Library approvals but no coding jobs.
- **Monitoring confirmation cards used the 15-minute database default.** A flight-monitoring card lapsed unconfirmed before the flight, and nothing followed up.
- **The same change ran as two jobs and produced two PRs** (#232 and #239).

## Evidence

- **Measured,** from the production journal reviewed under the owner's authorization. Only aggregates appear here.
  - **Coding:** of 10 owner coding jobs, 4 produced a plan and none merged.
  - **Owner effort:** of 27 owner coding messages, 12 were restarts or re-asks and 10 were status checks.
  - **Waiting:** the median approval took 5.1 minutes once the owner engaged. The median gap after a pause was 7 hours.
- **Code-confirmed at `a9f4547`:**
  - `confirmUntil` was set to now plus 900,000 ms for requirements cards.
  - `responsibility_confirm` used the `approvals.expires_at` default of 15 minutes.
  - The runtime context in `agent.ts` had no coding state.

## Diagnosis and alternatives

Both cards are already bound to exact content:

- **Requirements** check the revision, plan, scope and artifact hash.
- **Monitoring** checks the base revision and spec.

So a longer validity window cannot approve stale content. A changed job or concern still rejects the old card.

Alternatives considered:

- **A scheduler that re-sends expired cards.** Rejected for now: it adds unrequested messages. Instead, Chief offers a fresh card once when the owner next talks to it.
- **Adding coding jobs to Chief's general memory.** Rejected: the state is already authoritative in `coding_jobs`, so a bounded read per turn is enough.

## Implementation and review

- **Requirements cards** stay valid for 24 hours, and the card text says so. Merge cards keep 7 days.
- **Monitoring confirmation cards** stay valid for 24 hours, and the tool notice says so.
- **`src/open-loops.ts`** adds `openLoops` to the foreground turn context when something waits on the owner (see [context management](../context-management.md#open-loops)):
  - up to five coding jobs, each with a host-written `awaiting` label and the worker's text in a separate field, marked as data;
  - up to three delivered, unsuperseded monitoring cards that expired unanswered in the last day.

  The note tells Chief to cover these when asked for status, to revise or resume a listed job instead of starting a duplicate, and to mention an expired card only when relevant. A failed read logs `context.open_loops_failed` without failing the turn.

- **Tests:**
  - `tests/open-loops.test.ts` has 7 cases, using the real card shapes (`:finished` and `requirements:` keys).
  - `tests/coding-reasoning.test.ts` confirms a card 23 hours after delivery and rejects one after 24 hours.

Independent review of `631a402` (Opus 5.5): REQUEST CHANGES. The reviewer confirmed that 24-hour validity is safe for both cards, then found two blocking defects, both reproduced:

- **The first card was always "expired".** It is the attempt's `:finished` event. The view matched only `requirements:` keys, so every live first card was reported as expired, and Chief would have offered a duplicate.
- **A plan the owner asked to change showed as ready.** The view said "offer a fresh card" instead of asking what to change. An undecided card from an older revision could also count as open.

It also found non-blocking issues:

- expired cards that were superseded or never delivered were listed, with no subject;
- Merge cards were missing;
- worker-written text was spliced into host guidance, and background lanes received the section;
- no test pinned the 24-hour value;
- a day-old monitoring confirmation uses values computed at proposal time.

Fixes:

- Cards are matched by their `requirements` payload at the current revision.
- A revise decision is reported as such.
- An undelivered card has its own label.
- Merge cards are included.
- Worker text is in a separate field.
- The section is foreground only.
- Expired cards are monitoring only: delivered, not superseded, from the last day, with their title.
- Tests are added, including mutation-checked pins.

The stale proposal-time values for monitoring remain a documented limitation. Confirming still binds the exact spec, and the worker treats a passed expiry as expired. Re-review is pending.

## Verification and outcome

- Local checks: typecheck and Prettier pass, and the TypeScript suite passes. The only local failure is the `evals/coding` fixture test, which needs the Pydantic environment and also fails on main.
- Not yet observed:
  - Chief using `openLoops` in a real status answer.
  - Chief avoiding a duplicate job.
  - Whether the extra context, at most a few kilobytes, measurably affects context pressure.

## Follow-up and next iteration

- Live to-do reminders through the briefing kind.
- One automatic retry for classified transient coding faults (owner-approved).
- Pause notices that name the cause.
- A shadow-measured proactive nudge for expired cards, if the owner-turn offer is not enough.
