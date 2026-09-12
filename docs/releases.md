# Versions and release notes

Use immutable semantic-version tags for meaningful, verified shipped milestones. Keep continuous app deployment from main. Tags identify releases; they do not trigger deployment. There were no existing Git tags when this policy was prepared on 12 September 2026. Do not invent retrospective version history.

## First published baseline

[v0.1.0](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.1.0) labels already deployed commit `e6837c0ab0061d768ea752a42548c3921ca3c095`, verified by [release run 34370129968](https://github.com/akhilvuputuri/companion-agent/actions/runs/34370129968). It includes release notes and explicitly excludes unfinished memory and Python evaluation work. Creating the tag did not deploy the checkpoint.

## Version policy

- Start with v0.1.0 as the verified baseline when publishing the first release.
- Patch (v0.1.1): compatible fixes. Minor (v0.2.0): new capability or a breaking change while the project remains pre-1.0. Reserve v1.0.0 for an explicitly chosen stable contract.
- Do not tag every documentation commit or unsuccessful candidate. Do not move/reuse tags. Keep checkpoint and experiment branches untagged as production releases.
- package.json currently says 0.1.0. For subsequent versioned milestones update package.json and package-lock.json in the PR before merging, without creating a local tag (`npm version VERSION --no-git-tag-version`).

## Publish a verified release

1. Merge the reviewed PR after checks. Observe the release job for the exact SHA and confirm healthy deployment. Check current diagnostics if later changes may have deployed.
2. Write notes identifying that exact SHA and the successful workflow link. Include user-visible changes, relevant fixes, validation, migrations, rollback constraints and known limitations. Keep private data out.
3. Create an immutable vX.Y.Z tag/GitHub Release at that verified SHA. Use gh release create with an explicit --target SHA and a --notes-file, or the GitHub UI. Never rely on the default branch head while another task may be merging.
4. Confirm the release target and report it. A GitHub Release is a historical shipped milestone, not evidence that production still runs that version forever.

Release publishing is currently a documented manual agent/operator step; there is no automatic tag or note generation workflow. Future automation should run only after successful deployment with narrow contents-write permission. Keep deploy credentials separate from publication permissions.

## Notes template

Title: vX.Y.Z — concrete capability or fix

- Deployed commit and successful release workflow.
- Changed behavior and why it matters.
- Validation actually performed, including limitations of health versus behavioral checks.
- Migration requirements and rollback restrictions, if any.
- Known gaps; distinguish unfinished memory/evals from shipped features.

Use docs/journey for the deeper engineering story; release notes should summarize shipped behavior. Never claim cost savings or quality improvements without comparable measurements.

## Other practices to adopt gradually

Use GitHub issues for bounded tasks and acceptance criteria, independent branches/draft PRs, short-lived changes, lockfiles, mocked CI, additive migrations, reproducible sanitized incidents, and current handover notes. Add main-branch protection requiring checks and blocking force pushes if the repository's plan supports enforcement. Branch protection and protected deployment environments must be verified in GitHub settings; they are not established by writing this policy.

A later improvement is pinning Actions to reviewed commit SHAs with automated dependency updates. A remote reviewed migration path is also future work. Neither is installed by this document.

## GitHub settings verification — 12 September 2026

The branch-protection API returned HTTP 403 with a requirement to upgrade to GitHub Pro or make this repository public. The environments API returned an empty list. No plan, visibility or account setting was changed. Therefore required PR checks/force-push protection and protected deployment environments are not claimed as enforced. Keep this repository private; a plan upgrade is an owner decision. The existing release workflow independently requires passing checks and current main before deployment.
