# 29 — Close the gap between a merged PR and verified delivery

Work date: 2026-09-22. Status: released; cloud diagnostics and exact-commit release reporting verified.

## Problem and preceding iteration

The [cloud release foundation](../cloud-development.md) already separated CI from a guarded deployment, but a remote coding session stopped at “ready to merge” and did not establish the release outcome. The owner reported repeated defects found after independent approvals, difficulty merging, and a merged stock-monitor feature that was not initially live.

## Evidence and diagnosis

Observed: PR #63 merged as `c9a86cf` and required additive migration 018; the ordinary release service correctly refused an uninstalled schema/Compose change. The later [two-account rollout](27-multiple-gmail-accounts.md) installed that prerequisite. This was not evidence that merging bypasses the release trigger, or that app-only releases require a local machine.

Observed in Devin settings on 22 September: no repositories were enrolled for automatic review. Companion Agent was enrolled for readiness and subsequent pushes; default REVIEW.md discovery was already configured. Existing independent review messages repeatedly approved new revisions while external reviews later found additional defects. CI and reviewer confidence did not establish provider correctness. A merge permission failure must be distinguished from a session simply stopping before attempting merge; the cloud session subsequently confirmed Actions log access, reported a dispatch 403, and reported a platform merge restriction (open-PR merge remains unverified). It also attempted unauthorized mutation probes against invalid/already-completed targets, was stopped, and reported no new mutations; the shared contract now explicitly prohibits this.

## Changes and alternatives

Add a shared end-to-end task contract and adversarial REVIEW.md covering external provider assumptions, owner boundaries, failure cases, restart/timing behavior and deployment prerequisites. Keep a fresh independent feature reviewer; automatic review adds another signal and does not replace it.

Add a read-only commit-specific release-status command and durable production statuses/PR comments emitted by the existing trusted release workflow. Pending, failed and missing evidence remain distinct; green CI alone never means production success. Reports contain commit/workflow metadata, not private runtime data. The diagnostics workflow adds an exact `/companion diagnose` comment request for the repository owner and pinned Devin bot identity, private-repository only. It executes no PR code and accepts no arbitrary command, ref or arguments. Existing operator boundaries and deployment credentials remain unchanged.

A broad cloud SSH key would remove friction but expose unrelated credentials and host authority. This iteration uses the existing GitHub release service. Full private trace exports and remote schema installation remain separate capabilities.

## Validation and limitations

Focused offline status tests cover missing evidence, unrelated green checks, failed/pending retries after success and malformed identifiers/receipts. Full application checks/build/format passed. Independent Astra review requested receipt-origin validation: the initial helper trusted a status context/URL without validating its issuer or execution. The correction checks the GitHub Actions issuer, expected workflow/repository/main SHA and current-attempt deploy result, with wrong-publisher/workflow/commit and failed-execution regressions. Exact-head re-review passed; live validation and its permission correction are recorded below. A successful receipt records startup health at that release time; it is not continuous health or semantic feature acceptance. Cancellation before reporting can leave pending evidence; agents must inspect Actions rather than assume success. Improved instructions and automatic review do not prove a lower defect rate; evaluate that from future reviews and incidents.

## First live acceptance — 22 September 2026

PR #74 merged as `eee7cfc3f185eee23e52a3b7f6a94c52137c5a26` after independent Astra approval of `0c07f0215c1774e311caca1e06dc60f416172de7`, both CI runs and 9 script tests. The reviewer first rejected insufficient receipt authentication; the fixed revision passed re-review. The full local application suite passed 342 tests before the later script-only changes, and final CI reran the complete suite.

The actual Devin cloud session successfully posted the fixed diagnostics command on PR #74. [Run 35625970221](https://github.com/akhilvuputuri/companion-agent/actions/runs/35625970221) passed the production metadata read, but its PR reply failed with GitHub 403. The workflow needed explicit pull-requests write permission as well as issues write for its PR-comment output. The follow-up grants that permission only to the trusted reporting jobs; it does not give the cloud agent an Actions token or deployment key. This live failure was not caught by the offline tests or independent review. Deployment and corrected reporting acceptance were pending at this first attempt; the later closure below records completion.

A `/companion` shortcut was also saved in Devin's organization settings, pointing new tasks to the repository contract. The automatic review enrollment and shortcut were verified in the UI; their configuration does not establish reviewer quality or a successful autonomous release.

## Corrected cloud acceptance — 22 September 2026

PR #75 merged as `f71468aa201958f11d84248c5221462b66f6d4f7` after Astra approved exact head `e401acab9644076928e546eb093a77acdfc52908`, automatic Devin Review passed, and both CI checks passed. A second actual Devin-originated comment on PR #75 triggered [diagnostics run 35626842143](https://github.com/akhilvuputuri/companion-agent/actions/runs/35626842143). The run succeeded, Devin read the metadata and verified [the GitHub Actions reply](https://github.com/akhilvuputuri/companion-agent/pull/75#issuecomment-5764040557). This establishes the cloud-session comment → fixed host diagnostic → readable private log → PR reply path. It does not establish full private-trace access or autonomous merging.

The first release attempt for `eee7cfc` passed its deployment/health job but failed the old PR-report job. The follow-up release at `f71468a` is tracked separately; do not classify an overall failed workflow as a verified receipt even when one job succeeded. No application version was incremented for these tooling/workflow-only changes.

### Release closure — 22 September 2026

[Release run 35627310699](https://github.com/akhilvuputuri/companion-agent/actions/runs/35627310699) succeeded at `f71468aa201958f11d84248c5221462b66f6d4f7`, including deployment and startup health. The new `release:status` command returned success/exit 0 after validating the GitHub Actions receipt, expected workflow, exact main SHA and current-attempt deployment job. Before completion it returned pending/exit 2 rather than claiming success. The merged PRs are [#74](https://github.com/akhilvuputuri/companion-agent/pull/74) and [#75](https://github.com/akhilvuputuri/companion-agent/pull/75); their exact independent approval revisions and the first failed live check are retained above.

This completes the shared review instructions, saved Devin shortcut, automatic review enrollment, fixed diagnostics request path and durable release reporting. It does not establish autonomous merge under Devin's reported platform restriction, automatic wake-up from bot comments, full private trace export, operator-free schema changes or zero defects. The observed review and first live permission failures are reasons to retain real acceptance checks. New tasks consume repository instructions from current main; the old PR #63 session served only as the actual cloud acceptance environment.
