# 92 — Why did one refused coding reply block every write for a day?

Work date(s): 2026-10-16 to 2026-10-18. Written/revised: 2026-10-18.
Status: in review. The production lock was cleared by an operator on 18 October. The code fix is in this PR.

## Problem and preceding iteration

On 16 October at 09:57 UTC the owner asked Chief to send a follow-up to a coding job. The coding controller refused it within 21 ms, before writing anything. At that release the refusal was a plain `Error`, which the agent loop classifies as `TOOL_FAILED`. For a write, that becomes `uncertain`.

The uncertain-write guard is owner-wide ([reliable execution](../reliable-execution.md)). From then on, every write Chief attempted for the owner was refused. Coding replies, reminders and other writes all failed until an operator cleared the call about 2 days later.

Only Calendar drafts ([46](46-calendar-draft-self-settlement.md)) and MCP submissions could settle themselves. Nothing settled a coding call.

## Evidence

- **Measured, from the production journal and a two-week review:**
  - One `coding_reply` call was left `uncertain`.
  - After it, 4 writes were refused.
  - Two turns on 17 October made 35 model calls between them and used about 40% of the fortnight's model spend. Each successful read reset the repeated-failure guard, so the model retried the refused write.
  - The refusal never showed in CloudWatch.
- **Measured, at the operator inspection on 18 October:**
  - The call's run had stopped.
  - The job had no `coding_revisions` row after the call.
  - No successful receipt existed.
- **Code-confirmed at main `a9f4547`:**
  - The specific refusal had since become a `ToolValidationError`.
  - Eight other refusals made before any write were still plain errors: a wrong revision, a key conflict, an oversized brief, missing requirements, publication in progress, and others.
  - `failures.clear()` ran after any successful call, so a successful read reset the guard.

## Diagnosis and alternatives

There were three causes. Pre-mutation refusals were classified as possible partial writes. There was no settler for coding calls. And nothing stopped a turn from retrying a refused write.

Alternatives considered:

- **Scope the lock per domain**, so an uncertain coding call doesn't block a reminder. Deferred, because it weakens a deliberately conservative guard. Settling provably empty calls removes the observed failure without that change.
- **End the turn on the first refusal.** Rejected: the turn may still answer usefully from reads.

## Implementation and review

- **`settleUncertainCoding` (`execution.ts`).** Each coding write is idempotent by request key, and its only record is keyed by it:
  - `coding_start` creates a job;
  - `coding_reply` creates a revision;
  - `coding_resume` creates a revision, a `continue:` event or a `requirements:` card.

  A call is recorded as `failed`, with a `reconciliation` object and a `runtime.call_reconciled` event in one statement, when all of these hold: the run has stopped, two minutes have passed, and no such record exists for the key. Calls with unreadable arguments, a missing key, other operations such as `coding_cancel`, running runs, and other owners stay uncertain. The guard runs this before refusing a write, and `/continue` runs it too, as both already do for drafts.

- **Reclassified refusals.** Coding refusals made before any write throw `ToolValidationError`: the controller, `assertCodingBrief` and requirement requests.
- **`WRITE_BLOCKED`.** The guard's refusal is now a `WriteBlockedError`, with its own code and a message telling the model not to retry. Once a turn sees it, later writes in that turn are refused without dispatch. A successful read no longer clears it.
- **Logging.** The `runtime.call_reconciled` projection logs the real operation instead of always `calendar_draft`.
- **Tests:**
  - `tests/coding-settlement.test.ts` has 6 cases: settle, keep when a revision exists, start by key, resume event and card, the left-alone set, and the error mapping.
  - A loop test in `custom-runtime.test.ts`: blocked write, then a successful read, then a second write is still refused, even after the original uncertainty is cleared. Removing the guard makes this test fail.

Independent review: pending.

## Verification and outcome

- **Local checks:** typecheck, Prettier, and all 974 TypeScript tests plus the script, picker, context and decision suites pass. The `evals/coding` fixture test fails locally because of the missing Pydantic environment, and it failed the same way on unchanged main. CI runs the full check.
- **Production, operator action on 18 October, approved by the owner:** call `73d9187d` was settled to `failed` with the same reconciliation shape and event as this code. Afterwards, no `uncertain` calls remain.

Not yet observed: a real coding refusal after this release.

## Follow-up and next iteration

- Two-week review items still open:
  - expiring approval and plan cards;
  - a coding digest in context;
  - live to-do reminders;
  - the context envelope;
  - the Argon cost and caching regression;
  - reply style.
- Add privacy-safe `runtime.write_blocked` and uncertain-count telemetry, so a lock is visible in CloudWatch.
- Revisit per-domain lock scope if another non-settleable uncertainty blocks unrelated writes.
