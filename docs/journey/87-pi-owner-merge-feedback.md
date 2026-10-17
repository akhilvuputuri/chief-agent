# 87 — Can a Pi coding job handle Devin feedback and merge on the owner's word?

Work date(s): 2026-10-15. Written/revised: 2026-10-15.
Status: in progress. v0.3.75 released the host loop, merge card and Coding-topic routing; candidate v0.3.76 pins the verified worker with the feedback entry and enables `prWorkflow` for new Pi jobs. A live feedback round and owner-confirmed merge remain.

## User-visible problem and preceding iteration

[Journal 85](85-provider-routing-stability.md) ended with the first fully successful Pi job on the released stack: DeepSeek planned and implemented, all four real checks passed, Gemini 4 Argon approved, and draft [PR 232](https://github.com/akhilvuputuri/chief-agent/pull/232) was published. The owner then reported two gaps (reported): the job stopped at a draft that Devin never reviewed, and its result arrived in Main rather than the Coding topic. Pi was deliberately draft-only (`autoMerge` is rejected for Pi), and owner decisions and results were deliberately routed to Main. The owner asked for the Python squad's feedback loop to be carried over to Pi, ending with the owner's own merge decision, and for all coding messages to go to Coding.

## Evidence

- PR 232 had zero reviews and zero comments while it remained a draft (measured via the GitHub API); Devin starts only on ready-for-review PRs.
- The squad loop in `src/coding/automation.ts` already marks PRs ready, collects unresolved feedback, re-queues bounded repairs with a fresh independent review, and merges only an exact head after re-verifying every gate. Its repair entry required `squadState`, and its reviewer proof understood only the squad's tools.
- Pi already repairs after its own reviewer requests changes, passing findings as an untrusted reference document; host approval of Pi candidates is bound to the acknowledged review document.

## Diagnosis and alternatives

Reusing the squad automation keeps one audited merge path. Alternatives: forging a Pi `REQUEST_CHANGES` reviewer state from the host to reuse the existing repair entry (rejected: it would misstate provenance), or letting Pi merge automatically like the squad (rejected: the owner asked to be asked). Requiring main to equal the approved base is kept; in a repository where other sessions merge often, some jobs will need manual reconciliation (hypothesis to measure).

## Implementation and review

- `settings.prWorkflow: "owner_merge"` (Pi only) enables the loop. It is stripped from worker assignments, like `contextWindows`, because published workers strictly validate settings.
- Feedback repair writes `piState.mrFeedback {round, text}` and resets reviewer state; the worker starts a fresh, resumable coder session per round with an untrusted `mr_feedback` document and instructions to stay within the approved plan, then reruns checks and the independent review. Rounds are capped at three within the job's existing allocations.
- Pi reviewer proof: the host-acknowledged APPROVE review document matching the result, plus a completed reviewer call in the attempt.
- When every gate passes, the job waits at `awaiting_merge_approval` with one Merge / Keep open card per revision and head. `CodingMergeApprovals` accepts a tap only for the delivered message, owner, revision, head and waiting stage. After approval the existing gates re-run before an exact-head merge and release watch; any PR change resets approval. An approval survives an idle-runtime wait.
- All coding-job messages route to Coding (`src/coding/delivery-routing.ts`).
- Offline tests cover the ready/feedback/card/approve/merge path, decline, stale card after a head change, the three-round cap, settings validation, card buttons, routing, and the worker giving the coder the feedback document while preserving it in checkpoints.

Independent review of the first head (`739fb3b`, Claude Opus 5.5) found no path to merge without the owner's tap but requested changes: a job waiting for the owner was re-selected on every tick and starved other PR jobs (reproduced); an approval lost to a transient check or mergeability change was never re-offered; feedback rounds restarted review numbering and could collide with earlier repair/review session scopes; the Pi reviewer proof did not inspect the sealed reviewer response; taps were refused while the tick held the job lease; the publisher automation flag ignored `prWorkflow`; and the card embedded the coder's summary unlabelled. Corrections: waiting jobs update `updated_at` each tick through a stage-conditional write that never overwrites a newer owner answer; one answerable card is kept per revision/head and a lost, decided-but-unused or expired card is replaced with a "confirm again" card; `reviewRound` carries into feedback rounds; the proof requires a sealed reviewer `report` with APPROVE and the exact acknowledged detail; confirmation no longer depends on the lease; the flag includes `prWorkflow`; the summary is labelled as the coder's own. New tests cover fairness, re-offered and expired cards, taps under lease, round continuity and the sealed proof.

Re-review of `09c66ba` confirmed six corrections but found that accepting taps under the lease let an in-flight tick overwrite a Keep open decision (to awaiting CI, or into an automatic feedback repair), reproduced with a decision recorded during GitHub inspection. Every automation stage write and the repair re-queue are now conditional on the stage the tick read; a changed stage stops the tick without writing. A card with uncertain delivery is replaced, and a card being sent is not duplicated. Tests cover a decline recorded mid-tick under both a check flap and new feedback, and uncertain-card replacement.

## Verification and outcome

Pending: full local and hosted checks, exact-head independent review, release, publication and verification of a worker image containing the feedback entry, a reviewed pin that enables `prWorkflow`, and a live job showing Devin feedback handled and an owner-confirmed merge. No live feedback round or merge has run yet.

## Coding-harness learning record

Updated in [coding-agent lessons](coding-agent-lessons.md): external review feedback is untrusted input to a fresh, bounded repair round, never permission to widen scope, and human merge consent must be bound to the exact head it describes.

## Follow-up and next iteration

Measure how often main moves before a merge decision and whether a reviewed rebase-and-re-review step is worth adding.

### Release and enablement candidate — 15 October 2026

[PR 233](https://github.com/akhilvuputuri/chief-agent/pull/233) merged as `c44cb6fbd6b1c7df84fb04ca3f744e7259c556e2` after three independent review rounds (approved at `e93073c`), hosted CI and 1,194 local tests. The [main-only image workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/38703652600) published the worker from that commit at index `sha256:637a956d25e6ff110e88f0c6e19e061a4f20bb101a3630bcdd16b8cf7c2e2ec0`, matching the workflow's recorded digest. Anonymous verification found linux/amd64, user `worker`, the fixed worker command, Pi 1.1.0, a root-owned native guard, and all 196 compiled files identical to a clean local build of that tree. The image was not executed locally.

Candidate v0.3.76 pins that worker and sets `prWorkflow: "owner_merge"` in `config/coding-pi.json`, so new Pi jobs follow the loop; existing jobs keep their settings snapshot. It also makes the read-failure summary write stage-conditional (a low finding from the final review). The first live job must show Devin feedback handled within scope, a fresh independent review, and a merge only after the owner's tap.

### Review rule recorded — 15 October 2026

The owner confirmed (reported) that Chief's configured reviewer (Gemini 4 Argon) should count as the independent review inside the owner-merge workflow, as it already does for the Python squad. `AGENTS.md` now states this exception and its safeguards: sealed reviewer proof, exact-artifact identity, CI, Devin and handled feedback as separate gates, and a merge only after the owner's exact-head tap. Changes that coding agents merge directly still need the most-capable independent reviewer. Jobs created before v0.3.76 keep their original settings and are not converted; the owner's live test uses a new job.

### First live owner-merge job — 15–16 October 2026

The owner's first job on v0.3.76 (`1a6cf84e`, a `docs/releases.md` change) worked through planning, approval, implementation (37 coder calls), Argon approval (20 reviewer calls), publication of [PR 239](https://github.com/akhilvuputuri/chief-agent/pull/239) and ready-for-review, then paused (measured from the job record and model journal). Two defects: Devin's review said "No Issues Found", but its summary review body was collected as MR feedback, so an unnecessary repair round started at 15:18 UTC; and that round only had the time left over from the original 40-minute window. The coder finished in about 2.5 minutes and the four real checks took about 13 minutes, so the Argon re-review started at 15:34:06 and the attempt deadline expired at 15:34:29. Sandbox exit, not a crash.

Fixes (candidate v0.3.79): Devin summary bodies carrying its review badge are no longer feedback, whether they say "No Issues Found" or report flags that GitHub settings left unposted; Devin's actionable findings arrive as inline comments (independent review checked PRs 204–240: inline comment counts matched the reported issue counts), which still count, as do all human reviews. The Python squad loop shared this defect; and, by owner decision on 16 October, each Pi owner-merge feedback round gets a fresh active window equal to the job's configured limit, while model-call and tool totals stay shared and rounds stay capped at three. The paused job can be resumed after release; resumption gives it a fresh window.

### Resume, moved main and Chief's guidance — 16–17 October 2026

After v0.3.79 the owner resumed job `1a6cf84e` (measured): the Argon re-review approved at 07:32 UTC, the unchanged candidate was republished to PR 239 at 07:33:00, and 17 seconds later the automation stopped at manual review because main had moved past the job's base (other sessions had merged). Reported by the owner and confirmed from the conversation record: asked to merge, Chief said it could not merge (its coding tool descriptions still described the draft-only workflow); it then pointed the owner to GitHub's Update branch; asked to have the coder do it, Chief called `coding_reply`, which only applies to paused or planning jobs. That failed a precondition, but was classified as an uncertain write, so the turn stopped with a generic error.

Fixes (candidate v0.3.80):

- **Automatic rebase rounds.** When main moves before an owner-merge PR is merged, the job is re-queued on current main: the approved plan is re-implemented from a fresh clone (whole-file contents from the old base are not reused), checks and Argon review run again, the publisher rebuilds the same PR on the new base (force-updating only the job branch), and CI, Devin and the Merge card follow. By owner decision on 17 October the plan approval carries over to the new base (a host-recorded `rebase-approval` event naming the previous scope); the owner still decides at the Merge card. Each rebase round gets a fresh active window; model-call and tool totals stay shared; at most two rebases, then manual review.
- **Owner-merge gates compare main's tip.** GitHub's `pr.base.sha` stays at the PR's original base (PR 239 showed `949d404` while main was `5397300`), so owner-merge jobs no longer compare it.
- **Chief knows the workflow.** The coding tool descriptions now describe the owner-merge flow, tell Chief never to say it cannot merge such a job, and say `coding_reply` is not for jobs with a PR. `coding_status` reports `mergeFlow`.
- **Preconditions are not uncertain writes.** A revise or resume that changes nothing is now a validation error with guidance, so the turn continues.

Separately, on 17 October at 05:26 UTC the owner saw `Model request failed (HTTP 402)`: OpenRouter refused a call for payment (credits or key limit exhausted) after 35 Gemini 4 Argon calls ($2.14) in the preceding three hours. This is an account top-up, not a code defect.

Independent review of `9dffbd6` (Claude Opus 5.5) requested changes: the new no-op guidance told Chief that an owner-merge job in `manual_review` "continues on its own", repeating the misinformation the change targets; the carried-approval comment cited the wrong decision date; rebases ran before the protected-path and reviewer-proof gates; and the carried scope was not checked against a recorded approval. Corrections: guidance and the `coding_status` description now depend on stage (manual review and declined merges are explained as needing owner attention, and Chief does not claim it can merge them); rebases run only after those gates; a rebase requires a recorded owner approval of the current scope; the cap counts `rebase:` request keys; dates corrected. The reviewer verified the rebase SQL, that the pinned worker re-implements a re-queued job correctly, that owner-merge heads still provably descend from the job base without the `pr.base.sha` check, and that the precondition error is truthful.

### Owner continue for parked PRs — 17 October 2026

v0.3.80 was released at 06:55 UTC (`69805d7`, release run 39011683129). Job `1a6cf84e` had stopped at manual review before that release (main moved; measured on 16 October), and nothing returned it to the automation: `manual_review` and `merge_declined` are terminal for the host loop, and `coding_resume` refused jobs that already have a PR. The owner asked Chief to continue; Chief correctly explained the stop but had no action to take.

Fix (candidate v0.3.81): when the owner asks to continue an owner-merge job whose PR stopped at `manual_review` or `merge_declined`, `coding_resume` moves it back to `awaiting_ci` at the current revision (stage-conditional, not while a host tick holds the lease) and records a suppressed `continue:<requestKey>` event. The automation then re-runs every gate from the start: the protected-path and reviewer-proof gates, the rebase when main has moved (still capped at two), CI, Devin, feedback and the Merge card. A hold that still applies stops it again with its reason. A retried identical request answers from the recorded event. The no-op guidance and the `coding_status` text now tell Chief to use `coding_resume` when the owner asks to continue such a job.
