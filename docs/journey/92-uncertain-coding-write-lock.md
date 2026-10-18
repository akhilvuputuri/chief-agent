# 92 — Why did one refused coding reply block every write for a day?

Work date(s): 2026-10-16 to 2026-10-18. Written/revised: 2026-10-18.
Status: released. The operator cleared the production lock on 18 October; the code fix (PR 249) deployed as `9437d86` the same day.

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

Independent review of `20dd113` (Opus 5.5): REQUEST CHANGES. There were two blocking findings, both reproduced with tests. Each could wrongly settle a call that did write:

- **Upper-case job id.** The tool schema accepts an upper-case job uuid, but the revision is stored with the canonical lower-case id, so the settler compared text and missed it.
- **Backslash in the request key.** A key containing `\` defeated the `LIKE` match against `requirements:` cards.

The reviewer also found:

- one remaining pre-write refusal still threw a plain error ("authenticated foreground owner request");
- the docs left the deferred MCP replay and the steered-input scope undocumented, and placed the coding paragraph badly;
- tests were missing for both blocking cases.

Fixes:

- The settler now lower-cases a well-formed job id.
- Requirements cards are matched exactly, with a regex prefix and an equality check on the key.
- That refusal is now a validation error.
- The docs are reordered, with both behaviours stated.
- Tests now cover upper-case ids and keys containing `\`, `%`, `_`, `.`, `*` and `(`. Reverting either fix makes its test fail.

The delta review approved `97f1266`.

Devin Review on `97f1266` then reported two further bugs:

- **A child agent's block didn't reach the coordinator.** When a delegated agent hit `WRITE_BLOCKED`, the coordinator could re-delegate the same write to a fresh agent.
- **The coding-agent learning guide wasn't updated,** which the repository requires for coding-harness changes.

Fixes:

- `agent_run` results now carry `writesBlocked` when the child had a write refused.
- The coordinator adopts that block, and a blocked turn also refuses new `agent_run` delegations. Reads still run.
- A regression test covers the child path, and fails when the delegation refusal is removed.
- [The learning guide](coding-agent-lessons.md) has a new entry.

The delta review approved `3711831`. Its one non-blocking note: while blocked, read-only delegations (research, email, media) are also refused. A media attachment can only be read in the turn it arrives, so a follow-up may refuse only agent types that have write tools.

Devin on `3711831` reported that a failed child lookup returned "not blocked", which still permitted repeat delegations. The lookup now fails closed: an error is logged as `agent.block_check_failed` and the child is treated as blocked. A test covers this and fails when the fallback is reverted to "not blocked". The delta review approved `7d36754`.

## Verification and outcome

- **Local checks:** typecheck, Prettier, and all 974 TypeScript tests plus the script, picker, context and decision suites pass. The `evals/coding` fixture test fails locally because of the missing Pydantic environment, and it failed the same way on unchanged main. CI runs the full check.
- **Production, operator action on 18 October, approved by the owner:** call `73d9187d` was settled to `failed` with the same reconciliation shape and event as this code. Afterwards, no `uncertain` calls remain.

Not yet observed: a real coding refusal after this release.

### Release closure — 2026-10-18

- **PR:** [249](https://github.com/akhilvuputuri/chief-agent/pull/249). The independent Opus 5.5 review approved the final head `7d36754a1c0343e0dbc1ac7d70671228df3a00f6` in round 4. Hosted CI and Devin passed there, and every Devin finding was resolved.
- **Merge:** squash merge as `9437d860a15312933e82999d966a805889cd8cf1`.
- **Release:** [run 39134957820](https://github.com/akhilvuputuri/chief-agent/actions/runs/39134957820). `npm run release:status` for the exact SHA returned `success` at 14:17:03Z (exact commit deployed, startup health passed), and CloudWatch shows `9437d86` running from 14:16 UTC.
- **Versioning:** deployed after v0.3.83, without a version bump or tag ([releases](../releases.md)).
- **Not yet observed:** a real coding refusal in production after this release.

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
