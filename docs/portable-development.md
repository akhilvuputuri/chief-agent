# Develop and ship from a new machine

The repository, tests and GitHub release pipeline are shared across local agents, Codex cloud and Claude cloud. A fresh checkout does not inherit any prior chat, login or local .env.

## First checkout

Install Git, Node 22 and GitHub CLI. Authenticate GitHub using your own authorized identity (`gh auth login`); do not share a token in chat or source. Then:

```sh
gh repo clone akhilvuputuri/chief-agent
cd chief-agent
git fetch origin
npm ci
npm run doctor:cloud
npm run check
npm run build
npm run format:check
```

Read AGENTS.md and docs/current-work.md. The historical local folder may be named hermes-companion; that name is not a required path. Most checks use PGlite and mocked providers, so neither Docker nor .env is needed for them. Docker is needed for running the full local stack.

Create a feature branch from current main for new work. For unfinished memory work, use its documented checkpoint branch instead and inspect differences before incorporating main. Avoid multiple agents editing the same checkout; use independent clones/worktrees and bounded PRs. Avoid competing edits to migrations or deploy workflows.

## Credentials and optional local integration tests

For actually running a separate development bot, copy .env.example to .env and set `chmod 600 .env`. Fill only credentials needed for that test environment. .env and .env.* are ignored except the placeholder .env.example. Keep .env out of artifacts, screenshots, command output, Docker build context and Git. Do not assume ignoring a file removes previously tracked secrets.

Use a distinct test Telegram bot, test database and test Google data. Starting a second poller with the production token can disrupt the live assistant. Check provider pricing before paid smoke tests; those are not part of routine CI.

Production credentials stay on the production host (AWS Lightsail) in /opt/hermes-companion/.env. Deploy authentication stays in GitHub Actions secrets. Ordinary development and deployment need neither set copied locally. No credentials have been moved by these documentation changes.

## Develop, merge, verify

1. Make the smallest complete change, with relevant regression coverage and documentation.
2. Run check, build and formatting. Push the branch and open a PR. Mark unfinished work as draft and describe remaining issues.
3. Review the exact diff and check current main for conflicting changes. Merge a passing requested ordinary change using the owner's standing authorization. Never merge another agent's unfinished candidate as a shortcut.
4. Observe main checks and release. The workflow rechecks the exact current-main SHA, builds on the production host, waits for idle runtime work and checks health. A successful release prints deployed SHA and healthy status.
5. If it fails due to active work, retry when idle; do not cancel user work. If superseded by newer main, verify the newer release instead. For DB/Compose changes, follow a reviewed operator migration procedure. Do not bypass the guard.
6. Record release status and any remaining limits. For shipped milestones, follow releases.md for tags and notes.

A GitHub identity with repository/Actions permissions can inspect the bounded production-diagnostics workflow from any machine. Full private trace inspection is still unfinished. Run doctor:cloud in the actual environment; a local success does not prove another agent has permission.

## Remaining operator-only work

Database/Compose migration, account consent, production secret rotation, server repair and installing a changed root-owned release command are not automated by ordinary merge. Consult cloud-development.md. Extending remote operations requires an explicit, reviewed capability; do not give all coding tasks unrestricted SSH just to remove those limits.
