# 45 — Why did a rejected Calendar draft block every later write?

Work date(s): 2026-09-30. Written/revised: 2026-09-30.
Status: released (`55843bb`, `5296dbb`, 30 September 2026); owner accepted. The stuck call was settled by journal 46, not by the operator SQL.

## User-visible problem and preceding iteration

**Reported (owner, 30 September, about 18:04 SGT):** Chief would not add a multi-week event. It said an earlier write had an uncertain status that needed inspection, and a retry was refused the same way. The owner asked whether a draft existed, to avoid creating a duplicate.

[Journal 43](43-calendar-stuck-uncertain.md) fixed a different block: an uncertain Calendar _approval_ that stopped later drafts. It now settles itself by a read-only GET. This incident is an uncertain _runtime call_. It is a separate record, and the owner-wide write guard in `agent.ts` blocks every non-read tool until an operator resolves it ([recovery contract](../reliable-execution.md#inspecting-uncertain-writes)). Journal 43's settlement never sees it.

## Evidence

**Measured (sanitized CloudWatch metadata, `npm run logs:cloudwatch`, 29–30 September):**

- 10:04:33 UTC: one foreground run read Gmail, then called `calendar_draft` once. That call finished in 12 ms as `state=uncertain`, `errorCode=TOOL_FAILED`, and the run stopped `failed`.
- No `calendar.uncertain`, `calendar.reconciled` or `calendar.check_failed` line appears in the 24-hour window. This is weak evidence: saving a draft emits no calendar event, and `calendar.created` is not projected to the logs.
- 10:07:27 and 10:08:01 UTC: two later `calendar_draft` calls failed in 6 ms and 44 ms with `VALIDATION_FAILED`, which is how the guard's "uncertain write requires inspection" error is classified.
- Unknown: the logs keep no tool arguments, so the requested times are not visible. The owner's report implies an event of about 15 days.

**Tested from source:** `validateDraft` rejects an event longer than seven days with a plain `Error`. `toolError` does not recognize that message, so it becomes `TOOL_FAILED`. `CustomAgent` records any `TOOL_FAILED` from a dispatched non-read call as `uncertain` and stops the run. The rejection happens before the approvals query and the insert, so nothing was saved. A new test showed the old code classified it as `TOOL_FAILED`.

**Hypothesis (strong, not confirmed by a database read):** no such draft or approval exists. That is consistent with the 12 ms latency, the `TOOL_FAILED` result and the source order. The operator reconciliation below checks it directly.

## Diagnosis and alternatives

A definite pre-write validation failure used an error class that the runtime cannot distinguish from a failure partway through a write. The conservative default (unknown error on a write → uncertain) is right, so the fix belongs at the source of the error.

- **Chosen:** `validateDraft` throws `ToolValidationError`, the type the host already uses for "established no mutation". It maps to `VALIDATION_FAILED`, and the model can tell the owner about the limit. `CalendarTools.create` still wraps the same check as `CalendarNotSentError`, so the approval path is unchanged.
- **Rejected:** adding the message to `toolError`'s pattern list. That works, but it keys the safety classification on wording.
- **Rejected:** a broader rule such as "a write that fails in under N ms is not uncertain". Timing does not prove non-mutation.
- **Not changed:** the seven-day limit and timed-only events. A longer event (or an all-day event) is a product decision for the owner.

## Implementation and review

- `src/calendar-draft.ts`: the duration check throws `ToolValidationError`.
- `tests/calendar-approval.test.ts`: a 15-day draft and a zero-length draft are each rejected as `VALIDATION_FAILED`, and no approval is saved. The test fails on the previous code.

Independent review (Claude Opus 5.5 subagent, head `bcfb277`): **REQUEST CHANGES**. The code was judged correct:

- every `validateDraft` caller rejects before any mutation
- `CalendarTools.create` still wraps the check as `CalendarNotSentError`
- there is no import cycle
- the test fails on the old code

Findings:

1. **Medium:** the entry named the owner's event and its dates, which is private schedule data in a public repository. Fixed: generalized.
2. **Low:** "no calendar events" was overstated as evidence, because drafting emits no event. Fixed: reworded.
3. **Low, optional:** the test stops at `toolError`, not the `failed`/`uncertain` state in `CustomAgent`. The reviewer confirmed that step through `JobTools.execute` with a scratch test. Kept as is.
4. **Informational:** database failures during drafting still become `TOOL_FAILED` → uncertain. That is intended.

## Operator reconciliation (pending)

The existing uncertain call is not cleared by a release (AGENTS.md: never automatically reset uncertain calls). A guarded one-call SQL script follows the contract in [reliable execution](../reliable-execution.md#inspecting-uncertain-writes). It is kept in the operator's private directory, not in this repository. It changes the call to `failed` only if all of these hold:

- the call is an uncertain `calendar_draft` with `TOOL_FAILED`
- its run is stopped
- the run has no `calendar_create` approval, no successful draft or create receipt, and no `calendar.created` event

It keeps the original error, adds a `reconciliation` object to the result and appends a `runtime.call_reconciled` event. It ends in `ROLLBACK` for a dry run.

Synthetic check (PGlite): the clean case reconciles one call. Each of five refusal cases (an approval exists, the run is still running, a `calendar.created` event exists, a success receipt exists, the call is not uncertain) changes nothing.

## Verification and outcome

`npm run check` passed: 506 application and 21 script tests, plus both Python eval suites. Not released. The owner stays blocked from all writes until the operator reconciliation commits.

## Follow-up and next iteration

- Other write tools may also throw plain `Error`s from pre-write validation. An audit that moves those to `ToolValidationError` would prevent the same class of block. Deferred.
- The owner-wide guard has no self-service path for a runtime call, unlike journal 43's approval settlement. A read-only "prove non-mutation" check for local-only writes such as `calendar_draft` could remove the operator step. Deferred; it needs its own review.
- Product question: support events longer than seven days, or all-day events. Resolved by the follow-up below.

### Follow-up — 2026-09-30: no length limit, all-day events

**Requirement (owner):** Chief should not impose a length limit, and should draft whatever event fits the request.

- **Change:** `validateDraft` no longer caps duration. A timed event still has to end after it starts.
- **Added:** optional `allDay`. It takes `YYYY-MM-DD` dates, and `end` is the event's last day. Google receives `start.date` plus the exclusive next day as `end.date`. The approval preview shows the day range and the number of days.
- **Kept:** the Telegram approval button remains the only way an event is created. No guests, recurrence, editing or deletion.
- **Schema:** the tool-schema converter in `runtime.ts` has no union support, so `start`/`end` use one string pattern (date, or date-time with an offset) with a message that says which. A shape error is a `ZodError` (`INVALID_INPUT`). `validateDraft` rejects the rest as `ToolValidationError`: the wrong form for the event type, an unparseable offset, an end not after the start, or an all-day end on or after 9999-12-31. Neither class can be recorded as an uncertain write.
- **Tests:**
  - a 15-day timed draft saves
  - one-day and multi-day all-day drafts preview correctly
  - an all-day insert sends the exclusive end date
  - eight invalid shapes are rejected and save nothing; `calendar_list` gives an all-day `lastDay`; the date helpers cross year and leap-day boundaries
- **Check:** `npm run check` passed: 507 application and 21 script tests, plus both Python suites.

Independent review (Claude Opus 5.5 subagent, head `0a065b4`): **REQUEST CHANGES.** The date handling (exclusive end, leap days, year boundaries, preview time zones), the error classes and the approval boundary were confirmed correct. Findings and fixes:

1. **Medium:** the `personal-assistance` skill still said drafts are timed. Fixed: the skill text is updated and its repository version bumped to `repo:personal-assistance:5`. An owner-approved private version of that skill, if one exists, is not changed by this; not checked from the cloud session.
2. **Low–medium:** `calendar_list` returned Google's exclusive all-day end with no hint. Fixed: all-day events also carry `lastDay`, and the skill states the convention.
3. **Low:** an unparseable offset such as `+99:99` passed as NaN. Fixed: the end must parse strictly after the start.
4. **Low:** an all-day end of 9999-12-31 produced a malformed exclusive date. Fixed: rejected.
5. **Low:** a pattern failure gave "Invalid". Fixed: the pattern message gives the expected forms. Offsets without a colon (`+0800`) are no longer accepted; a pending stored draft in that form fails as not sent on approval.
6. **Low:** the `AGENTS.md` scope line and this entry's error-class sentence were inaccurate. Fixed.
7. **Check:** test dates were replaced with synthetic ones.

Limitations: Google's handling of edge inputs is inferred from its documentation and was not observed live. Whether the model chooses `allDay` well is untested.

### Release closure — 2026-09-30

- #118 merged as `55843bb`, first logged 10:32:41 UTC. #119 merged as `5296dbb`, first logged 12:00:05 UTC. #120 merged as `03ae852`, first logged 14:18:41 UTC. Each squash-merged at an independently approved head with CI passing. No warn or error lines followed each switch.
- **Live acceptance (measured, CloudWatch metadata, 14:22 UTC):**
  - one `runtime.call_reconciled` settled the 30 September uncertain draft
  - a `calendar_draft` succeeded in the same request
  - `calendar.approval_decided approved=1` followed eight seconds later
  - no `runtime.settle_failed`
- The owner reported the event was added.
- **Not checked:** `release:status` (no `gh` authentication in the cloud session). `calendar.created` is not projected to the logs, so creation rests on the owner's report.
