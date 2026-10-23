# 114 — Why did cancelling old coding jobs blame a work task, and report jobs cancelled that were not?

Work date(s): 2026-10-23. Written/revised: 2026-10-23.
Status: in review. Independent review: approve with nits and one medium finding on `e06cbcf`, all addressed; re-review of the new head pending. Three host changes: unique-index violations are reported by the index they name; `coding_cancel` fails with its reason when nothing changed; and restarting coding work that has waited more than 24 hours needs an explicit owner confirmation in the call. A turn also stops repeating an identical refused call after two refusals, even when reads succeed in between. Not released; no live acceptance yet.

## User-visible problem and preceding iteration

On 20 October the owner asked Chief to cancel several old coding jobs. Most cancels failed, and the error Chief received told it to inspect `work_status` and cancel "the current task". Chief therefore blamed an unrelated durable work task, and the owner agreed to cancel that task, which had nothing to do with the failures. In the same conversation Chief reported some jobs as cancelled that had not changed: one still had its draft PR open (`pr_ready`), and one still waited as a plan (`plan_ready`). Separately, while answering a to-do question, Chief resumed a coding job that had been parked for three days. The `coding_resume` description already said never to resume paused coding work automatically, but the model treated the to-do question as a resume request. The owner cancelled it five minutes later, and in the meantime it held the single coding worker slot.

[Journal 91](91-boxed-subagents.md) (PR 283) found and fixed the cause of the failed cancels: cancelling a paused job reopened its settled sandbox cleanup, which the single-worker index `coding_one_active_worker` counts as active. That fix made the cancels succeed. This entry covers what the same session showed about the host's reporting, which PR 283 did not change: the wrong error mapping, the silent no-op cancel, the retry loop and the unprompted resume.

## Evidence

- **Reported (private production review, 20 October 2026).** 17 `coding_cancel` calls in the session; 15 failed with `ACTIVE_WORK_EXISTS` and the work-task message. One coordinator reply called a `pr_ready` job and a `plan_ready` job cancelled while their states were unchanged. One three-day-old parked job was resumed during an unrelated question and cancelled by the owner about five minutes later. These are counts from the review; this entry does not reproduce the private trace.
- **Code-confirmed, `src/tool-errors.ts` at `9fc5ecc`.** Any message matching `duplicate key` mapped to `ACTIVE_WORK_EXISTS` with "Inspect work_status and revise or cancel the current task before starting another." The only coding unique index that can refuse a cancel is `coding_one_active_worker` (`db/024_coding.sql`).
- **Code-confirmed, `db/013_conversation_control.sql`.** `work_one_active` has not been a unique index since migration 013; it was recreated as an ordinary index. So the work-task guidance could no longer describe any real unique violation. Every `duplicate key` that reached it came from another index.
- **Code-confirmed, `src/coding/controller.ts` at `9fc5ecc`.** The cancel `UPDATE` excludes `pr_ready` unless `autoMerge` is on and the stage is before merging. When it changed no row, the call still returned the job's status, so a caller saw an ordinary success.
- **Code-confirmed and tested.** At `9fc5ecc` a `plan_ready` job is cancellable, including while another job holds the worker slot (new test passes on both the old and new code). Before PR 283, cancel set cleanup to pending for any job with an attempt ID, including a finished plan.
- **Hypothesis.** The `plan_ready` job "reported cancelled" was one of the duplicate-key failures from before PR 283 went live, misreported by the model. The review did not establish the order of calls, so this is not confirmed.
- **Code-confirmed, `src/custom-agent.ts`.** The repeated-failure guard is keyed by operation and argument names, and any successful call clears it. A refused cancel retried between successful `coding_status` reads was therefore never capped.
- **Code-confirmed.** There is no tool or host path that closes a pull request (`src/coding` only reads PR state). The automation sees a PR closed on GitHub and stops at manual review; it does not cancel the job.

## Diagnosis and alternatives

The common mechanism is that the host reported something other than what happened, and the model relayed it. The fixes keep the host's report truthful rather than adding prompt rules.

1. **Index-specific errors.** A unique violation is identified by SQLSTATE `23505` or the `duplicate key` message, and its index from the error's `constraint` field or the quoted name in the message. `coding_one_active_worker` becomes `CODING_WORKER_BUSY` ("another coding job is using the single coding worker slot … This is not a work_status task"). Any other `coding_` index becomes `CODING_CONFLICT`. `work_one_active` keeps `ACTIVE_WORK_EXISTS`, and any other index gets a neutral `DUPLICATE_RECORD`. None of these codes is treated as an uncertain write: a unique violation aborts the single statement, so nothing was written.
2. **No silent no-op cancel.** If the job is not `cancelled` after the update, `coding_cancel` throws a `ToolValidationError` naming the reason and next action. For a published PR: Chief has no tool to close pull requests, the owner can close it on GitHub, and an owner-merge job never merges without the owner's tap. At `merge_approved` the owner has already tapped Merge, so the message says Chief will merge it unless the PR is closed now. If the PR is already closed, nothing further happens and the job stays as a record. For a PR already merging or merged: it cannot be cancelled. An already-cancelled job still returns its status, so retries stay idempotent. Alternative considered: let `coding_cancel` mark a `pr_ready` job cancelled and leave its PR open. Rejected for this change, because the job record would then disagree with GitHub and the owner-merge card; it is a product decision.
3. **Identical-call cap.** A second map, keyed by operation and the exact argument values (key order ignored), counts refusals across the turn. After two refusals in different steps, the next identical call is not dispatched (`REPEATED_FAILURE` with its own message). Successful reads do not reset it; a successful write or new owner input does, because those can change why it was refused. Calls with other arguments are unaffected. The existing form guard (keyed by argument names) now also includes a write's target `id`, so a bulk cancel where several distinct jobs refuse no longer blocks the next, cancellable job; reads keep the names-only form that caps id guessing. The refusal message no longer claims reads cannot matter: a cause the host clears itself (a finished cleanup, a freed worker slot) is reported to the owner, whose next message clears the cap. A limit of two, not three, because an identical refusal is deterministic until something is written.
4. **Stale-work confirmation, host side.** `coding_resume` and `coding_reply` that would requeue a job, and `coding_resume` returning an owner-merge PR to its checks, are refused when the job's `updated_at` is more than 24 hours old and the update could actually restart it (the same state, revision, cleanup and lease conditions as the update itself), unless the arguments carry `confirmStale: true`. The tool descriptions reserve that flag for an explicit owner request in the current conversation to resume or answer that specific job. The age is computed in SQL against the database clock that wrote `updated_at`. Exempt: an idempotent retry of an already-recorded request, and `coding_resume` on a completed plan, which only sends the confirmation card that the owner must still tap. The host's transient retry (`autoRetryOnce`, journal 96) calls its own update, never this path, and only within one day of the pause, so its window never overlaps the gate; the test of it is a regression guard, not a test of the gate. Alternative considered: a prompt-only rule. Rejected because the prompt already forbade automatic resumption and the model still read an unrelated question as a resume request. Limitation: the flag is still the model's assertion, not host proof of owner intent. The refusal gives the model the waiting date and a reason to ask, but it cannot prevent a model that sets the flag unprompted.

## Implementation and review

- `src/tool-errors.ts`: `uniqueViolation` and the four codes; `RepeatedFailureError` gains an identical-call message.
- `src/custom-agent.ts`: `exactCall` and the `refusals` map beside the existing form guard.
- `src/coding/controller.ts`: `cancelRefusal`, the no-change check in `coding_cancel`, and `assertFreshOrConfirmed` before the requeue and owner-merge continue updates.
- `src/coding/schema.ts`: optional `confirmStale` on `coding_resume` and `coding_reply`.
- `src/runtime.ts`: `coding_resume`, `coding_reply` and `coding_cancel` descriptions.
- `docs/coding.md`: the cancel and stale-resume behaviour.
- Tests: `tests/coding-cancel.test.ts` (9 tests), one in `tests/custom-runtime.test.ts` and one in `tests/steering-loop.test.ts`.

Independent review of `e06cbcf` (23 October, Opus 5.5): approve with nits, one medium finding.

- **Medium:** the stale gate ran before the update's own preconditions, so a stale `pr_ready` job awaiting the Merge tap, or a cancelled job, got a false request for confirmation, then a different reason with the flag. Fixed: the gate uses the update's own conditions (`RESTARTABLE`, `CONTINUABLE`) and runs after the merged-PR check. Tested with both jobs.
- **Low-medium:** the form guard blocked a valid bulk cancel after three distinct `pr_ready` refusals. Fixed by including a write's target id in its form; tested end to end through the assistant.
- **Low:** the identical-call message overstated that reads cannot change the cause; softened. `cancelRefusal` was wrong at `merge_approved` and for an already-closed PR; fixed and tested.
- **Nits:** journal wording on policy, the transient-retry test name, an unused column, and a test that new owner input clears the identical-call cap; all addressed.

Re-review of the new head: pending.

## Verification and outcome

- **Tested (synthetic, PGlite).** The new tests pass. Against the original `src` files, 5 of the first 7 coding-cancel tests fail as expected; the `plan_ready` cancel and the transient-retry tests pass on both (they guard existing behaviour). The real `coding_one_active_worker` violation, raised by moving a second job into the worker slot, maps to `CODING_WORKER_BUSY`.
- **Tested.** After the review fixes, all `tests/coding*.test.ts` and `tests/box-coding-task.test.ts` (257 tests), `tests/custom-runtime.test.ts` (29) and `tests/steering-loop.test.ts` (14) pass. The two new review tests and the extended PR-cancel test fail on `e06cbcf`. Related suites also pass: agents, context-continuity, open-loops, mcp, pre-write-validation, tool-domains, work, steering-loop, plugins, library-boundary, calendar-approval, gmail and parcels. `tsc --noEmit` passes. The full `npm test` run was not completed in this session.
- **Not measured.** Whether the clearer errors and descriptions change the model's behaviour in a live conversation; no paid evaluation was run.

Pending: independent review of the exact head, release, and a live check that a refused cancel is reported with its reason.

## Coding-harness learning record

See [coding-agent lessons](coding-agent-lessons.md). What broke: a catch-all error mapping and a status return on a no-op made the host's report disagree with the database, and the model passed both on to the owner. Changed: the host now names the refusing index and fails a no-op cancel. Unmeasured: the effect on live turns. The next small test is a cancel of an owner-merge `pr_ready` job in production, checking that Chief reports it as not cancelled and suggests closing the PR on GitHub.

## Follow-up and next iteration

- Product question for the owner: should `coding_cancel` be able to retire a `pr_ready` job whose PR the owner has already closed? Today such a job stays `pr_ready` (manual review) indefinitely.
- `ACTIVE_WORK_EXISTS` can now only come from a message naming `work_one_active`, which no current index raises. It is kept as asked; removing it is a separate cleanup.
- The identical-call cap keys on exact arguments, so a model that changes `requestKey` on each retry of `coding_resume` is not capped by it. The form guard still applies when no success intervenes. Because a write's form now includes its target id, a model guessing new ids for a write is no longer capped by the form guard; reads are unchanged.
