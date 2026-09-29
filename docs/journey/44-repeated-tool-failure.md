# 44 — Why did one request call parcel_list 25 times?

Work date(s): 2026-09-29. Written/revised: 2026-09-29.
Status: tested (PR open on `claude/calendar-event-creation-bug-nad2ub`). Not released.

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
  - A generic guard in `CustomAgent`: after the same operation fails with the same error code three times in a row in one run, further calls to it are refused without dispatch. They return `REPEATED_FAILURE`, which tells the model to answer with what it has or ask the owner.
  - A success of that operation, or a different error code, resets the count. `finish_turn` is exempt so the model can always answer.
- **Rejected:**
  - Keying on identical arguments. The 28 September loop may have used a different ID each time.
  - Stopping the whole run. The model can still use other tools and give a useful answer.

## Implementation and review

`src/custom-agent.ts` (the per-run `failures` map, `REPEAT_LIMIT = 3`), `src/tool-errors.ts` (`RepeatedFailureError` → `REPEATED_FAILURE`) and `src/parcels.ts`. Tests: `tests/custom-runtime.test.ts` (a model that guesses a new ID on every call gets three real failures, then a refusal, then answers) and `tests/parcels.test.ts` (the message).

Independent review: pending.

## Verification and outcome

`npm run check` and `format:check` pass. Not yet released. After release, a repeat would show three failed calls of one operation followed by a `REPEATED_FAILURE`, instead of dozens.
