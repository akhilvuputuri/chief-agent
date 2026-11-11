# 167 — Why did review cost $16 on one job?

Work date: 2026-11-10. Written: 2026-11-10.
Status: tested on synthetic jobs; release and worker image pin pending.

> **Update, 12 November 2026:** released in `f6df014` (PR 453); worker image `sha256:33639fbe…` built from it and pinned in the following change. Takes effect for coding jobs created after that pin is live.

> **Update, 12 November 2026:** rebuilt on `dcb7ea3` from this session's recorded edits after the uncommitted working copy was lost, and renumbered from 158 (taken by [158 — Reused test databases](158-reused-test-databases.md)). Since [journal 161](161-enabling-direct-anthropic.md) the coder and planner are Opus 5.5 too, so the larger pages also cut coder calls that read the plan, check failures and review findings. Two Pi runtime tests scripted reads of pages 1 and 2 of a 9,357-character plan; a plan is at most 32,000 characters, one page now, so they read page 0 and still check that an edit and a completion before it are refused.

## User-visible problem and preceding iteration

Study-links job `4ba7fa41` ran on the worker from [journal 156](156-room-for-the-whole-plan.md), never paused and opened PR 433. It cost about $17, of which the Claude Opus 5.5 reviewer was $16.06. The owner asked whether token use or prompt caching was inefficient in the coding and review models.

## Evidence

- **Measured (production, read-only, job `4ba7fa41`):**

  | Role     | Model               | Calls | Prompt tokens | Read from cache | Cost   |
  | -------- | ------------------- | ----- | ------------- | --------------- | ------ |
  | Reviewer | Opus 5.5            | 276   | 36.7M         | 97.2%           | $16.06 |
  | Coder    | DeepSeek V4.1 Flash | 908   | 104.3M        | 98.7%           | $0.95  |
  | Planner  | DeepSeek V4.1 Flash | 35    | 0.7M          | 84.6%           | $0.02  |

- **Measured:** no reviewer call lost its cache inside a session. The longest gap between calls was 94 seconds, against a 5-minute cache lifetime. All Opus calls went to one provider.
- **Measured:** the reviewer's $16.06 was $7.14 of cache reads (35.7M tokens at $0.20 per million), $5.20 of cache writes (1.04M at $5) and $3.72 of output.
- **Measured:** five code-review rounds cost $2.47, $3.53, $3.42, $2.70 and $3.28. Each began at about 14,000 tokens and grew to 161,000–220,000 over 46–63 calls. Two plan checks cost $0.65 together.
- **Measured:** the reviewer made 313 `read_document` calls on `candidate_diff`, which had up to 78 pages. 175 of its 276 replies held one tool call.
- **Measured:** over 30 days, coding cost $36.94 and the Opus reviewer $29.35 of it.
- **Code:** a page was 4,000 characters. Every review round got the instruction to read every page of the complete diff, and a new session. A round after a repair knew nothing of the earlier review.
- **Reported:** an independent review of PR 433 after the five rounds still found one blocking and seven important issues.

## Diagnosis and alternatives

Caching works. The cost is volume: every model call re-reads the whole conversation, so loading a 300,000-character diff in 75 small pages means dozens of calls that each re-read everything loaded so far, and each later round did all of it again for a repair that touched a small part of the change.

Two changes, both in the worker:

- **Larger pages.** A `read_document` page is 32,000 characters, not 4,000. A 300,000-character diff is 10 pages. The tool description asks for several pages in one turn. A page is now about 8,000 tokens, which suits the 1M-token windows of the configured models; a model with a 32,000-token window would compact after three pages.
- **A later round reads what changed.** When a reviewer requests changes and the coder repairs in the same worker run, the next round gets `review_delta`, the complete diff from the candidate reviewed then to the current one, and `previous_findings`, the earlier report. The complete `candidate_diff` stays available as an optional document. The reviewer must check each earlier blocking or important finding in the current source, review the delta as new code, and give a verdict on the whole candidate.
  - The host of the review builds the delta itself: it writes the earlier candidate as a git tree in the fresh review checkout, returns the checkout to the base, restores the current candidate (whose tree is still checked against its hash), and diffs the two trees.
  - A full review still happens for the first round, for a repair whose delta is more than half the size of the complete diff, when the delta cannot be built, and in a new worker run (a resume, a rebase or an owner feedback round).

Rejected:

- A cheaper reviewer model. Opus is there because a cheaper reviewer approved a change with five blocking bugs (3 November). This stays the owner's decision.
- The 1-hour cache lifetime. No gap came near 5 minutes, and it doubles the write price.
- Keeping one reviewer session across rounds. Rounds are 40 minutes or more apart, so the cache has expired, and reloading 200,000 tokens costs about $1 before any work.
- Carrying the reviewed candidate across worker runs. It needs a new checkpoint field on the host; the in-run case covers three of the four later rounds measured here.

The trade-off: a later round no longer re-reads unchanged code, so something every earlier round missed in it stays missed. The measured rounds do not show that re-reading it five times found everything either.

## Review

Independent review (Claude Opus 5.5) found nothing blocking; it traced the tree and delta construction and reproduced it with nested directories, a mode change and a `.gitignore` edit. Its findings, all addressed:

- The re-review told the reviewer that an unfixed earlier finding "is still a finding". An earlier finding can be wrong or out of scope, and the coder is told to leave such a finding alone, so rounds could repeat until the job paused. The reviewer now judges each earlier finding first and says which it dropped.
- The text said the earlier candidate was reviewed "in full", which is untrue from round 3, when the earlier round was itself a delta round. The claim is removed.
- Escaped check output (newlines, colour codes) could push review instructions past the runtime's 32,000-character bound, which ends the attempt. This predates the change; the receipts now shrink until the instructions fit.
- Tests were missing for the rule that picks a delta or a full review, for a checkout that cannot return to the base, and for a verdict given without reading the optional document. With larger pages, no worker-level test read a multi-page document any more. All added.

## Verification and outcome

- **Tested:** `coding_runtime_pi/tests/documents.test.ts`: pages of 32,000 characters return the complete text, including a surrogate pair across a page boundary; an optional document can be read and is not required before work or a verdict.
- **Tested:** `tests/coding-pi-review-evidence.test.ts`, with real git. The delta holds a file changed again, an addition undone and a deletion undone, and leaves out a file unchanged since the review. The checkout is exactly the base after the earlier tree is written, and the current candidate still passes its hash check. An unknown tree, an identical candidate and unrestorable files give no delta.
- **Tested:** `tests/coding-report-contract.test.ts`, a complete synthetic job: the first review reads every page of a two-page complete diff; after its findings and the repair, the second is told it is round 2, gets the one-line repair as `review_delta` and the first report as `previous_findings`, never reads the complete diff, and approves. With the new path switched off, the test fails.
- **Tested:** a delta of up to half the complete diff is used, a larger one is not; a checkout that cannot return to the base ends the review; review instructions stay within 32,000 characters with escaped check output, in both kinds of round.
- **Not tested:** a third round in one run.
- **Estimated, not measured:** larger pages save about $0.50 a round, and a delta round costs well under $1 against about $3. On this job that is roughly $10 of the $16.
- **Not yet measured:** reviewer cost and findings on a real job with both changes.

## Follow-up and next iteration

Release, then publish and pin a worker image; the changes are worker-only. Compare reviewer cost per round, and what later rounds find, on the next job with a repair round. If later rounds miss problems in unchanged code, make the final approving round a full one.
