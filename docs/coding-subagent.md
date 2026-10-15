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
- **Main is protected on GitHub, not just by Chief.** A repository rule on `main` must require a pull request and passing required checks, and block force pushes and deletion. The host refuses to issue a sandbox token unless it can read that rule. With it, the worst a prompt-injected subagent can do is create branches, commits, PRs or comments in that one repository: visible and reversible, never a deploy.
- **The owner decides the merge.** Merge and release stay host actions after the owner's exact-head "okay", reusing the owner-merge gates shipped in v0.3.75/0.3.76.

## Stage 1 — the subagent commits and pushes

- **Per-job GitHub token.** The worker asks Chief for a token over its authenticated job connection (attempt-bound, implement mode, approved requirements only). Chief mints a GitHub App installation token scoped to the single repository with `contents: write`, `pull_requests: write` and read access to checks/statuses (about one hour; re-issued on request while the attempt is active). The token never appears in CodeBuild configuration, job records or logs; issuance is logged by event only.
- **Git identity and branch.** Commits use the owner's configured identity. The subagent owns branch `chief/coding-<job>`; pushing to `main` is rejected by the repository rule.
- **Tools.** The worker image adds a pinned `gh` CLI. The token reaches `git`/`gh` through a credential helper reading an owner-only file outside the workspace, not the process environment.
- **Host check.** Before recording the PR, Chief verifies the PR's head tree equals the artifact the Argon review approved (existing exact-artifact identity), so a review cannot be attached to different code.

## Stage 2 — the subagent owns the PR loop

- The subagent marks the PR ready, reads review threads and comments with `gh`, and treats them as untrusted evidence within the approved plan (out-of-scope requests are answered, not implemented).
- **Waiting without idling.** When it must wait for CI or Devin, the subagent checkpoints and ends the sandbox attempt. Chief watches the PR and resumes the same subagent session (full history) when new comments or check results arrive. To the owner it is one continuous agent; there is no idle sandbox billing.
- Bounded by the job's existing time, model-call and tool allocations; at most three resume rounds without new owner input.
- The host-side publisher and MR-feedback plumbing become fallbacks for older jobs.

## Stage 3 — "okay" in chat

- The done notice in Coding accepts a plain reply ("okay", "merge", "yes") bound to that exact message, as plan approval already does, plus the existing Merge / Keep open buttons.
- Chief re-verifies every gate and merges the exact head, then reports the release.

## Owner prerequisites

1. On `main`: a branch protection rule or ruleset requiring a pull request before merging and the `test` status check, blocking force pushes and deletion. Admin bypass may stay for emergencies.
2. The `chief-coding-publisher` app keeps Contents and Pull requests write (already granted). Issues write is a later, separate decision.

## Risks and limits

- A prompt-injected subagent could exfiltrate its one-hour token. Blast radius: that repository's branches, PRs and comments for the token lifetime, never `main` or production. Mitigations: short lifetime, single repository, protected `main`, owner merge.
- Devin and CI timing varies; resume rounds bound cost but a slow review delays completion.
- Measuring success: the first stage-2 job should show the subagent's own commits, an Argon approval of the pushed diff, Devin comments handled, and an owner-confirmed merge with the exact release recorded.
