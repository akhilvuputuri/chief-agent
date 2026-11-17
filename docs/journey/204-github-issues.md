# 204 — How can Chief file GitHub issues without filing one the owner has not approved?

Work dates: 2026-11-17. Written: 2026-11-17.
Status: tested, not released. Needs the operator rollout and the owner's token in [GitHub issues](../github-issues.md#operator-rollout).

## User-visible problem and preceding iteration

On 17 November 2026 the owner asked Chief to file a GitHub issue for a set of bugs. Chief had no GitHub access, so the bug log went to a canvas and a separate coding job filed it. The owner asked for a feature so Chief can file issues itself, after approval.

## Evidence

- Tested: `tests/github-issues.test.ts` (mocked GitHub) covers draft, approve, discard, missing token, allowlist, duplicate and simultaneous taps, refusals, timeouts, settlement, Telegram wording, and a retry after an uncertain attempt.
- Reported: not yet tried against real GitHub or production.

## Diagnosis and alternatives

GitHub's issue API has no request key. The host therefore claims the approval row before posting, puts a marker in the body, and settles an uncertain attempt by reading the repo's issues. Alternative considered: a GitHub MCP connection. It would not give the approval-card boundary or the single-write restriction.

## Implementation and review

The design follows Calendar drafts: the `approvals` table, migration 037, a `gh:` callback, and a `github` tool domain with guidance. Independent review (8a52aad) asked for outcome-aware Telegram wording, a correct rollback note, a full body preview and Telegram tests; Devin asked for a duplicate-draft guard after an uncertain attempt and a partial-search warning. All were fixed.

## Verification and outcome

`kite run check` and `kite run format:check` pass. Picker evals (`kite run eval:picker`) are for the owner to run. Live acceptance: file a harmless test issue after the rollout.
