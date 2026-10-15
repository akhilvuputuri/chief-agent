# 87 — Can a Pi coding job handle Devin feedback and merge on the owner's word?

Work date(s): 2026-10-15. Written/revised: 2026-10-15.
Status: in progress. The host loop, worker feedback entry, merge card and Coding-topic routing are implemented and tested offline; the feature stays disabled until a worker image containing the feedback entry is published and pinned with `prWorkflow` enabled.

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

## Verification and outcome

Pending: full local and hosted checks, exact-head independent review, release, publication and verification of a worker image containing the feedback entry, a reviewed pin that enables `prWorkflow`, and a live job showing Devin feedback handled and an owner-confirmed merge. No live feedback round or merge has run yet.

## Coding-harness learning record

Updated in [coding-agent lessons](coding-agent-lessons.md): external review feedback is untrusted input to a fresh, bounded repair round, never permission to widen scope, and human merge consent must be bound to the exact head it describes.

## Follow-up and next iteration

Measure how often main moves before a merge decision and whether a reviewed rebase-and-re-review step is worth adding.
