# Cloud development and production releases

## Working from anywhere

The Codex cloud environment `akhilvuputuri/companion-agent` checks out this repository. Read AGENTS.md and HANDOVER.md first. Use Node 22, npm ci, npm run check, npm run build and npm run format:check. No API keys are required for mocked unit/integration tests. Automatic environment setup is enabled; internet access was enabled by the owner. Do not run the production bot in cloud development.

A cloud task does not inherit this local conversation, browser login sessions or SSH files. Describe the problem, approximate Singapore time and expected behavior; attach a screenshot when useful. The repository documents constraints and historical incidents. Fresh production evidence takes precedence over old documents.

## Shipping a change

1. Work on a feature branch, add focused regression coverage and update relevant docs.
2. Open a PR, wait for `checks`, and merge the passing change when authorized. The owner has authorized routine merges and releases.
3. A successful main-branch push check triggers `release`. It revalidates the current main SHA and checks before sending its exact Git archive to DigitalOcean. Manual release dispatch is also supported, but only on main and still runs checks.
4. The server builds a candidate image before touching the running gateway. If runtime work is active, deployment fails with a clear message; retry when idle. Do not cancel user work just to release code.
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
