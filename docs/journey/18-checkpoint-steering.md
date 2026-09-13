# 18 — Accepting corrections without discarding active reasoning

Work date: 2026-09-13. Written: 2026-09-13. Revised: 2026-09-14.
Status: released v0.3.9 at `9c6335be09582432d9bf7c4a475c90f9b5e9272a`; real Telegram behavioral acceptance remains separate. Baseline v0.3.8: `d0e33365c7cec7b7cb1eb64c22de7c09d5d9a314`.

## User-visible problem

The rolling-conversation release made intake durable and separated foreground chat from background jobs, but ordinary follow-ups still aborted in-flight reasoning and started a replacement foreground run. A correction could discard usable reasoning, receive another allocation and compete with file preparation or delivery of an answer based on the previous input. Image handling needed special treatment because only the live process retained the bytes.

## Evidence

The v0.3.8 source establishes the interrupt-and-replace behavior. This change follows the approved checkpoint-steering design. New tests use controlled model/tool completions and synthetic source records to expose the timing boundaries; they contain no private production conversations. These are deterministic host-behavior checks. They are not a measured production latency, cost or conversational-quality comparison.

## Diagnosis and alternatives

The input inbox, execution checkpoint and outbound delivery need separate lifetimes. Stopping every model request as soon as another message arrives discards its eventual response. Letting an old batch dispatch after a correction can act on stale instructions. The chosen boundary lets the active model or dispatched tool finish and be recorded, then closes unstarted calls before incorporating ordered input. There is no debounce heuristic or concurrent foreground mutation loop.

An unbound run can safely keep its allocation and source observations while adopting new input. A run already bound to a durable task instead pauses that task and hands new input back to the foreground inbox. Neither path authorizes replaying a skipped write or automatically resuming paused work.

## Implementation

[The loop](../../src/custom-agent.ts) preserves full model responses and completed tool results, adds `NOT_DISPATCHED` observations for skipped calls and consumes new inputs at checkpoints. Input-to-message references stay owner/run scoped. Undelivered final replies remain in the run journal but leave the model/chat projection.

[The inbox](../../src/input-inbox.ts) separates immediate durable intake from readiness and ephemeral attachment availability. [Telegram](../../src/telegram.ts) permits two preparations per user, while execution and delivery have their own boundaries. Delivery revisions suppress stale text/speech before dispatch; pending conversation replies become visible to history only after delivery is recorded. Reset commits after the previous foreground commit rather than racing it.

[The read-only specialist runner](../../src/research.ts) yields cooperatively and returns exact partial source references. [Media delegation](../../src/media.ts) preserves these references and keeps current attachments usable by the parent after an interruption. Migration014 adds preparation, consumption/message-reference and delivery-state fields without replacing existing data. The [rollout guide](../checkpoint-steering.md) specifies baseline checks and additive rollback.

## Verification and outcome

During implementation, all 13 new [loop/child regression tests](../../tests/steering-loop.test.ts) and 38 existing runtime/research/media/delegation-accounting tests passed. TypeScript checking also passed after the added timing test, which verifies that attachment-preparation waits do not consume active execution time. These checks cover ordinary-input completion, ordered same-run adoption, write preservation, journal/authorization races, final suppression, cancellation, task handoff and partial source retention. At that implementation stage, the broader integrated change still needed full checks and exact-head independent review. Eight offline mocked operator-rollout scenarios passed, and all five new diagnostics queries ran against migrated synthetic PGlite data without returning private text or owner identifiers. No paid smoke test or paid evaluation was run.

At the initial 13 September candidate stage, the deployment script was prepared for the exact v0.3.8 baseline but had not been installed or executed. The release closure below records the later verified rollout. A dispatched Telegram send cannot be recalled. A send that succeeds before its receipt is recorded can remain conservatively pending; the runtime does not automatically resend. Ephemeral attachment bytes cannot survive a process restart.

## Follow-up

Full integration checks, independent Astra review, CI, the reviewed operator migration014 rollout and exact SHA/health/data verification were the release prerequisites; their completion is recorded below. A bounded real Telegram acceptance check remains a separate follow-up. Retain the deferred observable-memory and evaluation branches; this work does not complete or release them.

## Independent review follow-up

The first exact-head Astra review requested changes because in-memory final-suppression indices were lost when a paused task later reloaded its run history. The rolling conversation correctly hid the final, but a granted task resume could reintroduce that undelivered assistant text. Migration014 now adds owner/run/message-index projection exclusions without modifying the original payload. The loop persists pending or superseded final exclusions at its completed checkpoints; delivery releases only pending exclusions. Run-history selection honors them after a fresh Assistant instance is created. Durable input indices also provide the lower boundary for task history when consecutive user messages have identical text.

The three [resume/storage regressions](../../tests/steering-resume.test.ts), 13 loop tests and 15 history tests passed during this fix. They cover a bound-task handoff followed by grant/resume, pending final candidates, duplicate occurrences, owner isolation, mixed invalid references and permanent superseded exclusions. At this correction stage the updated head still required reviewer approval and release checks; the final closure below supersedes that pending status without erasing the finding.

Both independent Astra reviews of PR #42 at `db6dd60c079fc4679f6c8caaf73e0e4e1c475718` requested changes. Additional findings covered a revision-query race in the delivery fence, task-specific cancellation after execution had ended, a text-equality resume anchor that conflated repeated input, and the ordinary cloud release guard overlooking attachment preparation. Regression tests hold the database revision response while inserting input or cancelling, cancel exact versus unrelated jobs, and resume two identical input occurrences with a completed tool group between them. The normal release command now refuses queued/running conversation input as well as running runtime work. Three offline tests in `scripts/test-cloud-release.py` verify preparation refusal, active-run refusal and a successful idle release without Docker or production access.

A subsequent implementation audit found a crash window if a final checkpoint committed before its separate pending-exclusion write. The checkpoint now appends immutable references and pending exclusions atomically. Two additional regression tests inspect visibility immediately at checkpoint return and inject an exclusion-write failure to prove that counters, content, references and exclusions all roll back; the exact retry appends once. These five resume/storage tests, together with the loop and history suites, passed (33 focused tests).

Final local review-fix validation passed: 229 application tests, two Google-scope tests, three offline normal-release guard tests, eight mocked one-time rollout scenarios, TypeScript checking, build and repository formatting. Exact-head re-review and production evidence are recorded on [PR #42](https://github.com/akhilvuputuri/companion-agent/pull/42) and the [published release record](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.9). This journal distinguishes those deterministic checks from a later live Telegram acceptance check.

Second independent review: storage/migration/rollout APPROVE at `1d111e334a551edbfd5f5b8d4f7c295f6454eb0c`; runtime REQUEST CHANGES on a remaining selected-task cancellation window after the runtime row stopped but before pending delivery was registered. Cancellation now matches the still-owned foreground run through finalization, and its aborted controller propagates into the eventual delivery fence. A regression holds the persisted `runtime.stopped` event, cancels that exact task, then verifies the eventual reply remains fenced and task stays cancelled. Approval of an older head does not authorize the final revision; the PR records renewed exact-head review.

## Release closure — 14 September 2026

[v0.3.9](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.9) shipped [PR #42](https://github.com/akhilvuputuri/companion-agent/pull/42) at `9c6335be09582432d9bf7c4a475c90f9b5e9272a`. The [release workflow](https://github.com/akhilvuputuri/companion-agent/actions/runs/34764417365) completed successfully for that exact SHA; published release evidence records deployment and health verification. Two independent GPT-6 Astra reviewers approved final head `79297e16dd218d8565c86545b7d2ef98da94d1e0`, and the merged tree matches that reviewed head. Final validation increased to 230 application tests plus two Google-scope tests, typecheck/build/format, three offline release-guard tests and eight mocked operator-rollout scenarios. The earlier REQUEST CHANGES verdicts above remain part of the sequence.

The reviewed rollout applied migration014 and verified the exact release, health, the trusted release handler, bounded history loading and unchanged aggregate domain/history counts; paused work remained paused. [Subsequent production diagnostics](https://github.com/akhilvuputuri/companion-agent/actions/runs/34769892493) completed successfully. No paid evaluation or production conversation replay was performed. Startup/metadata verification and mocked timing regressions do not establish a real Telegram behavioral, latency, cost or conversational-quality improvement; that acceptance remains open.
