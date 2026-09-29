# 44 — Why did one request call parcel_list 25 times?

Work date(s): 2026-09-29. Written/revised: 2026-09-29.
Status: released (`4042743`, 29 September 2026).

## User-visible problem and preceding iteration

**Measured (sanitized CloudWatch metadata, run `63027f7a`, 28 September 23:39–23:41 SGT):** one foreground request made 25 consecutive `parcel_list` calls. Each failed in about 10 ms with `VALIDATION_FAILED`, before the model finally answered. That took 26 model calls, about US$0.20, and two minutes. The owner did not report it; it was found while investigating [journal 43](43-calendar-stuck-uncertain.md). The delivery tracker is described in [journal 33](33-delivery-tracker.md).

## Evidence

- **Tested from source:** a schema rejection would be logged as `INVALID_INPUT` (a `ZodError`). The only `VALIDATION_FAILED` that `parcel_list` can raise is `ParcelTools.owned()` → "Parcel not found". So every call passed a well-formed UUID that is not one of the owner's parcels.
- **Unknown:** the logs keep no tool arguments, so we cannot tell which IDs were tried, whether they differed, or where they came from. Other UUIDs the model sees include messages, observations, approvals and saved records.
- **Tested from source:** the agent loop retries only transient read errors by itself. Nothing limited the model from calling a tool again after the same non-retryable failure. Only the run budget (40 model calls, 100 tool calls) would have stopped it.

## Diagnosis and alternatives

Two gaps combined. The error gave no route to a valid ID, and the loop had no limit on repeating the same failure.

- **Chosen:**
  - The "Parcel not found" message now says that parcel IDs come only from `parcel_list` (without an ID) or `parcel_match`, and not to guess or reuse other record IDs.
  - A generic guard in `CustomAgent`, keyed by _call form_: the operation plus its argument names. Once one form has failed with the same error code in three model steps with no successful call in between, calls of that form from the next step on are refused without dispatch. They return `REPEATED_FAILURE`, which tells the model to use another form, answer with what it has, or ask the owner.
- **Reset rules:**
  - Any successful call clears every count, because a success may supply what the failing form lacked (Devin Review: an ID found by `parcel_match` must still be readable). A different error code resets that form's count. A run of consecutive failures, like 28 September's, is still stopped. A loop that alternates a successful call with a failing one is not: only the run budget bounds it (accepted limit, same as before this change).
  - Parallel calls in one step count once, so a batch ("watch these six tickers") is not cut short by its own failures.
  - New owner input adopted mid-run (steering) clears every count. The model can then act on an ID the owner supplies.
  - `finish_turn` is exempt, so the model can always answer.
- **Rejected:**
  - Keying on the operation alone (the first draft). Independent review found it blocked the recovery call the new message recommends: `parcel_list` without an ID after three bad-ID reads.
  - Keying on identical arguments. The 28 September loop may have used a different ID each time.
  - Stopping the whole run. The model can still use other tools and give a useful answer.
- **Accepted trade-off:** sequential per-item batches whose first three items fail the same way stop there; the fourth call of that form is refused. Remaining items need another request.

## Implementation and review

`src/custom-agent.ts` (the per-run `failures` map, `REPEAT_LIMIT = 3`), `src/tool-errors.ts` (`RepeatedFailureError` → `REPEATED_FAILURE`) and `src/parcels.ts`. Tests in `tests/custom-runtime.test.ts` cover:

- A scripted run where parallel calls count once and a different code restarts the count. After three consecutive failing steps the next call is refused, another form is still dispatched, and repeated invalid `finish_turn` calls are never refused.
- A success of the same form, and a success of another operation, each resetting the count.

`tests/parcels.test.ts` covers the message. The steering reset is verified by reading the code only.

Independent review (Claude Opus 5.5 subagent, head `0046f00`): **REQUEST CHANGES.**

1. **Medium:** keying on the operation alone blocked the recommended recovery (`parcel_list` without an ID).
2. **Medium:** steering did not reset the counts.
3. **Low–medium:** broad error codes cut per-item batches short.
4. **Low:** thin tests.
5. **Low:** "this turn" wording.

All were addressed by the call-form key, per-step counting, the steering reset, the new tests and the reworded message.

Devin Review (same head) raised two more points:

- **Red:** a correct ID recovered through `parcel_match` would still be refused. Fixed: any success clears all counts.
- **Yellow:** refused calls still consume model calls. Kept as is: the run's model budget caps them, and the refusal tells the model to stop.

Re-review of `0843897`: **APPROVE**, with Low notes.

- **Fixed:** a form reaching the limit mid-step no longer refuses the rest of that step.
- **Fixed:** the wording "in a row" is now "with no successful call in between".
- **Accepted:** fan-out within one step is bounded only by the tool budget.
- **Accepted:** a changed argument name makes a new form. This is loop protection, not enforcement.
- **Accepted:** the steering reset has no test.

Re-review of `a132a2a`: **APPROVE**. One Low note is accepted as a limit and recorded above: a loop that alternates success and failure is not caught.

## Verification and outcome

`npm run check` and `format:check` pass. A repeat would now show three failed steps of one call form followed by a `REPEATED_FAILURE`, instead of dozens.

### Release closure — 2026-09-29

- **Merge:** [PR #116](https://github.com/akhilvuputuri/chief-agent/pull/116) merged as `4042743`. Its exact head `a132a2a` was independently approved and CI passed. Both Devin threads were answered and resolved.
- **Release:** CloudWatch logged release `4042743` from 04:28:20 UTC, with gateway heartbeats every five minutes and no warn or error lines in the first 15 minutes.
- **Not checked:** `release:status` was not run from the cloud session, which has no `gh` authentication.
- **Pending:** no live repeat has occurred yet, so the guard has not been observed in production.
