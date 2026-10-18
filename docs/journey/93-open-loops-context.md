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
- **`src/open-loops.ts`** adds `openLoops` to the turn context when something waits on the owner (see [context management](../context-management.md#open-loops)):
  - up to five coding jobs, each with what the owner needs to do;
  - up to three monitoring or Calendar cards that expired unanswered in the last three days.

  A note tells Chief to cover these when asked for status, to revise or resume a listed job instead of starting a duplicate, and to mention an expired card at most once. The section is omitted when empty, and a failed read logs `context.open_loops_failed` without failing the turn.

- **Tests:** `tests/open-loops.test.ts` has 4 cases: an empty context, the waiting states in order, the exclusions, and expired cards. The expiry test in `tests/coding-reasoning.test.ts` now advances past 24 hours.

Independent review: pending.

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
