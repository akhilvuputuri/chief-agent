# Cloud agent: implement, review, release, verify

This is the shared task contract for Devin and other remote coding agents. Read AGENTS.md first. A task ends with verified delivery or a specific recorded blocker, not a promise to watch later.

## Start with capabilities and deployment shape

Run `npm run doctor:cloud` from the actual cloud session. Inspect current main and relevant docs. Do not print token values or copy production credentials into the session. Repository write, merge, Actions read and workflow dispatch are different permissions. Do not probe write permissions with POST/PUT requests, even using an invalid ref or already-merged PR. Use documented/read-only permission evidence or leave the capability unknown until the requested real action. A failed API must be reported with its operation and redacted error; never infer that an unattempted merge is forbidden.

Before coding, identify whether the task changes app code only or also database/Compose, host scripts, production secrets or OAuth consent. Ordinary app changes use main → checks → release. Other changes require the existing reviewed operator procedure. Surface that prerequisite in the PR before merging; do not remove the deployment guard.

Define concrete acceptance scenarios and a short list of likely failure modes. For an integration, verify the provider's official contract before building mocks. Start incidents with [troubleshooting](troubleshooting.md); inspect production diagnostics when available and distinguish measured facts from hypotheses. A denied read does not establish the integration's failure cause.

## Implementation and independent review

Run focused regressions, then required checks/build/format. Create a PR describing behavior, validation and deployment prerequisites. Spawn a fresh independent reviewer with the strongest model actually available in this environment. Supply requirements, base/head SHAs, PR link and REVIEW.md; let it inspect code independently. Do not claim another vendor's model was used when unavailable. Fix findings, rerun affected checks and obtain explicit approval of the new exact head. Record the reviewer identity, head and limitations on the PR. Automatic Devin Review on pushes is a second signal; it does not replace this loop.

The owner authorizes merging passing requested ordinary changes. Merge only the exact reviewed head, for example `gh pr merge NUMBER --squash --match-head-commit FULL_HEAD_SHA`. Never use admin bypass. If merge fails, report the concrete GitHub error and inspect policy/permissions. Do not add tokens to source, weaken protection, or silently stop at “ready to merge.”

## Release is part of the task

After merge, get `mergeCommit.oid` from `gh pr view NUMBER --json mergeCommit`. Run:

```sh
npm run release:status -- FULL_MERGE_SHA
```

This read-only check returns a commit-specific production status and exits zero only for a successful deployment receipt. Pending/unverified is exit 2; failed is 1. Authentication errors are failures, never success. It reports evidence at release time, not a continuous health check. For older commits without receipts, inspect their release logs explicitly; do not treat missing evidence as failure or success.

Watch the corresponding `checks` and `release` runs using `gh run list` and `gh run watch RUN_ID --exit-status`. The release workflow posts a durable result to the merged PR and a `companion/production` commit status, so the result survives a sleeping coding session. A failed/cancelled attempt does not establish which image is now running; use `production-diagnostics` to read server RELEASE and health-related metadata. Startup health is not feature acceptance.

If a release is stale, verify that the newer main contains the change and inspect that commit's receipt. If busy, retry after the runtime is idle without cancelling user work. If database/Compose differs, follow the reviewed operator procedure and state that the release is blocked until it runs. Do not repeatedly retry a deterministic migration refusal.

For authorized credentials with Actions write:

```sh
gh workflow run diagnostics.yml --ref main
gh run list --workflow production-diagnostics --limit 5
gh run view RUN_ID --log
gh workflow run deploy.yml --ref main
```

Match the run's time and actor before reading its output. A dispatch acknowledgement is not completion. Diagnostics expose bounded metadata only; they are not full prompt/email exports. If dispatch is denied, the repository owner or the installed Devin GitHub bot can post the exact comment `/companion diagnose` on a repository issue or PR. The trusted default-branch workflow runs only the existing fixed `diagnose` command and replies with its private Actions link. It accepts no arguments, refs or shell commands, does not check out PR code, and is disabled if the repository becomes public. Other commenters cannot trigger it. This closes diagnostics dispatch without granting the coding session Actions write or SSH. If comment permission is also unavailable, continue with available logs and state the blocker. Do not hand a cloud worker unrestricted SSH.

Close with PR, reviewed SHA, tests, deployment SHA/workflow evidence, behavioral acceptance limits and remaining blockers. Update the journal and handover. A statement such as “after merge I'll watch” is incomplete unless the task actually watches or leaves an explicit blocked handover.

## Devin setup and verification

As observed on 22 September 2026, Chief is enrolled in automatic Devin Review on readiness and each subsequent push. REVIEW.md is in its default instruction discovery path. This setting applies to this repository only. The independent reviewer task must still run.

GitHub integration permissions, security profiles and the session's CLI credentials determine its actual mutation/Actions capabilities. Local Codex access proves none of these. Keep a cloud capability result in the task; do not store credentials or personal environment dumps in the repository. Native Devin web deployment is unrelated to the repository release pipeline.

Remaining boundaries: remote schema/host installation is operator-mediated; raw private trace export is not installed. Review quality must be evaluated on defects found and missed over time, not the number of approvals. See [the harness incident](journey/29-cloud-agent-harness.md).

### Cloud audit, 22 September 2026

The existing Devin session verified repository and Actions-log reads. It reported `403 Resource not accessible by integration` for workflow dispatch and a platform policy restriction on `gh pr merge`; merge on an open PR remains unverified. Do not bypass a platform policy using alternate APIs. Routine merge authorization from the owner does not override the tool's restrictions. Use an authorized reviewer/operator to merge if that boundary persists. The diagnostics comment command supplies a supported, narrowly scoped read operation; it does not merge or deploy code.

The session also attempted write probes during a read-only audit, despite the instructions. It was stopped and reported no new changes. Treat that as an instruction-following limitation, not evidence of reliable autonomy. The workflow enforces its own narrow command/actor boundary regardless of the agent's prose.
