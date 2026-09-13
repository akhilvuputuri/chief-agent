# Versions and release notes

Latest verified shipped release, checked 14 September 2026: [v0.3.9](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.9), deployed SHA `9c6335be09582432d9bf7c4a475c90f9b5e9272a`. The [release workflow](https://github.com/akhilvuputuri/companion-agent/actions/runs/34764417365) and [subsequent diagnostics](https://github.com/akhilvuputuri/companion-agent/actions/runs/34769892493) succeeded at that SHA. See the [engineering journal](journey/README.md) for the connected development history and dated release closures. Published milestones preserve their original verification limits; memory/evaluation checkpoints and live behavioral acceptance checks are not implicitly completed by a tag.

Use immutable semantic-version tags for meaningful, verified shipped milestones. Keep continuous app deployment from main. Tags identify releases; they do not trigger deployment. There were no existing Git tags when this policy was prepared on 12 September 2026. Do not invent retrospective version history.

## First published baseline

[v0.1.0](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.1.0) labels already deployed commit `e6837c0ab0061d768ea752a42548c3921ca3c095`, verified by [release run 34370129968](https://github.com/akhilvuputuri/companion-agent/actions/runs/34370129968). It includes release notes and explicitly excludes unfinished memory and Python evaluation work. Creating the tag did not deploy the checkpoint.

## Version policy

- Start with v0.1.0 as the verified baseline when publishing the first release.
- From 13 September 2026, increment **only the patch** for every new versioned release, including features: v0.3.0 → v0.3.1 → v0.3.2. Do not increment minor or major without a new explicit owner decision. Existing v0.1.0/v0.2.x/v0.3.0 tags remain unchanged. Describe compatibility changes in the notes; patch numbering does not replace migration review.
- Do not tag every documentation commit or unsuccessful candidate. Do not move/reuse tags. Keep checkpoint and experiment branches untagged as production releases.
- Update package.json and package-lock.json in the PR before merging, without creating a local tag (`npm version patch --no-git-tag-version`). Check the latest integrated version first to avoid concurrent release collisions.

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

Use [docs/journey](journey/README.md) for the deeper engineering story; release notes should summarize shipped behavior. Never claim cost savings or quality improvements without comparable measurements.

## Other practices to adopt gradually

Use GitHub issues for bounded tasks and acceptance criteria, independent branches/draft PRs, short-lived changes, lockfiles, mocked CI, additive migrations, reproducible sanitized incidents, and current handover notes. Add main-branch protection requiring checks and blocking force pushes if the repository's plan supports enforcement. Branch protection and protected deployment environments must be verified in GitHub settings; they are not established by writing this policy.

A later improvement is pinning Actions to reviewed commit SHAs with automated dependency updates. A remote reviewed migration path is also future work. Neither is installed by this document.

## GitHub settings verification — 12 September 2026

The branch-protection API returned HTTP 403 with a requirement to upgrade to GitHub Pro or make this repository public. The environments API returned an empty list. No plan, visibility or account setting was changed. Therefore required PR checks/force-push protection and protected deployment environments are not claimed as enforced. Keep this repository private; a plan upgrade is an owner decision. The existing release workflow independently requires passing checks and current main before deployment.

## Released v0.3.9 — checkpoint steering

[PR #42](https://github.com/akhilvuputuri/companion-agent/pull/42) shipped at `9c6335be09582432d9bf7c4a475c90f9b5e9272a`, the exact target of the published v0.3.9 tag. Two independent GPT-6 Astra reviewers approved `79297e16dd218d8565c86545b7d2ef98da94d1e0`; the merged tree matches that head. The release records 230 application tests plus two scope tests, typecheck/build/format, three offline release-guard tests and eight mocked rollout scenarios.

The reviewed migration014 rollout used the released v0.3.8 baseline, preserved data and paused work, and passed exact deployment/health verification. See the [behavior and rollback guide](checkpoint-steering.md) and [dated journal closure](journey/18-checkpoint-steering.md) for the linked release and diagnostics evidence. No paid model evaluation or production conversation replay was performed. A real Telegram behavioral acceptance check remains separate from startup health and mocked tests; deferred memory/evaluation work was not released.
