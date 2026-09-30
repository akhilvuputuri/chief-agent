# 46 — Can a provably empty Calendar draft clear its own uncertainty?

Work date(s): 2026-09-30. Written/revised: 2026-09-30.
Status: in review. Not released.

## User-visible problem and preceding iteration

[Journal 45](45-calendar-draft-duration-uncertain.md) found that a rejected `calendar_draft` had been recorded as an uncertain runtime call. The owner-wide write guard then refused every later write. PR #118 stopped that classification error, but the existing record still needed an operator's guarded SQL. [Journal 43](43-calendar-stuck-uncertain.md) had already made uncertain Calendar _approvals_ settle themselves by a read-only check. Uncertain _runtime calls_ had no equivalent.

**Requirement (owner, 30 September):** Chief should clear such a record itself, not wait for an operator.

## Evidence

**Tested from source:** `calendar_draft` only inserts a local `approvals` row, and `JobTools.execute` then writes a success receipt. It never calls Google. So for a draft, "did it write?" is fully answered by the local database. The two records it leaves on success are an approval in its run and a `calendar_draft` success receipt, both created after the call started.

**Measured:** see journal 45 for the 30 September incident. That call left no approval, per the operator check design. It has not been confirmed by a database read from the cloud session.

## Diagnosis and alternatives

- **Chosen:** before refusing a write, the guard in `agent.ts` runs `settleUncertainDrafts` if any unresolved call is a `calendar_draft`. It records a call as `failed` only when all of these hold:
  - it is an uncertain `calendar_draft` of this owner
  - its run is not running
  - it started more than two minutes ago, so no statement from it can still commit
  - its run has no `calendar_create` approval and no successful `calendar_draft` receipt created since the call started
- **What it records:** it keeps the original error, adds a `reconciliation` object and appends `runtime.call_reconciled`, which is projected to the operational log. The update locks the row and repeats the `uncertain` condition.
- **Guard message:** when a remaining block consists only of drafts, the message tells the model it clears itself from two minutes after the failure.
- **Rejected:** settling every uncertain call type. Other writes reach external systems or have effects that the local records don't prove.
- **Rejected:** settling at release or startup. AGENTS.md forbids resetting uncertain calls during release. Settlement at the guard happens only when the owner makes a new write, and only when it is provable.
- **Accepted limit:** a draft whose insert succeeded but whose result recording failed leaves an approval, so it stays uncertain for an operator.

## Implementation and review

- `src/execution.ts`: `settleUncertainDrafts`.
- `src/agent.ts`: the guard settles, then re-checks.
- `src/ops-log.ts`: projects `runtime.call_reconciled`.
- `docs/reliable-execution.md`: the recovery contract, updated.
- `tests/draft-settlement.test.ts`:
  - a provably empty draft settles and keeps its error
  - six refusal cases: running run, recent call, another write type, another owner, an approval since the call started, a receipt since the call started
  - an approval or receipt from before the call started does not hold it
- `tests/stocks.test.ts`: an old empty draft no longer blocks a watchlist write. The existing test, where a draft that just failed still blocks, is unchanged.

Independent review: pending.

## Verification and outcome

Pending full checks and review. Once released, the owner's next write should log `runtime.call_reconciled` for the 30 September call and proceed, with no operator step.

## Follow-up and next iteration

- Live acceptance: after release, the owner retries the Calendar request. Expect `runtime.call_reconciled`, then a new approval card.
- A review UI for other uncertain call types remains deferred.
