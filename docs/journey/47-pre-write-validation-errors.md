# 47 — Which other rejected writes would have blocked every later write?

Work date(s): 2026-09-30. Written/revised: 2026-09-30.
Status: in review. Not released.

## User-visible problem and preceding iteration

[Journal 45](45-calendar-draft-duration-uncertain.md) found that `calendar_draft` rejected input before saving anything, using a plain `Error`. The runtime classified that as `TOOL_FAILED`, recorded the write as uncertain, and the owner-wide write guard then refused every later write. [Journal 46](46-calendar-draft-self-settlement.md) made such drafts settle themselves, but only for `calendar_draft`. After release, the owner asked for a repository scan for the same class of defect.

## Evidence

- **Tested (static scan):** every `throw new Error("…")` literal in `src/` was passed through `toolError`: 125 by the first scan, 120 with the guard test's stricter pattern, fall through to `TOOL_FAILED`. Most are in authentication, plugin, CLI or background code that never runs as a model tool call. The ones reachable from model write tools, before any write, are:
  - `schedule_create`/`schedule_update` (`daily.ts` and the shared `schedule.ts` parser): "Choose a future time", "Limit of 50 active schedules reached" (after a conditional insert that saved nothing), "Supply a new future schedule…", and every parser error.
  - `work_start` and `work_revise` (`work.ts`): "Work needs an active authenticated turn", "This turn is already bound to a task" (twice, including after an atomic insert that saved nothing), "Only a foreground request can start a task", "This turn is already bound to another task".
  - `sheet_sync`/`daily_sync`: the 5,000-row limits, checked before anything is sent to Google.
- **Tested (probe):** with the real parser, `every 30 minutes`, `every day at 13pm`, `0 25 * * *` and `*/30 * * * *` all produced `TOOL_FAILED`. These are ordinary reminder phrasings, so this was the most likely path to a repeat of journal 45.
- **Already correct:** `routines.ts` wraps the same parser's errors in `ToolValidationError`. Parcels, stocks, news, the watch window and calendar drafts reject with `ToolValidationError`.
- **Measured (CloudWatch, 26–30 September, the whole retained window):** apart from the journal 45 call, no write was recorded as `uncertain`. None of these paths had occurred yet.

## Diagnosis and alternatives

- **Chosen:** each pre-write rejection above now throws `ToolValidationError`. `daily.ts` wraps parser errors the way `routines.ts` does.
- **Chosen:** a guard test scans the model-facing write modules for literal plain errors that `toolError` would classify as `TOOL_FAILED`. Each exception carries a reason.
- **Kept conservative:** the `work_revise` refusal "Task is running, leased, or its scope changed". An empty result from its multi-part statement does not by itself prove that nothing was written.
- **Rejected:** treating any fast or early failure as definite. Neither timing nor position proves non-mutation.
- **Deferred:** database constraint errors and third-party library errors still fall through to `TOOL_FAILED`. A message scan cannot find them, and classifying them needs per-statement analysis.

## Implementation and review

- **Source:** `src/daily.ts`, `src/work.ts`, `src/sheets.ts`, `src/daily-sheet.ts`.
- **Tests (`tests/pre-write-validation.test.ts`):**
  - the static guard, which lists all ten old messages when run against the previous code
  - the four real-parser schedule rejections plus a past one-off, each `VALIDATION_FAILED` with no schedule saved

  Both tests fail on the previous code.

Independent review: pending.

## Verification and outcome

`npm run check` passed: 516 application and 21 script tests, plus both Python suites. Not released.

## Follow-up and next iteration

- The guard's module list must grow with new write domains.
- Constraint and library errors remain deferred, as described above.
