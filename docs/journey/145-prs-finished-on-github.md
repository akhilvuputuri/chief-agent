# 145 — How does a parked coding job learn its PR is gone?

Work date: 2026-11-01. Written: 2026-11-01.
Status: tested on synthetic jobs; deployment recorded in [releases](../releases.md). The first live sweep is not yet recorded.

## User-visible problem and preceding iteration

The owner asked Chief to stop the previous coding job, meaning the stuck study-links job. Chief tried the box-status job `8dfdfbf0`, was refused because that job has a PR, reported that it could not stop it, and told the owner to close PR 305. PR 305 had merged on 21 October. The owner's message was fine. Chief had two jobs to choose from when only one was really open.

## Evidence

- **Measured:** the job was last updated at 04:18 UTC on 21 October, at `manual_review`. PR 305 merged at 07:05 UTC that day. The 14:25 UTC cancel on 1 November failed with the published-PR refusal.
- **Code:** the automation tick selects only active stages, so `manual_review` and `merge_declined` are not read again. Jobs without `autoMerge` or `prWorkflow` are never selected. Its "merged or closed outside this workflow" check therefore cannot fire for a parked job.
- **Reported:** `c273a330` has a draft PR, 232, still open.
- **Not established:** why Chief chose this job for "previous". This change removes the wrong candidate, not the choice.

## Diagnosis and alternatives

The stored stage answered a question only GitHub can answer. Alternatives:

- Check GitHub inside `coding_status`. That adds a network read for up to 20 jobs to every status call, and makes reads fail or slow when GitHub does.
- Return parked jobs to automation. Automation would also re-run gates and could rebase, which is not what a parked job should do.
- Let Chief close PRs. That is a new outward write nobody asked for.

Chosen: a sweep every 15 minutes, so status stays a database read that is at most about 15 minutes behind, plus a live check in `coding_cancel`, the one place a stale answer misleads at once.

## Implementation and review

- `src/coding/github-automation.ts`: `outcome` reads one owned PR. It keeps the ownership check and needs no recorded merge target, which old jobs may lack.
- `src/coding/automation.ts`: `settleOutside` and `sweepParked`. The write is guarded by revision, stage, PR URL and lease. A failed read changes nothing.
- `src/coding/controller.ts`: cancel checks first; refusals and resume explain a finished job.

The sweep sends no message, because the owner made the change on GitHub. Jobs stay `pr_ready`, because the state constraint has no merged value and this avoids a migration. The new stages fall out of `CODING_WAITS_ON_OWNER` by not being listed.

Limitations:

- `merged_outside` does not verify a release.
- Open PRs stay parked, including draft PR 232, until the owner closes them. Chief still cannot close PRs.
- A PR whose branch name no longer matches the job fails the ownership check, so it stays parked and logs `coding.parked_check_failed`.
- `lastParkedSweep` is in memory, so every gateway start runs one sweep.

## Verification and outcome

- **Tested:** `tests/coding-settle-outside.test.ts`, with a fake repository. It covers merged, closed, open, failed reads, rate, leases, watched stages, cancel, resume and owner-wait.
- **Not tested:** `GitHubAutomation.outcome` against real GitHub. The first live check is whether `8dfdfbf0` moves to `merged_outside` after release.
