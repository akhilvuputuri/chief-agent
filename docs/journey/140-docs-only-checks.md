# 140 — Can a docs-only pull request skip the code jobs without weakening the gate?

Work dates: 1 November 2026. Written: 1 November 2026.
Status: on [PR 387](https://github.com/akhilvuputuri/chief-agent/pull/387). A forced docs-only run took 49 s. No real docs-only PR has run on it yet.

## User-visible problem and preceding iteration

[Journal 139](139-ci-audit-pi-split.md) found that 15 of the last 60 merged PRs changed only docs, yet each ran about 165 s of checks that build and test code none of them touched.

## Evidence

- **Measured:** no test, script or image reads the files in `docs/`. Tests that mention `docs/` paths use them as fixture names.
- **Measured:** `prettier --check .` covers the docs, so `format and types` still applies to these PRs.
- **Measured, TypeScript 7.0.2 against 5.9.3:** `tsc` output was byte-identical across all 222 emitted files. The `typescript` package no longer exports the JavaScript compiler API (`createSourceFile`), which `scripts/pi-report-acceptance.mjs` and two scripts in `scripts/pi-acceptance/` use.

## Diagnosis and alternatives

- **`paths-ignore` on the workflow:** rejected. The required `test` check would never report, and the PR could not merge.
- **Skipping `format and types` too:** rejected, because it would let a badly formatted doc reach main and fail there.
- **Affected-only tests:** rejected for now. A wrong guess would hide a failure until main, and a full run takes under three minutes.
- **TypeScript 7:** deferred. The type-check job doesn't set wall time, so the gain would be local speed and a shorter non-limiting job. Adopting it now means carrying two compilers or rewriting those scripts. Revisit when its API settles.

## Implementation and review

- **`scripts/docs-only.mjs`** decides from the changed paths. Only `docs/**`, `README.md`, `HANDOVER.md` and `CONTRIBUTING.md` qualify, so anything else, or an empty list, runs everything. `AGENTS.md` and `CLAUDE.md` are excluded because they instruct coding agents.
- **The `changes` job** compares a PR's merge commit with its first parent, with `--no-renames` so a file moved into `docs/` still counts its old path. Pushes to main always run everything, so the release workflow is unaffected.
- **The `test` gate** accepts a skipped job only when `docs_only` is true, and always requires `changes` and `format and types` to succeed.
- **A bug caught before pushing:** the first gate used `test … || { test … && test …; }`. Under `bash -e` that passed a skipped job on a code change when a successful result followed it. It now uses explicit `if` and `exit 1`.
- **`scripts/docs-only.test.mjs`** tests the decision and runs the gate script as it appears in `ci.yml`, including that case. It runs in `test:other`.

## Verification and outcome

**Measured, run 41225660019, with a temporary commit forcing `docs_only=true`:** 49 s. `what changed`, `format and types` and `test` passed, and all code jobs were skipped. That commit is not in the merged code, so this proves the skip path and the gate on GitHub, but not the decision on a real docs-only diff.

### Release closure

Pending.

## Follow-up and next iteration

- The first real docs-only PR after this merges proves the decision on a real diff, and should finish in about 50 s.
- **Owner's decision, still open:** parallel test files ([journal 139](139-ci-audit-pi-split.md)).
