# 115 — Can a coding job keep the owner informed without a message per milestone?

Work date: 2026-10-23. Written: 2026-10-23.
Status: in review. The notice changes and the rebase measurement are implemented and pass their offline tests. Independent review approved `11cc462` with nits; the fixes are in place, and re-review is pending. CI, release and a live job after the release are pending.

## User-visible problem and preceding iteration

[PR 292](https://github.com/akhilvuputuri/chief-agent/pull/292) ([journal 91](91-boxed-subagents.md)) put coding progress into plain words ("Implementation started", "Check passed: npm run check"). It changed the wording, not the number of messages: every worker milestone, automatic re-queue, PR notice and cancellation was still its own Telegram message in the Coding topic.

A private production review of 14–20 October 2026 (reported, aggregates only) found:

- **Notice volume.** 107 coding notices in 7 days. One job, a two-line README change, sent 42 messages: about 8–10 per box attempt, multiplied by its rebase rounds.
- **Night pings.** 24 of the 107 were sent in quiet hours (night, Singapore time), 3 of them after the latest release.
- **Docs-only rebases.** About 42 minutes of box time went on that docs-only diff, which rebased twice. Each rebase re-implements the approved plan on current main, then repeats the checks and the full independent review ([journal 87](87-pi-owner-merge-feedback.md)).

Expected behaviour: one status message per stretch of work, edited as it progresses. Questions, approval cards, failures and results still arrive as their own messages, so the owner is notified when something needs them. Nothing progress-only pings at night.

## Evidence

- **Reported:** the counts above, from the owner's private review. They are not re-measured here, and no private trace is copied.
- **Read from source (23 October 2026):**
  - Every pending `coding_events` row became one `send` in `CodingController.deliver`, one claim per 15-second tick (`src/main.ts`).
  - The outbox had no edit path, although the bot already edits messages elsewhere (`TelegramViews`, the library link ceremony).
  - Worker progress (`progress()`), the automatic retry, rebase and feedback re-queues, the approved candidate (`:finished`) and each publication (`:pr`, including the same PR rebuilt after a rebase) were all pending notices.
  - A rebase sets the new revision's files and patch to empty. The worker then re-implements, re-checks and asks the reviewer again, and the host accepts only a sealed reviewer response from the same attempt (`hasPiReviewerProof`).
- **Tested (synthetic, PGlite):** the behaviours in the implementation section below.

## Diagnosis and alternatives

The volume comes from delivery, not from the worker: each milestone is a separate outbox row, and each row became a separate message. Three changes follow from that.

- **One status message, edited in place.** Progress-only notices fold into a status message per job. Its message id and lines are kept in one suppressed `status-message` event per job, so no migration is needed.
  - A separate notice for the job (question, approval card, pause or failure, PR, merge, deploy, manual-review stop) closes the status message. The next progress starts a new one below it, so the status never sits above a newer call to action.
  - Rejected: a single message per job for its whole life. It would end up far above the cards the owner acts on, and an edit there would go unseen.
  - Rejected: per-attempt messages regardless of separate notices. A plan card or PR between two progress bursts would then be followed by edits to a message above it.
- **Quiet hours.** Edits do not notify, so editing the current status message continues at night. Progress that would need a new message waits until the window ends (`CODING_QUIET_HOURS`, default `23:00-08:00`, Asia/Singapore). If a separate notice was sent after held progress, that progress is superseded and suppressed rather than shown out of order in the morning.
  - Rejected: sending silently (`disable_notification`). It still adds a message, and the request was to defer or fold.
  - Questions and approval cards are never held. Failures and outcomes are not held either, because they are not progress.
- **Cancellations.** Pending cancellations for one owner become one summary, naming each job by its objective (first line, 80 characters) and its id. A cancellation waits 15 seconds before delivery, so a bulk cancel made in one turn lands in one message.
- **The coder's summary.** Folding the approved candidate into the status message would cut the coder's summary, previously up to 1,500 characters, to one status line. In quiet hours that line can even be superseded before it is sent. Owner-merge jobs see the summary again on the Merge card (800 characters); autoMerge and draft-only jobs would not. So the first PR notice of a job outside the owner-merge workflow now carries the summary, bounded to 800 characters like the Merge card. The PR notice is a separate message, never held, so the summary always arrives. Rejected: keeping `:finished` separate for those jobs. That puts back one message per attempt and still sends the "publishing" notice and the PR notice back to back.

**Rebase review reuse: detection only.** The goal was to skip the repeat review when a rebase reproduces the reviewed candidate byte for byte. Two findings make that larger than this change:

- **It needs a worker release.** The worker decides whether to call the reviewer, and it runs from a pinned image. Its strict schemas reject unknown assignment or checkpoint fields, so the change needs a two-phase rollout: publish and pin the worker first, then enable the host side.
- **It changes the owner's review exception.** The host's Pi review proof is a sealed reviewer response from the same attempt, with the same base. Reusing an approval from the previous attempt also means the reviewer saw the diff against the old main, not the new one. AGENTS.md binds the exception to exact reviewed-artifact and published-tree identity, so this needs an owner decision, not just code.

This change therefore only measures. On rebase, the host records the artifact hash the previous review approved. When the rebased attempt saves its first candidate for review, the host records whether the hashes match:

- a suppressed `rebase-candidate:<revision>` event;
- an ops log line `coding.rebase_candidate` with `matched`.

The artifact hash covers the whole-file contents and the diff, so a match means a byte-identical change against an identical base for those files. Review still runs, and the exact-head CI gate is unchanged.

## Implementation and review

- [`src/coding/notices.ts`](../../src/coding/notices.ts): quiet-hours parsing and checks, status-line wording, status rendering (last 10 lines, each at most 200 characters) and `StatusMessageGone`.
- [`src/coding/controller.ts`](../../src/coding/controller.ts):
  - `STATUS_NOTICE` is the one SQL classification of progress-only notices. Anything it does not name stays a separate message.
  - `deliver` claims a run of consecutive progress notices for one job, then edits the current status message or sends a new one.
  - Before any separate notice, it closes that job's status message.
  - It suppresses progress for cancelled jobs and summarises cancellations.
  - `noteRebasedCandidate` records the rebase comparison.
- [`src/coding/delivery.ts`](../../src/coding/delivery.ts): `editCodingStatus` treats "message is not modified" as done, and a missing or uneditable message as `StatusMessageGone`.
- [`src/coding/automation.ts`](../../src/coding/automation.ts): the `rebase-approval` event also carries `carriedArtifact`.
- [`src/main.ts`](../../src/main.ts): wires `editMessageText` and the quiet hours.
- [`src/config.ts`](../../src/config.ts) and [`config/runtime.json`](../../config/runtime.json): add `CODING_QUIET_HOURS`.

Outbox guarantees kept:

- Notices claimed together share one outcome. A send or edit with an unknown outcome makes all of them `uncertain`, and restart recovery never replays them.
- Before an edit, the intended lines are saved. If that edit fails or its outcome is lost, the next edit shows them, without a resend.
- A refused edit (`StatusMessageGone`) changed nothing, so a new status message replaces it. At night, the progress waits instead.
- Progress payloads are never modified, so the worker's retry-equality check (`progress()` hashing) still holds.
- Owner scoping, revoked-owner suppression, the requirements-card gate and `codingDestination` routing are unchanged. Edits address the owner's chat and message id, so they need no topic.

- **One deliverer per status message.** Two gateway processes can overlap during a release. A status delivery therefore takes a two-minute lease on the job's `status-message` row (an atomic conditional upsert, like the Telegram views lease) for the anchor read, the edit or send, and the save. A delivery that finds the lease held returns its notices to `pending` without trying. A lease left by a process that died expires.
- **One Telegram message.** Before the anchor is saved, the oldest lines are dropped until the text formats to exactly one message. The line bound counts code points, but Telegram splits by UTF-16 length, so emoji-heavy lines could otherwise split the message and make every later edit fail.
- **Publication mismatch.** A PR that does not match the reviewed artifact pauses the job, as before, and now also sends a pause notice (`publication-paused:<revision>:<attempt>`). Without it, the status message would end at "publishing" with nothing after it.

Known edge: if the gateway stops after Telegram accepted a new status message but before its id was saved, those notices are `uncertain` and the next progress starts another status message. Nothing is resent, but an orphaned status message can remain.

Tests:

- [`tests/coding-notices.test.ts`](../../tests/coding-notices.test.ts):
  - edit-in-place, and the rollover after a question;
  - quiet-hours hold, edits that continue at night, the morning send and superseded progress;
  - outbox idempotency: an uncertain edit, a restart mid-edit, a deleted status message and a retried worker report;
  - Telegram edit-error mapping;
  - the approved candidate folded in, with its PR separate (carrying the coder's summary) and a rebuilt PR folded;
  - a failed outcome with no question sent as its own message while a status message is current;
  - pending progress for a cancelled job suppressed;
  - emoji-heavy progress fitting one editable message;
  - the status lease: a held lease defers delivery, and an expired lease does not;
  - the publication-mismatch pause notice;
  - the bulk cancel summary, with each job's objective.
- [`tests/coding-pi-owner-merge.test.ts`](../../tests/coding-pi-owner-merge.test.ts): the carried artifact, plus identical and different rebased candidates, each with its `coding.rebase_candidate` ops-log line (`revision`, `matched`).
- [`tests/coding-model-journal.test.ts`](../../tests/coding-model-journal.test.ts): two progress notices folded into one uncertain send are now both `uncertain`.

Independent review (Claude Opus 5.5, 23 October 2026) approved `11cc462` with nits:

1. Two mutations survived the tests: folding every `:finished`, and removing the suppression of progress for cancelled jobs.
2. Folding the approved candidate lost the coder's summary for autoMerge and draft-only jobs.
3. Emoji-heavy status text could exceed one Telegram message, after which every edit fails.
4. Nothing serialised a job's status message across overlapping gateway processes.
5. The publication-mismatch pause sent no notice, so the status message stopped at "publishing".
6. The bulk-cancel summary listed only bare job ids.
7. The rebase tests did not assert the ops-log line.

Each nit is fixed as described above, with a test. Both surviving mutations now fail their new tests (checked by hand), and so does disabling the one-message fit. Re-review: pending.

## Verification and outcome

- **Tested:** all 40 `tests/coding*.test.ts` files, plus the open-loops, runtime-config, ops-log and telegram-topics tests: 310 tests, 309 passed. The failure was the new quiet-hours test. PGlite gave two quick inserts the same timestamp, so held progress was not seen as older than the separate notice after it. Two fixes: progress at the same instant as a sent separate notice now counts as superseded, and the test sets explicit times. After the fix, the delivery-related files passed (77 of 77), and `tests/coding-notices.test.ts` passed six runs in a row. The quiet-hours test fails when the quiet check is disabled (checked by hand).
- **Not measured:** how many messages a real job now sends, whether the owner notices status edits, and how often a rebase reproduces the reviewed artifact.
- **Hypothesis:** each box attempt's 8–10 progress messages become one status message plus silent edits.
- **Pending:** independent review, CI, release, and a live job checked against the counts above.

## Coding-harness learning record

Updated in [coding-agent lessons](coding-agent-lessons.md):

- **Volume is a delivery property.** Renaming milestones (PR 292) did not reduce their number. The outbox, not the worker, decides how many messages the owner gets.
- **Measure before reusing an approval.** Reusing review across a rebase touches the review exception's safeguards, and its benefit is unmeasured. The `rebase-candidate` record answers the first question: how often a rebase reproduces the reviewed artifact at all.

Next small test: count `coding.rebase_candidate` lines with `matched: true` over the next rebases. If they are rare, the review-reuse change is not worth its risk.

## Follow-up and next iteration

- **Owner decision:** whether a rebase that reproduces the reviewed artifact byte for byte may reuse its approval. If yes, plan a worker change (pinned image first), a carried-review proof that names the earlier attempt, and an AGENTS.md update.
- **Open:** failures and outcomes still notify at night. Whether pauses, PRs or deploys should also wait for the morning is an owner preference to confirm.
