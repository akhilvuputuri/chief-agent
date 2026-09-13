# Cloud development and production releases

## Working from anywhere

The Codex cloud environment `akhilvuputuri/companion-agent` checks out this repository. Read AGENTS.md and HANDOVER.md first. Use Node 22, npm ci, npm run check, npm run build and npm run format:check. No API keys are required for mocked unit/integration tests. Automatic environment setup is enabled; internet access was enabled by the owner. Do not run the production bot in cloud development.

A cloud task does not inherit this local conversation, browser login sessions or SSH files. Describe the problem, approximate Singapore time and expected behavior; attach a screenshot when useful. The repository documents constraints and historical incidents. Fresh production evidence takes precedence over old documents.

## Shipping a change

1. Work on a feature branch, add focused regression coverage and update relevant docs.
2. Open a PR, wait for `checks`, and merge the passing change when authorized. The owner has authorized routine merges and releases.
3. A successful main-branch push check triggers `release`. It revalidates the current main SHA and checks before sending its exact Git archive to DigitalOcean. Manual release dispatch is also supported, but only on main and still runs checks.
4. The server builds a candidate image before touching the running gateway. If runtime work or queued/running conversation input (including attachment preparation) is active, deployment fails with a clear message; retry when idle. Do not cancel user work just to release code.
5. The gateway is recreated, health is checked, and the previous image is restored if startup health fails. The Postgres container and data volume are not replaced. Only a successful health check updates server RELEASE.
6. Watch the release workflow. Report the deployed SHA and status. A branch push, PR creation or passing test workflow alone does not mean the Telegram bot is updated.

Useful commands, when GitHub credentials are available:

```sh
gh run list --workflow release
gh run watch RUN_ID --exit-status
gh workflow run deploy.yml --ref main
gh workflow run diagnostics.yml --ref main
gh run list --workflow production-diagnostics
gh run view RUN_ID --log
```

GitHub access inside Codex tasks varies. Repository connection does not guarantee an authenticated gh CLI. Use the cloud PR UI when necessary. If the task cannot merge or dispatch workflows, report that limitation; the owner can merge the PR or click Run workflow from GitHub on a phone. Deployment after a passing main change remains automatic.

## Credential and permission boundary

Production API keys and OAuth refresh tokens stay in `/opt/hermes-companion/.env`. GitHub Actions has a dedicated SSH key and pinned known-host entry, stored as `COMPANION_DEPLOY_KEY` and `COMPANION_KNOWN_HOSTS` repository secrets. These are not Codex environment variables.

The SSH public key is restricted to a root-owned `/usr/local/sbin/companion-cloud-release` entrypoint. Forwarding, PTY and arbitrary SSH commands are disabled. Only `deploy <full SHA>` and `diagnose` are accepted. Deployment authority still permits changing production application code; protect repository write access. PR jobs receive no deployment key. Release dispatch is limited to main, and automatic releases accept only successful push checks from this repository.

The reviewed entrypoint source is `scripts/cloud-release.py`. Editing that file in a PR does NOT replace the trusted server copy. An operator must explicitly install reviewed updates through the existing local operations connection.

## What diagnostics expose

The manual `production-diagnostics` workflow prints the release SHA, last 15 run states/counters, structural model-failure diagnostics, tool outcome counts, reported model/search costs and job status counts. It does not export credentials, raw conversations, memory, email/calendar content or tool observations. Logs remain in the private repository under its Actions retention policy. Voice costs are not included.

This supports initial failure/cost triage. If a bug requires the exact prompt, context or source content, the owner can supply it in the cloud task or we can inspect it locally. Do not describe these bounded diagnostics as full production access.

## Limitations and recovery

- Database migration or Compose changes are deliberately refused by the automated entrypoint. Prepare and document a reviewed migration/rollback procedure, then handle that release through the local operations connection. Ordinary application changes deploy automatically.
- HTTP/container health confirms startup, not conversational correctness. Add focused regression tests and a user Telegram check for behavior changes.
- Runtime work is checked before restarting; there is a small race if a new user request arrives during deployment. Restart recovery preserves records and may pause work. Avoid sending a long task during the brief release window.
- A failed release after image tagging attempts application rollback; database rollback is not performed. No migrations run in this workflow.
- The last successful image remains tagged `hermes-companion-gateway:rollback`. Image cleanup is not automatic; monitor disk usage as releases accumulate.
- Do not remove Postgres volumes, rerun historical resets, or bypass uncertain-write checks.

## Development process

On 9 September 2026 we inspected the remote branch, CI, server and handover before adding this path. The previous process used the local Mac's operations SSH identity and manual archive/build commands. This change adds project instructions, GitHub-triggered releases, bounded remote diagnostics and a distinct restricted SSH key. The runtime model, provider settings and user data are unchanged. Validate the initial setup by observing one real GitHub release and one diagnostics workflow; document any remaining limitations rather than claiming full cloud/local parity.

## Capability preflight and remaining boundaries

Run `npm run doctor:cloud` at the start of a cloud task that needs to ship or investigate production. It checks Node, Git, GitHub CLI, repository read/write permission and Actions-log access without printing tokens or mutating anything. These checks describe that task's actual environment, not another desktop session. Write access does not prove workflow dispatch scope; the first required dispatch may still return a permission error.

| Work                                          | Cloud path                                                           | Remaining requirement                                         |
| --------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| Implement and test app changes                | Repository, Node 22, mocked tests                                    | No production keys                                            |
| Open a PR                                     | Cloud PR UI or authenticated GitHub CLI                              | Repository connection                                         |
| Merge a passing PR                            | GitHub write-capable identity or user merges on phone                | Do not assume the CLI inherits browser login                  |
| Deploy ordinary app code                      | Passing main → checks → release                                      | No Mac or cloud-task SSH key needed                           |
| Inspect failures/costs                        | production-diagnostics workflow + Actions logs                       | Actions access; bounded metadata only                         |
| Debug exact conversations                     | User supplies incident text/screenshot, or local operator inspection | Raw private content is intentionally absent from Actions      |
| Database/Compose changes                      | Reviewed migration procedure                                         | Current restricted deploy service cannot perform these        |
| OAuth consent, secret rotation, server repair | Account owner/operator                                               | Browser sessions and root SSH are not copied into cloud tasks |

Do not put a broad GitHub token, Google refresh token or unrestricted SSH key in repository files to remove a blocker. A future GitHub App or explicitly reviewed migration service could extend remote operations, but neither is currently installed. This setup supports everyday cloud bug fixes and automatic code deployment; it does not claim complete parity with local account administration.

Calendar's first approval-enabled release uses the [reviewed additive procedure](calendar-approval.md). Its new consent is a one-time account step; subsequent ordinary Calendar code fixes use automatic releases.

## Standing direction: converge cloud and local capabilities

Owner preference recorded 9 September 2026: a cloud task should increasingly be able to do the same incident investigation, trace review, regression testing, implementation and verified release work as a local task. Current limitations above describe today, not the desired end state. Close gaps during relevant development rather than repeatedly sending the owner back to the Mac.

Priorities are a shared private trace inspection/export interface, reproducible incident fixtures, reliable scoped GitHub mutation/workflow access, and eventually a reviewed remote migration/operations path. Preserve account consent, explicit Calendar approval and credential boundaries. Prefer narrowly scoped services and shared scripts over giving cloud tasks root SSH or copying OAuth tokens. Verify capabilities from an actual cloud task before claiming parity; local preflight results do not prove cloud access.

## Portable agents and release identity

Use the same pipeline from a fresh local checkout or another cloud coding provider. See [portable setup](portable-development.md), [current work](current-work.md) and [release/version policy](releases.md). GitHub already stores COMPANION_DEPLOY_KEY and COMPANION_KNOWN_HOSTS; their values must not be exported to developer .env files. GitHub triggers deployment, while Docker build/start/health checks run on DigitalOcean. A local Mac does not participate in ordinary app releases.

The latest verified release at the time of the 12 September handover was e6837c0; inspect fresh Actions results for current status. The private trace export candidate is checkpointed, not installed. Account-level branch protection and environment approvals are separate GitHub settings, not guaranteed by these workflow files.

## Conversation control v0.3.8

The reviewed migration013 release uses [the rolling-conversation procedure](rolling-conversation.md). Once installed, metadata diagnostics include input timing/states, foreground versus job routing, context sizes/omissions, and delivered-message provenance. Raw prompts, source content and pending-question text remain private in Postgres. The operator installs the reviewed entrypoint update; merely editing its repository source does not activate new diagnostic fields.

## Checkpoint steering v0.3.9

The migration014 release uses the [checkpoint-steering procedure](checkpoint-steering.md). Its reviewed operator install also updates the trusted release command to refuse pending input preparation and adds bounded steering/delivery diagnostics. Ordinary code releases use that installed guard afterward. `python3 scripts/test-cloud-release.py` runs three offline deployment-guard regressions; it requires no credentials or Docker. The one-time database rollout remains an operator procedure.
