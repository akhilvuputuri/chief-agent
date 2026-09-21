# 29 — Close the gap between a merged PR and verified delivery

Work date: 2026-09-22. Status: implementation and review in progress.

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

Focused offline status tests cover missing evidence, unrelated green checks, failed/pending retries after success and malformed identifiers/receipts. Full application checks/build/format passed. Independent Astra review requested receipt-origin validation: the initial helper trusted a status context/URL without validating its issuer or execution. The correction checks the GitHub Actions issuer, expected workflow/repository/main SHA and current-attempt deploy result, with wrong-publisher/workflow/commit and failed-execution regressions. Re-review and live workflow verification are pending. A successful receipt records startup health at that release time; it is not continuous health or semantic feature acceptance. Cancellation before reporting can leave pending evidence; agents must inspect Actions rather than assume success. Improved instructions and automatic review do not prove a lower defect rate; evaluate that from future reviews and incidents.
