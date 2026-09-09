# 05 — Making development independent of the laptop

Work: 9 September 2026. Status: checked release and bounded diagnostics paths released; capability parity ongoing.

Originally deployment and investigation depended on local SSH credentials and chat context. We moved operating instructions into the repository and added GitHub checks, reviewed PRs, automatic main-branch releases, startup health verification and application rollback. A restricted server command separates release authority from development environments. Production model and Google credentials stay on the server.

Commit `709d0f4` introduced the path. [Cloud development](../cloud-development.md) is the operational source of truth. A branch push is not a deployment; checks, release status and deployed SHA must be verified. Database/Compose updates still need a reviewed operator procedure. Cloud GitHub connection does not prove permission to dispatch workflows or merge.

The user made cloud/local investigation parity a standing priority. Private memory/prompt tracing is now implementation work, not a completed capability. This distinction prevents an agent from promising production inspection it cannot perform.

## Claude Code as another development client

Claude documents cloud tasks from the browser and mobile app, with GitHub branches and PR review: [official setup](https://code.claude.com/docs/en/web-quickstart). It can use the same repository and GitHub release pipeline after account connection. It does not inherit the Codex session or its credentials. No Claude account connection or end-to-end Claude deployment has been verified here.

See [Claude cloud setup](../claude-cloud.md) for the remaining account steps. The architectural lesson is to put tests, instructions and releases in shared infrastructure so the coding client is replaceable.
