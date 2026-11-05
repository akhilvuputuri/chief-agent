# 154 — Why did a job stop at the first failed check instead of fixing it?

Work date: 2026-11-05. Written: 2026-11-05.
Status: tested on synthetic jobs; release pending, and the worker part needs a new pinned image.

## User-visible problem and preceding iteration

The study-links job `c43f2113` was the first to run with the plan check and the failure-hunting reviewer ([journal 151](151-review-that-looks-for-failures.md)). It planned, the owner tapped Start, and it built. Then the host ran `kite run check`, 12 tests failed, and the job paused with "Checks failed; artifact and session retained". The owner's report: "its broken still".

Two things made that a dead end. Nothing sent the failures back to the coder, so a fixable test failure needed a person. And the stored output was only the last 8,000 characters. With the full suite's output, that tail held the summary counts but not which tests failed or why.

## Evidence

- **Measured (production, read-only):** job `c43f2113` paused after `kite run check` exited non-zero with 12 failing tests. Its stored check output did not name them.
- **Code:** `coding_runtime_pi/src/runtime.ts` set a build to `paused` when any configured check failed, and kept `output.slice(-8000)`. `src/coding/pi-worker.ts` treated that pause as the end of the attempt.
- **Code:** the coder already runs focused checks through bash, but the host's full checks run only after its done report, so the coder never saw the full suite fail.

## Diagnosis and alternatives

A failing test after implementation is normal work for a coder, not a reason to stop. The host already has everything needed: the coder's workspace, the approved plan and the failures. So the worker now sends the failures back to the coder for up to two repair rounds per worker run, inside the same attempt and allocation, and pauses only if checks still fail after that. With less than 10 minutes of the attempt left, there is no time to fix and rerun the suite, so the failures go to the owner instead.

Each round starts a fresh coder session on the same workspace. The failures arrive as a document, `check_failures`, which the coder reads page by page, and the instructions forbid weakening, skipping or deleting tests. Test output can print anything the repository's code prints, so the document is labelled untrusted and not new scope, like the review findings.

The stored output now leads with a digest of failure lines (TAP `not ok`, assertion fields, TypeScript errors, `Error` lines, `FAIL`), each with three lines after it, then the tail. So a long run keeps both which tests failed and how the run ended.

Rejected:

- Unlimited rounds. A failure the coder cannot fix would spend the whole allocation; two rounds bound it, and the owner can still resume.
- Asking the owner first. The owner does not read plans or logs, and the fix stays inside the approved plan.

A paused job also keeps the worker image it started with. `coding_job_update` gains `upgradeWorker`, which moves a stopped Pi job to the image new jobs use, keeping its work, session and approval. That is how `c43f2113` gets the repair rounds.

## Implementation and review

- `coding_runtime_pi/src/runtime.ts`: `checkOutput` builds the digest.
- `src/coding/pi-worker.ts`: `fixFailedChecks` runs after the first build and after each review repair.
- `src/coding/controller.ts`, `src/coding/schema.ts`, `src/runtime.ts`: `upgradeWorker`, shown on the owner notice as a worker image change.

Independent review (Claude Opus 5.5) requested changes on the first version:

- **Blocking:** repair sessions were named by round number alone. The host stores session entries per job, so the next worker run on the same job reused a stored name and was refused with a session conflict. That would have made the owner's resume fail every time. Names now include the attempt, and a test resumes a job after its checks failed.
- **Blocking:** one test assertion could never match, because the document text arrives JSON-encoded.
- **Important:** the failure document was titled as trusted host output; it is now labelled untrusted. A cut could split an emoji, which makes the text an invalid document and fails the round; cuts now keep whole characters. A round that ended before any checks ran (allocation or model failure) dropped the failures it was fixing; they are now kept.
- **Nits fixed:** the repair round keeps the earlier documents and the full git rules, and a missing image is refused before the update is built.
- **Re-review** approved the fixes. Its nits are also fixed: a round that fails outright (no checks run) ends the repairs rather than starting another, the instructions name the kept documents, and a test covers the 10-minute floor.

Limitations:

- The digest matches common Node, TAP and TypeScript formats. Other output falls back to the tail.
- A repair round shares the attempt's time and call limits, so a slow suite leaves less time for each round.
- If the worker restarts in the middle of a round, the restored session no longer has `check_failures`. The coder reports done, the checks run again, and a new round gets fresh failures.

## Verification and outcome

- **Tested:** `tests/coding-check-repair.test.ts` runs a synthetic job whose first build fails its check. The coder reads `check_failures`, which starts with the digest, fixes the code, and the job passes review. A second test fails three times and ends paused with "Checks failed" after two rounds, with the digest kept. A third resumes that paused job, which repairs in new sessions and passes; it fails with the old session names. A fourth gives the attempt 9 minutes and pauses without a round. The digest test also covers characters at a cut. `coding_runtime_pi/tests/check-output.test.ts` covers the digest, its size bound and the plain-tail fallback. `tests/coding-job-update.test.ts` covers an upgrade keeping work, session and approval, a repeat refused, and a non-Pi job refused.
- **Not yet measured:** a repair round on a real job.

## Follow-up and next iteration

After release and a new pinned image, `c43f2113` can be upgraded and resumed. Its repair rounds are the first live measure.
