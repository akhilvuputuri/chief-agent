# Agentic coding subagent — design

Status: proposed, 15 October 2026. Owner-approved direction; built in stages, each through the normal review and release path. Supersedes the host-publisher and host-feedback parts of [coding automation](coding-automation.md) for new Pi jobs once stage 2 ships; older jobs keep their snapshot.

## Goal

Chief delegates a code change to a coding subagent that works like a developer on a team:

1. Chief turns the owner's request into a plan; the owner approves it (unchanged).
2. The subagent implements in its sandbox, **commits and pushes its own branch**, and opens a draft PR.
3. It runs the real checks and asks its **Argon reviewer subagent** for an independent review of the pushed diff; it fixes and re-reviews until approved.
4. It marks the PR **ready**, handles **every Devin and review comment** (fix, commit, push, reply, resolve), re-running checks and review as needed.
5. When CI, Devin and Argon are all clear, it reports **done** to Chief; Chief tells the owner in Coding.
6. The owner says "okay" (reply or button). Chief merges that exact head and watches the release.

## What stays protected, and why

- **Sandbox isolation.** The subagent runs untrusted code (`npm install`, tests). It runs in the separate CodeBuild sandbox and never receives production secrets (Gmail, Calendar, IBKR, Telegram, database, model provider keys). Model calls keep going through Chief's authenticated proxy.
- **Two GitHub identities.** The sandbox token comes from a separate, minimal **`chief-coding-agent`** GitHub App (contents and pull requests write only; never `workflows`, `actions: write`, `administration` or secrets access). The existing **`chief-coding-publisher`** App stays on the host and is the only non-human identity allowed to update `main`. Independent review found that a single identity with `contents: write` could merge its own PR through the API once `test` passed (zero required approvals), which would trigger a production release; separating the identities removes that path.
- **Main is protected on GitHub, not just by Chief.** Rulesets on `main`: pull request and the `test` check required, no force pushes or deletion (applied), plus an **update restriction** whose bypass list is only the repository admin role and `chief-coding-publisher` (stage 1). Agent pushes are limited to `chief/coding-*` branches and tag creation is restricted, so an injected agent cannot rewrite other branches or cut releases. Before minting, the host reads the effective rules for `main` and the agent branch pattern and refuses unless the update restriction (with the agent App absent from bypass) is present.
- **The owner decides the merge.** Merge and release stay host actions after the owner's exact-head "okay", reusing the owner-merge gates shipped in v0.3.75/0.3.76.

## Stage 1 — the subagent commits and pushes

- **Per-job GitHub token.** The worker asks Chief for a token over its authenticated job connection (attempt-bound, implement mode, approved requirements only). Chief mints a `chief-coding-agent` installation token scoped to the single repository with exactly `contents: write`, `pull_requests: write` and `checks`/`statuses: read` (pinned in code; never `workflows` or `actions: write`, so workflow files cannot be pushed and workflows cannot be dispatched). It lasts at most one hour, is re-issued on request while the attempt is active, and is revoked (`DELETE /installation/token`) when the attempt ends. The token never appears in CodeBuild configuration, job records or logs; issuance and revocation are logged by event only.
- **Git identity and branch.** Commits use the owner's configured identity. The subagent owns branch `chief/coding-<job>`; pushing to `main` is rejected by the repository rule.
- **Tools.** The worker image adds a pinned `gh` CLI. The token reaches `git`/`gh` through a credential helper reading an owner-only file outside the workspace, not the process environment.
- **Host-witnessed review.** The subagent invokes Argon, but every reviewer model call still passes through Chief's proxy and is sealed in the host journal. Chief accepts an approval only from that sealed reviewer response (the proof used since v0.3.75) and verifies the PR's head tree equals the reviewed artifact, so a self-reported or mismatched review is rejected.

### Stage 1 ruleset and verification requirements

From the second design review:

- **Separate update ruleset.** Put the `main` update restriction in its own ruleset, bypassed only by the admin role and `chief-coding-publisher` with `bypass_mode: pull_request`, so the publisher can update `main` only by merging a PR and never skips the PR or `test` requirements of "Protect main".
- **Host verification from the agent's side.** Rule endpoints do not reveal bypass actors to non-admin callers. Before using a token, the host queries `GET /repos/{repo}/rules/branches/main` with that agent token and requires `update`, pull-request and `test` rules to be present; then, for each returned `ruleset_id`, `GET /repos/{repo}/rulesets/{id}` with the same agent token must report `current_user_can_bypass: "never"`. The App permission needed to read rulesets is confirmed when stage 1 is built. The host also requires repository auto-merge to stay disabled and checks `base.ref == main` at merge.
- **Branch limit.** A ruleset on all branches except `chief/coding-*` restricting creation, update and deletion, bypassed by the admin role, the publisher App and Devin's bot if it pushes branches. The agent can still write other jobs' `chief/coding-*` branches; the exact-head merge gate bounds that.
- **Tags.** A tag ruleset restricting creation, update and deletion, bypassed by the admin role.

## Stage 2 — the subagent owns the PR loop

- The subagent marks the PR ready, reads review threads and comments with `gh`, and treats them as untrusted evidence within the approved plan (out-of-scope requests are answered, not implemented).
- **Waiting without idling.** When it must wait for CI or Devin, the subagent checkpoints and ends the sandbox attempt (its token is revoked). Chief watches the PR and resumes the same subagent session (full history) when new comments or check results arrive. To the owner it is one continuous agent; there is no idle sandbox billing. Implementation must define the `pr_ready` → new attempt → `running` transition and its hand-off with the automation lease (session entries can only be appended while an attempt is running), and keep resume rounds within the session store's caps (64 MB and 10,000 entries per job).
- Bounded by the job's existing time, model-call and tool allocations; at most three resume rounds without new owner input.
- The host-side publisher and MR-feedback plumbing become fallbacks for older jobs.

## Stage 3 — "okay" in chat

- The done notice in Coding accepts a plain reply ("okay", "merge", "yes") bound to that exact message, as plan approval already does, plus the existing Merge / Keep open buttons.
- Chief re-verifies every gate and merges the exact head, then reports the release.

## Owner prerequisites

1. Done 15 October: ruleset "Protect main" (pull request, `test` check, no force pushes or deletion; admin bypass).
2. Create and install a second GitHub App, **`chief-coding-agent`**, on this repository only, with Contents: read and write, Pull requests: read and write, Checks: read, Commit statuses: read, Metadata: read, and nothing else. Put its app ID, installation ID and private key in the production `.env` (the owner's action; credentials never pass through chat).
3. Stage 1 then adds the `main` update restriction (bypass: admin role and `chief-coding-publisher`), the `chief/coding-*` branch limit and tag restriction, and verifies them through the API before the first token is issued.
4. Issues write is a later, separate decision.

## Risks and limits

- A prompt-injected subagent could exfiltrate its token. Blast radius: `chief/coding-*` branches, PRs and comments in that one repository until the token is revoked at attempt end (at most one hour); never `main`, tags, workflow files or production. Mitigations: separate minimal App, short lifetime with revocation, single repository, update-restricted `main`, owner merge.
- Repository Actions secrets (such as the deploy key) are not bound to an environment; they stay unreachable only because the agent token cannot push workflow files or dispatch workflows and only `main`/trusted paths use them. Moving deploy secrets into a protected environment is a recommended hardening.
- Devin and CI timing varies; resume rounds bound cost but a slow review delays completion.
- Measuring success: the first stage-2 job should show the subagent's own commits, an Argon approval of the pushed diff, Devin comments handled, and an owner-confirmed merge with the exact release recorded.
