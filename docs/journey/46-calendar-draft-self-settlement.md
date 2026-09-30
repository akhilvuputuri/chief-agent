# 46 — Can a provably empty Calendar draft clear its own uncertainty?

Work date(s): 2026-09-30. Written/revised: 2026-09-30.
Status: in review. Not released.

## User-visible problem and preceding iteration

[Journal 45](45-calendar-draft-duration-uncertain.md) found that a rejected `calendar_draft` had been recorded as an uncertain runtime call. The owner-wide write guard then refused every later write. PR #118 stopped that classification error, but the existing record still needed an operator's guarded SQL. [Journal 43](43-calendar-stuck-uncertain.md) had already made uncertain Calendar _approvals_ settle themselves by a read-only check. Uncertain _runtime calls_ had no equivalent.

**Requirement (owner, 30 September):** Chief should clear such a record itself, not wait for an operator.

## Evidence

**Tested from source:**

- A new draft's only records are one `calendar_create` approval in its run and, after `CalendarActions.draft` returns, one success receipt from `JobTools.execute`. A successful draft call stores both IDs in its result (`result.approvalId`, `receiptId`).
- Before inserting, `draft()` may settle an _earlier_ unresolved approval. That path does a read-only Google GET, updates that approval, writes `calendar.reconciled`/`calendar.created` events, and writes a `calendar_create` receipt on the earlier approval's run. None of these creates a new approval or a `calendar_draft` receipt, so none can be mistaken for this call's output.
- A call becomes `uncertain` only after its dispatch has returned. Restart recovery stops the run of any call a crash interrupted. So once the run has stopped, nothing from the call is still executing in the application.
- `calendar_draft` cannot run in a child run: research and specialist runs refuse writes. So the approval's `run_id` is the call's run.

**Hypothesis (not confirmed by a database read):** the 30 September call left no approval (journal 45).

## Diagnosis and alternatives

- **Chosen:** before refusing a write, the guard in `agent.ts` runs `settleUncertainDrafts` if any unresolved call is a `calendar_draft`. It records a call as `failed` only when all of these hold:
  - it is an uncertain `calendar_draft` of this owner
  - its run is not running
  - it started more than two minutes ago
  - every `calendar_create` approval and every successful `calendar_draft` receipt in its run is accounted for by a successful draft call's stored IDs
- **Why accounting, not timestamps:** comparing `created_at` values across transactions would trust the database clock. Accounting does not.
- **The two-minute wait:** margin only. The guarantees come from the ordering above. No statement timeout is configured, so the wait is not presented as a bound on in-flight statements.
- **What it records:** it keeps the original error and adds a `reconciliation` object. It inserts `runtime.call_reconciled` in the same statement as the update, then projects it to the operational log. The update locks the row and repeats the `uncertain` condition, so concurrent guards cannot settle twice.
- **Failure fallback:** the guard runs after the current call is marked dispatched, so any settlement error is caught. The guard then refuses as before (`VALIDATION_FAILED`) and logs `runtime.settle_failed`; the current write is never made uncertain.
- **Guard message:** if a refusal remains and every unresolved call is a draft, the message says it is checked again on the owner's next write, from two minutes after it started.
- **Operator rule difference:** it omits the `calendar.created` check, because that event requires an approval, and every approval in the run must be accounted for.
- **Rejected:** settling every uncertain call type. Other writes reach external systems or have effects that local records don't prove.
- **Rejected:** settling at release or startup, which AGENTS.md forbids. This settlement records a verified outcome when the owner writes, following the [journal 43](43-calendar-stuck-uncertain.md) precedent.
- **Accepted limit:** a draft whose insert succeeded but whose result recording failed leaves an unaccounted approval, so it stays uncertain for an operator.

## Implementation and review

- `src/execution.ts`: `settleUncertainDrafts`.
- `src/agent.ts`: the guard settles, re-checks, and falls back on failure.
- `src/ops-log.ts`: projects `runtime.call_reconciled`.
- `docs/reliable-execution.md` and `HANDOVER.md`: updated.
- `tests/draft-settlement.test.ts`:
  - a draft with only a failed receipt settles and keeps its error, and a second pass does nothing
  - six refusal cases: running run, recent call, another write type, another owner, an unaccounted approval dated an hour earlier, an unaccounted success receipt dated an hour earlier
  - records accounted for by an earlier successful draft call, and approvals for other operations, do not hold it
  - the two-minute boundary (110 s held, 130 s settled)
- `tests/stocks.test.ts`:
  - an old empty draft no longer blocks a watchlist write
  - if the settlement statement fails, the write is refused (`failed`, not `uncertain`) with the draft message, and the old call stays uncertain; this test fails when the fallback is removed
  - the existing test, where a recent draft still blocks, is unchanged

Independent review (Claude Opus 5.5 subagent, head `d8015f8`): **REQUEST CHANGES.**

1. **Medium:** a settlement error inside the guard would have made the current, never-sent write uncertain, and the event was a separate statement from the update. Fixed: one statement, plus the guarded fallback.
2. **Low:** the proof leaned on cross-transaction timestamps, and the two-minute claim was unsupported. Fixed: accounting replaces timestamps, and the basis is documented.
3. **Low:** the docs overstated what a draft writes, a hypothesis was labelled as a measurement, and two documents were stale. Fixed.
4. **Low:** the guard message was imprecise. Fixed.
5. **Low:** test gaps (a tautological assertion, a missing failed receipt, the boundary case, the failure path). Fixed.

The reviewer confirmed child runs, owner scoping, the restart path, concurrent guards, the ops-log sanitisation and the AGENTS.md reading as sound.

## Verification and outcome

`npm run check` passed: 513 application and 21 script tests, plus both Python suites. Not released. Once released, the owner's next write should log `runtime.call_reconciled` for the 30 September call and proceed, with no operator step.

## Follow-up and next iteration

- Live acceptance: after release, the owner retries the Calendar request. Expect `runtime.call_reconciled`, then a new approval card.
- A review UI for other uncertain call types remains deferred.
