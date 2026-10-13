# 84 — How can the development workflow apply across repositories without copies drifting?

Work date(s): 2026-10-14. Written/revised: 2026-10-14.
Status: in review. The workflow plugin is released in a-stack as `workflow--v0.1.0`. Chief's adoption (this PR) is not yet merged.

## Problem and preceding iteration

Chief's development workflow grew through incidents and review corrections: the cloud-agent harness ([29](29-cloud-agent-harness.md)), the independent review loop ([10](10-foundation-review.md)), the freshness rules for parallel sessions, release receipts, and evidence-labelled journal entries. All of it lived in Chief's AGENTS.md, REVIEW.md and several docs, mixed in with Chief-specific architecture and operations.

Another repository (a-stack) had already copied a reduced version of the review rules, and they were beginning to diverge. The owner wants one source for the workflow that every repository depends on.

## Evidence

- **Reported:** owner request, 14 October 2026, to centralise the workflows in a-stack, have each repository's AGENTS.md point to it as a dependency, and remove duplicated content from Chief, keeping only critical repository-specific rules.
- **Tested** (a-stack [PR 6](https://github.com/akhilvuputuri/a-stack/pull/6)):
  - 42/42 tests and `claude plugin validate` pass.
  - An isolated install lists 7 skills and 1 SessionStart hook.
  - A `--plugin-dir` debug log shows the hook running and returning the full core text.
  - Mutation checks fail as intended.
- **Tested** (14 October 2026, Claude Code 2.1.283, isolated `CLAUDE_CONFIG_DIR`): `claude plugin marketplace add 'akhilvuputuri/a-stack#workflow--v0.1.0'`, followed by `claude plugin install workflow@a-stack`, installed version 0.1.0 from GitHub with 7 skills and 1 SessionStart hook. The cached `CORE.md` is byte-identical to the tagged source.
- **Measured:** Chief's AGENTS.md shrank from 18,802 to about 14,000 bytes. The plugin's core text is 5,286 characters and is loaded once per Claude Code session.
- **Not verified:**
  - that the model reads the hook output in an authenticated turn
  - that cloud sessions (claude.ai/code) install project-pinned plugins and run their hooks
  - automatic marketplace registration when a folder is trusted
  - Codex behaviour

## Diagnosis and alternatives

The generic rules (freshness, capability checks, exact-head independent review, verified delivery, evidence labels, records, commit identity) are the same for every repository. The repository-specific parts are commands, reviewer choice, release verification, record paths and exceptions.

Alternatives considered:

- **Copy the rules into each AGENTS.md.** Rejected, because it causes the drift being fixed.
- **Rely on skills alone.** Rejected, because skills load only when a task matches them, so the always-on rules would not be guaranteed.
- **Point AGENTS.md at a URL only.** Rejected, because agents that only read AGENTS.md, and Chief's own sandboxed coding runtime, may have no network access.

The chosen design has three parts:

- a pinned Claude Code plugin whose SessionStart hook supplies the core rules, with skills for the procedures
- a short AGENTS.md block that repeats five non-negotiable rules
- a bindings list holding the repository specifics

## Implementation and review

**In a-stack:** `plugins/workflow` contains `CORE.md`, a SessionStart hook, and the skills `preflight`, `independent-review`, `ship`, `journal`, `incident`, `experiment` and `adopt`. The independent Opus 5.5 review of `1ef612b` requested changes:

- **Blocking:** the review skill allowed a backgrounded reviewer.
- **Non-blocking:**
  - skill frontmatter could declare hooks
  - adoption could downgrade an existing marketplace pin
  - the review wording was inconsistent
  - a journal template link was broken

All five were fixed. The delta review approved `8c6ae40`. Devin Review reported no bugs. The PR merged as `00149678c0f5608be34226af4ef22d2c69270b22`, which is tagged `workflow--v0.1.0`.

**In Chief (this PR):**

- **`.claude/settings.json`:** pins `workflow@a-stack` at `workflow--v0.1.0`.
- **AGENTS.md:** opens with the workflow block and Chief's bindings: checks, reviewer, merge authority, release, records, diagnostics and exceptions. The generic freshness, review-loop, journal-rule and commit-identity sections were removed. The architecture, product and safety constraints, cloud parity priority, coding-squad review exception, documentation scope, plugins and storage sections stay.
- **CLAUDE.md:** now only points to AGENTS.md.
- **Docs with generic procedure:** `portable-development.md` (refresh, develop/merge/verify), `cloud-agent-workflow.md` (review and merge), `releases.md` (publishing steps) and the journal README (evidence rules) now point to the matching skills. They keep only Chief's commands and release behavior.
- **REVIEW.md stays complete.** Chief's coding runtime reviewers (`src/coding/worker.ts`, `coding_runtime/.../worker.py`, Pi) read AGENTS.md and REVIEW.md inside sandboxes, without the plugin or network access. REVIEW.md therefore keeps its full checklist and only adds a link to the shared contract.

## Verification and outcome

Local checks on this branch (14 October 2026):

- `npm run build`, `npm run format:check` and `npm run check:pi` (52/52) pass.
- In `npm test`, 894 TypeScript tests and the scripts, picker, context and decisions suites pass.
- `evals/coding/test_benchmark.py` fails because the `chief-protocol-*` fixtures exit 1 in every phase. It fails identically on unchanged `origin/main` `e4b71ad` on this Mac, because system Python 3.14 lacks the locked Pydantic development environment. That makes it a local environment limitation, not a regression.
- `check:coding` (ruff/mypy) was not reached locally. CI runs the full check.

Independent review and merge are pending. This is a documentation and configuration change with no runtime code, so a release redeploys the same application behavior.

Remaining acceptance: a fresh authenticated Claude Code session in this repository registers the a-stack marketplace on folder trust, installs `workflow@a-stack`, and shows the core rules. The same check is needed in a Claude cloud session.

## Follow-up and next iteration

- Verify plugin loading in local and cloud Claude sessions, and record the result here.
- Changes to workflow rules now go to a-stack as a new plugin version. Chief moves to it with a reviewed PR that changes the pinned ref.
- Adopt the workflow in other repositories with the `adopt` skill.
