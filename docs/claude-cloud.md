# Claude Code cloud development

Prepared 9 September 2026. Account connection and a Claude-originated task have not been verified.

Claude Code supports cloud work submitted from claude.ai/code or the Claude mobile app. See [official setup and supported plans](https://code.claude.com/docs/en/web-quickstart). Cloud sessions run remotely; Remote Control instead depends on the local machine staying available.

## Account setup

1. Sign in at claude.ai/code and connect GitHub; select akhilvuputuri/companion-agent.
2. Configure the cloud environment with Node 22 and npm ci. Permit necessary package-registry and GitHub access. Do not add production bot, model, Google or SSH secrets.
3. Start a small documentation task from the phone and verify branch creation, checks and PR review. Account access and GitHub mutation permissions must be checked in that actual cloud session.
4. Use the existing checked main-branch release pipeline. A feature branch does not deploy. If the task cannot merge, merge the passing PR through GitHub on the phone and verify the release result.

Read AGENTS.md, HANDOVER.md and docs/cloud-development.md. Run npm run doctor:cloud before promising deployment or production diagnostics. The same DB/Compose review restrictions apply regardless of coding provider. Exact private trace access is ongoing work; do not assume it is available from the repository connection.

Example task: “Read AGENTS.md and HANDOVER.md. Reproduce this bug with a focused mocked test, implement the smallest root-cause fix and document it under docs/journey. Open a PR, verify checks and use the documented release process if your permissions allow it. Report the actual deployed SHA or the precise remaining blocker.”
