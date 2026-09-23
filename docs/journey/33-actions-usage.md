# 33 — Duplicate hosted checks and release work

Work date: 23 September 2026. Status: review candidate; production workflow effect not yet measured.

## User-visible problem and preceding iteration

The owner received a GitHub alert at 1,800 of 2,000 included Actions minutes for the billing cycle ending 1 October 2026. Multiple coding agents were pushing revisions to open PRs on the same day. The existing cloud development and release pipeline made those revisions testable and deployable, but `checks` ran on both every branch `push` and every `pull_request` update.

## Evidence and diagnosis

**Measured, repository API, 23 September 2026 UTC, queried around 15:15 UTC:** the first page of runs created that day contained 65 `checks` runs: 38 `push` and 27 `pull_request`. Grouping by head SHA found 27 heads with repeated runs and 29 runs beyond one per head; the typical pair was one push check plus one PR check for the same revision. The same page contained six `release` runs and 15 `production-diagnostics` events, 13 of the latter skipped at job level. This is a snapshot of this repository, not the account's complete billing ledger; it does not attribute all 1,800 minutes to these workflows. [Workflow runs](https://github.com/akhilvuputuri/chief-agent/actions), [checks configuration](../../.github/workflows/ci.yml).

**Observed in code:** automatic `release` waits for a successful `checks` run on main, verifies its exact SHA is still main, and then repeats `npm ci`, formatting, tests and build before deployment. Manual dispatch lacks that upstream check and needs its own validation. The diagnostics `issue_comment` trigger creates skipped entries for unrelated comments; those entries are not evidence of 15 billed runner jobs.

## Change and limits

Run `checks` for PRs targeting main and for pushes to main, removing the duplicate feature-branch push event and tag rechecks. Cancel an older in-progress PR check when a new revision arrives; never cancel main checks. For automatic release, use the successful exact-SHA main check as validation; retain the full checks for manual dispatch and retain the SHA, idle-work, deployment and health guards. Keep Devin Review comments enabled: its mail is a separate GitHub notification preference, not an Actions charge.

This deliberately leaves full checks on documentation-only PRs and still deploys documentation-only main commits. Path-based skipping requires a stable required-check design and explicit release semantics; changing it in this incident could strand merge checks or make a docs-only commit appear deployed when it was not. The next measurement should compare repository run counts and billed runner minutes over similar development activity after deployment, while accounting for other repositories and workflow queues.

## Verification and release closure

Pending exact-head review, CI, merge and first PR/main/release observation. This entry does not claim a measured savings or a production release.
