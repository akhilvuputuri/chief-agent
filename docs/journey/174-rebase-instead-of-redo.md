# 174 — Why does a rebase implement the whole change again?

Work date: 2026-11-12. Written: 2026-11-12.
Status: tested on synthetic jobs; independent review, release and a worker image pin pending. Takes effect only for jobs on a worker image built from this change.

> **Update, 12 November 2026 (production finding, job `9600af57`):** the job was rebased onto a main that had switched its build to `kite build` (Kite 0.2.0, PR 458), while it stayed on its snapshot worker image `sha256:33639fbe…` with Kite 0.1.3. After re-applying the plan, the host's `kite run build` check exited 1 and the job paused for the owner. The rebase now also moves a Pi job to the worker image new jobs use, as `coding_job_update` with `upgradeWorker` does: both use `currentWorker` (`src/coding/worker-image.ts`), which changes only the image and keeps models, limits, context windows and saved work. A rebased checkpoint has no session to restart, so `freshSession` (which restarts a session only when a model changes) has nothing to do there. The change is recorded as `image: {from, to}` in the `rebase-change` event, in the revision message and in the owner's notice. Tested in `tests/coding-pi-rebase-worker.test.ts`: a job on an older accepted image moves to the current pin and its carried change still applies cleanly, then reaches the Merge card; a job already on the current image records no change. This also means a job created before this change's image pin picks up the carry at its next rebase without an owner `upgradeWorker`, once the gateway that does the move and an image that carries it are both live. This was added while an independent review of `aac23ede` was running; that review does not cover it.

> **Update, 12 November 2026 (independent review of `aac23ede`):** the review approved with nothing blocking and asked for follow-ups, all made in this PR after the worker-image commit:
>
> - **Leftover markers.** After a conflict session, the worker scans the conflicted files' diff against the base for git's markers. A hit fails like a check (`conflict marker scan`) and goes to the check repair, because the configured checks need not read the file (documentation, say). Conflicting files git could not mark (binary files, for example) are listed separately, and the coder is not told they contain markers.
> - **Carry outcome saved.** `piState.carry` records `clean`, `conflict` (with the marked and unmarked files) or `reimplemented`. A resumed attempt in the same revision tells the coder what happened, gives the reviewer the conflicted files to check, and never describes a fresh implementation as a carried change.
> - **Carry kept across a resume.** `coding_resume` and the automatic retry start a new revision, and the host looked up the carried change by exact revision, so a resume lost it. It now uses the latest non-resume revision's `rebase-change` event when that event's `onto` base is the job's current base. A clean carry resumes as checks and a delta review; a later feedback round or another base does not inherit it.
> - **Nothing to read in the delta.** When every file the change touches is byte-identical to the approved candidate, `review_delta` now holds main's complete diff between the bases (up to 400,000 characters); a larger one gets a full review. Before, the delta was empty and the round always counted as small.
> - **Summary length** is cut in UTF-16 units, as the schema counts them.
> - **`verify()` cancellation:** it polls the store for a cancellation request, as `run()` does.
> - **Tests added:** a change git cannot apply (workspace left at the base, plan implemented again); main already containing the change; a clean carry interrupted after its save and resumed by the owner on a new revision; a conflict session stopped by a model failure and resumed; markers left in a Markdown file; main's change touching none of the change's files; `verify` cancelled through the store. Not tested: a binary conflict.

## User-visible problem and preceding iteration

When main moves before the owner taps Merge, an owner-merge Pi job is rebased automatically. Since the owner's policy of 17 October 2026 ([journal 87](87-pi-owner-merge-feedback.md)) the rebase cleared the job's change (`files` and `patch`) and queued a new attempt that implemented the approved plan again from scratch on current main, then repeated the checks, a full review and the Merge card. [Journal 115](115-fewer-coding-notices.md) already measured a docs-only job spending about 42 minutes of box time on two such rebases, and added a measurement of whether a rebase reproduces the reviewed candidate byte for byte.

On 12 November 2026 the owner superseded the 17 October policy ("the full redo is crazy") after job `9600af57`: carry the existing change onto current main, and use a model only where the carry fails.

## Evidence

- **Measured (production, job `9600af57`, 12 November 2026; reported to this change by the session that inspected it, not re-measured here):** the redo after main moved cost more than $16.50, and the coder spent 44 minutes and 80 model calls re-reading the repository before its first edit.
- **Code (before this change):** `CodingAutomation.rebase` (`src/coding/automation.ts`) set `cp.files = []` and `cp.patch = ""`. The Pi worker clones the repository at the new base and restores `checkpoint.files` as whole files, so restoring the old files would have overwritten main's changes in any file both touched; clearing them was the safe choice given that restore.
- **Code:** the reviewed candidate's `patch` is `git diff --cached --binary --no-renames <base>` with full blob identities (`Workspace.snapshot` in `coding_runtime_pi/src/workspace.ts`), and the worker has a full clone, so the old base's blobs are available for a three-way merge.

## Diagnosis and alternatives

The redo was a consequence of how the change was stored (whole files), not of a need to re-implement. Git can carry it.

**Chosen: carry the reviewed change in the worker, before any model call.**

- **Host.** `rebase()` keeps every existing guard (the two-rebase cap, allocation limits, approval carried over only for the same scope, protected paths and the owner-merge workflow) and still starts the new revision with an empty checkpoint. It also records the reviewed change in a suppressed `rebase-change:<revision>` event: the old base, the artifact hash, the patch, the files, the coder's summary and the approving review's findings. `CodingController.assignment()` sends it to a Pi worker as a top-level `rebase` field.
- **Worker** (`src/coding/pi-worker.ts`). On the first attempt of that revision it checks the change against its hash, then runs `git apply --3way` on the new base:
  - **Clean:** no implementation call. `CodingRuntime.verify` (new in `coding_runtime_pi/src/runtime.ts`, sharing the check loop that follows a build report) runs the configured checks and snapshots the artifact. If checks fail, the existing check repair hands the failures to the coder, with a note that they appeared after the carry and with the reviewed change as an optional document (at most two rounds, then the job pauses for the owner as today).
  - **Conflict:** git's markers stay in the files. The coder gets a normal build session on the workspace that already holds the change, plus `rebase_conflicts` (the conflicted files, git's output and what main changed) and the reviewed change as an optional document, with instructions to resolve the conflicts and not implement the change again.
  - **Anything else** (the patch does not apply at all, or its identity does not match): the workspace returns to the base and the coder implements the approved plan from scratch, as before. This is the last resort.
- **Review.** Still a fresh, independent review in the same attempt, so the review exception and the sealed reviewer-call proof are unchanged. Its first round after a carry reads what changed, like journal 167's later rounds: `previous_findings` is the approving review, and `review_delta` lists what main changed between the bases and gives the diff from the approved candidate's files laid on the new base to the candidate. Where main and the change touched the same file this shows how they were combined; an empty diff means every file the change touches is byte-identical. `candidate_diff` becomes optional reading. A delta larger than half the complete diff, or over the 500,000-character document bound, gets a full review.
- **Merge card** as today.

**Compatibility.** The checkpoint still starts empty, and older workers drop an unknown top-level assignment field, so a job on an image that predates this change implements the plan again exactly as before. A job created before the pin (such as `9600af57`) needs the owner's `coding_job_update` with `upgradeWorker` while it is stopped to use it (see the update above: the rebase now makes that move itself).

Rejected:

- **Merging on GitHub** (merge main into `chief/coding-<id>` through the API). It needs no worker change, but adds a merge commit to the owner-merge branch, the checks and review would still need a box, and conflicts would still need a worker.
- **A three-way merge on the gateway.** It would fetch both bases' files through the GitHub API and needs a diff3 implementation; the worker already has git and the clone.
- **Reusing the earlier approval when the carry is byte-identical** (journal 115's question). It would remove the review, but the reviewer saw the change against the old base, and the review exception binds approval to a reviewer call in the same attempt. A delta review keeps that rule and is cheap when the delta is small.
- **Sending the old files in the checkpoint.** An older worker would restore them whole and silently revert main's changes in shared files.

## Implementation and review

- `src/coding/automation.ts`: `rebase()` records `rebase-change:<revision>`; owner notice and summaries say the change is carried.
- `src/coding/controller.ts`: `assignment()` adds `rebase` for that revision of a Pi job.
- `src/coding/pi-worker.ts`: the carry, the clean, conflict and fallback paths, a resume of a clean carry that stopped before any coder session (it runs the checks again), and the carried review round.
- `src/coding/pi-review-evidence.ts`: `piCarriedDelta` (an empty string for identical trees) and `piMainChanges`.
- `coding_runtime_pi/src/runtime.ts`: `verify()` and the shared `runChecks()`.
- Independent review: pending for this head.

## Verification and outcome

- **Tested:** `tests/coding-pi-rebase-worker.test.ts` runs the real host, worker, git and checks (`kite ci`, `kite run check`, `build`, `format:check`) on a synthetic repository, from a published job through the automation's rebase to the next attempt:
  - Clean rebase: zero coder calls; every model call is the reviewer's; the four checks ran again; the candidate holds both changes; the review is the carried round, reads `review_delta` with main's one-line change and not the unchanged 40-line file, reads the approving findings, and skips the optional complete diff; the automation then offers the Merge card for revision 2.
  - Conflicting rebase: the coder's first read of the file shows git's markers; it gets `rebase_conflicts` and the instruction not to implement again, resolves the conflict in one write, and the carried review sees the combination.
  - Checks failing after a clean rebase: one check-repair session with the failures and the carry note, then the carried review approves.
  - A carried change whose identity does not match: the coder implements the plan on current main, the owner sees why, and the review is a full one.
- **Tested:** `tests/coding-pi-owner-merge.test.ts`: the rebase records the carried change and the assignment sends it only for that revision; the checkpoint stays empty; the two-rebase cap and a missing approval record nothing; approval carry-over is unchanged.
- **Tested:** `coding_runtime_pi/tests/runtime.test.ts`: `verify` refuses an unapproved build, runs checks with no model call, and pauses on a failure with the artifact kept.
- **Not tested:** a real job; a rebase whose conflict session is resumed after a transient fault (the coder gets a short note that the change is already in the workspace, but not the conflict list again); renamed files (snapshots use `--no-renames`, so a rename is a delete and an add).
- **Not yet measured:** box time and cost of a real carried rebase against the redo.

## Coding-harness learning record

Updated [coding-agent lessons](coding-agent-lessons.md#a-rebase-carries-the-reviewed-change--12-november-2026). The redo was safe but blind to the fact that the change already existed; the store format (whole files) made the safe option the expensive one. The fix keeps every approval and review rule and changes only where the change comes from.

## Follow-up and next iteration

Release, then publish and pin a worker image built from this change. On the next rebase, compare box time, model calls and cost with `9600af57`, and check `coding.rebase_candidate` for how often the carried candidate is byte-identical. If clean carries are common and their delta reviews find nothing, the owner can decide whether an identical carry still needs a review.
