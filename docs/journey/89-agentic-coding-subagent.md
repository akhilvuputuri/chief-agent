# 89 — Can Chief's coding agent work like a developer instead of a sealed job?

Work date(s): 2026-10-15. Written/revised: 2026-10-15.
Status: in progress. [Design](../coding-subagent.md) approved after two review rounds; stage 1 is implemented and dormant until the owner installs the minimal agent App. Plan approval is kept.

## User-visible problem and preceding iteration

[Journal 87](87-pi-owner-merge-feedback.md) added Devin feedback repair and an owner-confirmed merge for Pi jobs, but kept the original architecture: the sandboxed coder has no GitHub credentials, and the host commits its snapshot, marks the PR ready, relays review comments and merges. The owner reported (reported) that this is unconventional and over-isolated: the coding agent should commit, run its Argon review, mark the PR ready, handle Devin's comments and keep committing, then report to Chief, who asks the owner before merging and releasing. They also asked why neither Chief nor the coding agent can create GitHub issues; the answer was that no such capability was ever granted (logs showed no failed attempt).

## Evidence

- The host already mints repository-scoped GitHub App installation tokens with `contents: write` and `pull_requests: write` for publishing (`src/coding/github.ts`), so the app holds the permissions stage 1 needs (measured from source; app settings not inspected).
- `main` has no branch protection and no rulesets (measured via the GitHub API on 15 October). Handing the sandbox a write token without protection would let a prompt-injected agent push directly to `main`, which triggers a production release.
- The worker image has `git` but not `gh` (`Dockerfile.coding-pi`).

## Diagnosis and alternatives

Sandbox isolation from production secrets is load-bearing: the coder runs untrusted code and Chief's host holds owner credentials. Withholding all GitHub authority is not: with `main` protected on GitHub, a single-repository, short-lived token bounds the blast radius to that repository's branches, PRs and comments. Alternatives considered: keep extending host-side plumbing per GitHub action (rejected: each capability needs bespoke code and the agent cannot act on what it reads), or run the coder on Chief's host (rejected: untrusted code next to owner credentials).

## Implementation and review

Planned in three stages (see the design): (1) a per-job token through the authenticated worker connection, a credential helper, pinned `gh`, and agent-owned commits/push/draft PR with exact-artifact verification; (2) the agent owns ready, CI/Devin comment handling and re-review, with Chief resuming the same session when results arrive instead of idling a sandbox; (3) a plain "okay" reply authorizes the existing exact-head merge and release.

Independent review of the first design (`ec0d3ad`, Claude Opus 5.5) requested changes: with a single App identity holding `contents: write`, an injected agent could merge its own PR via the API once `test` passed (zero required approvals), releasing to production without the owner. The design now uses two identities: a minimal `chief-coding-agent` App for the sandbox and the existing publisher App as the only non-human identity that may update `main` (update restriction added in stage 1). It also pins token permissions (no `workflows`/`actions: write`), revokes tokens at attempt end, limits agent pushes to `chief/coding-*` and restricts tags, requires the host to witness Argon's verdict from its sealed journal, and names the resume transition and session caps.

## Verification and outcome

Nothing implemented yet. Prerequisite met on 15 October at the owner's request: repository ruleset "Protect main" (id 25169302, active on the default branch) requires a pull request and the GitHub Actions `test` check and blocks force pushes and deletion; the repository admin role may bypass for emergencies, and the Chief GitHub app is not a bypass actor. Verified through `GET /repos/akhilvuputuri/chief-agent/rules/branches/main`, the endpoint the host will check before issuing sandbox tokens.

## Follow-up and next iteration

Issue creation is a separate decision (Issues: write on the app plus a scoped tool).

### Stage 1 implementation — 15 October 2026

Implemented (tested offline, not yet enabled): Pi snapshots diff against the pinned base so agent commits keep their changes (a regression test shows a committed edit vanishing when diffing against `HEAD`); the coder is told to commit as it works; after Argon approval the worker pushes one commit built from the approved files in an isolated repository with a just-in-time token and opens the draft PR; the host verifies that PR (branch, base, exact tree, ancestry) instead of publishing; the token issuer requests exactly contents/pull-requests write and checks/statuses read, fails closed and revokes unless `main` has update, pull-request and `test` rules that the agent cannot bypass and auto-merge is off. Tests cover the pinned permission request, four fail-closed cases with revocation, a planted `insteadOf` redirect that does not capture the push, verification-before-token ordering, controller gating/caching/revocation, and publisher acceptance and rejection cases. The model does not see the token in stage 1; stage 2 gives it `gh` for the review loop.

Independent review of `84157da` (Claude Opus 5.5) requested changes. Blocking: the worker verified the workspace index but pushed the earlier HEAD commit, and a model-controlled `filter.clean` driver in the workspace made the two differ (reproduced), so an unapproved commit could reach the agent branch and CI before the host refused it. Medium: a verification failure wedged the job in `publishing`; the model's intermediate commits (any content or author) would be pushed and merged; tokens were revoked only on a successful finish. Corrections: the pushed commit is now constructed from the approved files on the base in a fresh repository, with the base fetched from GitHub, so the workspace is no longer consulted; mismatches pause the job; a per-tick sweep revokes tokens for attempts no longer running; the token response must state its permissions; repair rounds keep the commit guidance; CI runs with `contents: read`. The reviewer confirmed push isolation, fetch hardening against workspace config, gating and backward compatibility held.

### Stage 1 merged; follow-ups — 16 October 2026

[PR 240](https://github.com/akhilvuputuri/chief-agent/pull/240) merged as `0f05783` after two review rounds (approved at `7d419c7`), hosted CI and 1,214 local tests; it is dormant. The approving review left two medium follow-ups, fixed in candidate v0.3.79: a PR head that GitHub has not yet updated after a force-push is retried when the branch ref already holds the reported commit (only a different tip is a mismatch), and a mismatch pause clears `publication_started` so the owner can resume (republish the reviewed candidate) or cancel. A duplicated instruction in recovery rounds is removed.
