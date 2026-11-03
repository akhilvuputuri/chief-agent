# 152 — Why could nobody fix PR 416 through Chief?

Work date: 2026-11-04. Written: 2026-11-04.
Status: tested on synthetic jobs; release pending.

## User-visible problem and preceding iteration

PR 416 needed fixes, and the owner wanted to tell Chief what to fix. Chief had no route for it. The job had stopped at manual review because it added a migration, and that stop came before the step that reads review feedback. `coding_reply` refused jobs with a PR. The only options were a new job or an operator editing the branch. The PR also lacked its migration's Compose line and rollout script, which nothing checked before review.

## Evidence

- **Code:** in `src/coding/automation.ts` the hard-stop check ran before marking the PR ready, so Devin never reviewed it and feedback was never read.
- **Code:** `coding_reply` only revised restartable jobs, and `pr_ready` is not restartable.
- **History:** the hard stops were kept by an AI session on 21 October (PR 308), when the owner asked to remove the protected-path block. Their effect on feedback was not checked then.
- **Measured:** migrations 031 to 035 all have a Compose line and a deploy script; 030 does not.

## Diagnosis and alternatives

The stop protects something real: a migration merged without its rollout makes every later release refuse to run. But the stop belongs at the merge, not before review. Moving it to the end keeps the protection and lets feedback, CI and Devin run.

Owner requests use the existing feedback round instead of a new mechanism. It already carries a bounded text to the coder on the same PR, with three rounds at most, and re-runs review.

Rejected: dropping the hard stop for migrations. Merging is still unsafe until the rollout runs, so a person stays in that step.

## Implementation and review

- `src/coding/automation.ts`: the hard stop moves after feedback and CI; owner requests join feedback; `operatorSteps` names what is left, in the stop and on the Merge card.
- `src/coding/controller.ts`: `requestPrChanges` records the request, and returns a stopped PR to checks.
- `src/coding/merge-policy.ts`: `operatorSteps`.
- `tests/migration-rollout.test.ts`: the rollout check.

Limitations:

- An owner request outside the approved scope is still treated as review feedback, which the coder only applies within scope.
- The rollout check finds the deploy script by file name and cannot tell whether it works; the script's own test does that.

## Verification and outcome

- **Tested:** `tests/coding-pi-owner-merge.test.ts` covers a stopped PR taking a request, the next round, idempotent retries, key conflicts, refusal after a merge, feedback before the stop, and the eval note. The migration check passes on `main` and fails a migration without its Compose line.
- **Not yet measured:** a live request on a real PR.
