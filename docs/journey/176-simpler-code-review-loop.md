# 176 — Can one coder session plan and build, with code and review looping until approval?

Work date: 2026-11-12. Written: 2026-11-12.
Status: proposed. Design only, for owner review: [one coding session, then code and review](../coding-simple-loop.md). Nothing implemented, released or measured on the new flow.

> **Update, 13 November 2026 ([journal 179](179-first-full-coding-job-review.md)):** the design page was rewritten after the review of job `9600af57`. It now also runs Pi as shipped (its prompt, tools and protocol), stops reacting to main moving, removes the host check stage and most limits, and replaces the old flow outright with no selector. The measurements and reasoning below are the 12 November record.

> **Update, 12 November 2026 (owner review of PR 468):** the owner found the first draft's summary card over-engineered and set the design to this. The Start button only stops a job from coding before the owner has finished talking; until Start, every owner message joins the request, and no model or box runs. The Start message shows at most the goal in one or two lines: no requirements list, open questions, card editing, card check or plan document. After Start, one coder session codes, an independent Opus reviewer reviews against the owner's messages, and they loop until approval, then the PR and Merge card. A follow-up during the job reaches the coder at its next round without a new Start. Messages that need the owner are one or two sentences with buttons where possible (job `9600af57` sent a long technical paragraph about Kite 0.2.0). The owner answered the draft's open questions, so the design drops them. The sections below describe the first draft; [the design](../coding-simple-loop.md) is the revised version.

## User-visible problem and preceding iteration

A Pi coding job today runs a planner session, a reviewer check of the plan, sometimes a planner repair of the plan, and then, after the owner taps Start, a new coder session in a new box that explores the repository again. The owner reported on 12 November that this feels rigid: a change of mind means a new plan and a new Start, and the owner does not read long plans. The owner asked for a short summary card from the same session that then codes, and code and review loops until the reviewer approves.

This builds on the Start card and plan check from [journal 151](151-review-that-looks-for-failures.md), the delta review from [journal 167](167-review-that-reads-what-changed.md) and the time and effort findings in [journal 169](169-three-hour-coding-attempts.md).

## Evidence

- **Measured, job `9600af57`** (Opus 5.5 for every role, `high` effort; PR 467's profile and journal 169): model cost $51.93, of which the coder was 74%, the reviewer 24% and the planner 2% ($1.12, 15 calls). The plan check added 7 reviewer calls ($0.56). The implementation attempt's new coder session made 173 calls ($19.55) over 102 minutes.
- **Reported (owner):** the automatic rebase re-implemented the approved plan from scratch for about $16.50. A separate PR replaces that with a `git rebase`.
- **Read in code** (`origin/main` `92999f86`): the planner and the builder use different session scopes (`src/coding/pi-worker.ts:215-237`, `694-711`), and every check repair and review repair starts a new coder session (`pi-worker.ts:540`, `1040`). The approval hashes the job id, objective, context and plan (`src/coding/requirements.ts:13-24`). A follow-up on a stopped job forces a new plan (`src/coding/controller.ts:840-855`).
- **Not measured:** how much of the 173 implementation calls re-read what planning had read.

## Diagnosis and alternatives

**Fact:** planning is cheap (2%), so removing it saves little directly. **Hypothesis:** the cost is in the coder starting over after Start and after each repair, and in the rigidity of re-planning for every change. Keeping one coder session across Start and repairs addresses both.

The box cannot wait for the owner's tap, so the design restores the explore session from the session history the worker already uploads, in a new attempt on the same base. Keeping the system prompt and tool list the same in both phases, with write tools refused until approval, keeps the prompt cache valid; changing them would discard it at Start.

Alternatives: keep the plan and only shorten the card (keeps the re-exploration and the re-plan on every change); drop the Start card entirely (loses the owner's approval of scope before any write, which must survive). The card is stored where the plan is today, so the approval, immutability guards and rebase carry-over need no schema change.

## Implementation and review

Design document only: [docs/coding-simple-loop.md](../coding-simple-loop.md). It lists the current flow with line references, the proposed flow, what to remove and keep, the safety properties that must survive, the migration and rollout order, and four questions for the owner. Independent review of the design is pending.

## Verification and outcome

Nothing to verify yet. The design names the measurement: `scripts/coding-job-profile.sql` (PR 467) on the first new-flow jobs against `9600af57`, noting that the Sonnet 5.5 coder and `medium` effort (PR 462) change at the same time.

## Coding-harness learning record

The [coding-agent lessons](coding-agent-lessons.md) guide is updated with the implementation, not with this design.

## Follow-up and next iteration

Owner decisions on the four questions in the design, then the host PR, the worker PR and the image pin in that order.
