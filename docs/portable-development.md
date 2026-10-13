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

## Refresh before each task

Follow the a-stack `preflight` skill (CORE rule 1). This applies to research and planning as well as implementation. Read these from the freshly fetched ref, not from the checkout:

```sh
git fetch origin
git rev-parse origin/main
git show origin/main:AGENTS.md
git show origin/main:docs/current-work.md
git show origin/main:HANDOVER.md
git show origin/main:docs/portable-development.md
git show origin/main:docs/cloud-development.md
```

In Chief, deployment is established by an exact successful release receipt (`npm run release:status -- SHA`) and production diagnostics, not by main. For deliberately resumed checkpoint work, compare its behavior with current main and label the difference.

## Credentials and optional local integration tests

For actually running a separate development bot, copy .env.example to .env and set `chmod 600 .env`. Fill only credentials needed for that test environment. .env and .env.* are ignored except the placeholder .env.example. Keep .env out of artifacts, screenshots, command output, Docker build context and Git. Do not assume ignoring a file removes previously tracked secrets.

Use a distinct test Telegram bot, test database and test Google data. Starting a second poller with the production token can disrupt the live assistant. Check provider pricing before paid smoke tests; those are not part of routine CI.

Production credentials stay on the production host (AWS Lightsail) in /opt/hermes-companion/.env. Deploy authentication stays in GitHub Actions secrets. Ordinary development and deployment need neither set copied locally. No credentials have been moved by these documentation changes.

## Develop, merge, verify

Follow the a-stack `independent-review` and `ship` skills with the AGENTS.md bindings. Chief's release path, specifically:

- The release workflow rechecks the exact current-main SHA, builds on the production host, waits for idle runtime work, and checks health. A successful release prints the deployed SHA and a healthy status.
- If the release fails because of active work, retry when the runtime is idle. Do not cancel user work.
- If a newer main superseded it, verify the newer release instead.
- For database or Compose changes, follow a reviewed operator migration procedure. Do not bypass the guard.
- For shipped milestones, follow releases.md for tags and notes.

Any machine or cloud task with the private log-reader identity can read sanitized production logs with `npm run logs:cloudwatch` ([lightsail.md](lightsail.md#reading-logs)). The bounded production-diagnostics workflow runs only while the repository is private. Full private trace inspection is still unfinished. Run doctor:cloud in the actual environment; a local success does not prove another agent has permission.

## Remaining operator-only work

Database/Compose migration, account consent, production secret rotation, server repair and installing a changed root-owned release command are not automated by ordinary merge. Consult cloud-development.md. Extending remote operations requires an explicit, reviewed capability; do not give all coding tasks unrestricted SSH just to remove those limits.

## Python coding-worker checks

Repository navigation checks require Git and ripgrep (`rg`) on the development machine. Install ripgrep with the platform package manager (`brew install ripgrep` on macOS or `sudo apt-get install ripgrep` on Ubuntu). CI/manual-check workflows declare this dependency; the trusted worker image already contains it.

Chief's control service remains Node 22/TypeScript. Coding execution is a Python 3.12+ package in `coding_runtime/`; combined `npm run check` also verifies it. Create/activate a development virtual environment and install `coding_runtime/requirements-dev.txt` with `python -m pip install --require-hashes -r coding_runtime/requirements-dev.txt` before running those checks. Do not install production credentials. See [package development](../coding_runtime/README.md). CI and manual releases install the same locked dependencies; automatic releases use the passing exact-main CI result.
