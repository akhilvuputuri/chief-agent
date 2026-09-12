# Observable memory checkpoint — 12 September 2026

Unfinished candidate; NOT deployed or approved for merge. Source is on `checkpoint/observable-memory`. Start from this branch to resume; do not assume main contains it. No production credentials are required for tests.

## Implemented locally

Additive migration 010; user/assistant source records; immutable-by-application memory revisions and active heads; compatibility key/value updates; owner-scoped search/read/history tools; 6,000-character core-first memory selection; formation/retrieval/selection events; per-call scrubbed prompt manifests with deduplicated blobs; invocation-to-memory and tool-call links; restart interruption marking; private metadata/full export candidate through a restricted command and workflow.

## Verification status

Type checking passed before the last fixture updates. Initial 82-test run had 8 failures caused by old work fixtures/schema. Those fixtures were updated and all 11 work tests passed. The custom-runtime suite's old memory-write fixture was also updated. A complete final suite, focused memory tests, security review and live acceptance have NOT been completed. Do not infer readiness from these partial checks.

## Required next work

1. Read AGENTS.md, HANDOVER.md and current main changes. Rebase deliberately; do not overwrite independent work.
2. Add dedicated tests for cross-owner source denial, exact quotes, stale revisions/concurrent writes, legacy migration idempotence, source search, bounded selection/omissions, trace deduplication, prompt inclusion, scrubbing and exports.
3. Fix memory save validation failures: plain Errors for missing source/stale revision currently risk becoming uncertain writes. Use explicit pre-mutation validation classification; preserve actual uncertain writes. Test through CustomAgent, not just Memory directly.
4. Review logging correlation, owner scoping, storage growth, export size/truncation and per-call configuration capture. An ID appearing in context is not proof the full memory text was supplied; define and test the inclusion claim accurately.
5. Keep legacy memory provenance unknown and import timestamps labelled. Controlled extraction is instruction-guided, not a semantic guarantee. No raw private content in Git or CI logs.
6. Run npm ci, npm run check, npm run build, npm run format:check. Keep migration 007 and paid evals deferred.
7. Document additive migration 010 and rollback compatibility; prevent old writes drifting during cutover. Production deploy refuses DB/Compose differences. No reset or automatic task resumption.
8. Install the reviewed restricted server command through the operator path only after the app includes the inspector. A PR changing scripts/cloud-release.py does not update the root-owned server command.
9. Verify health and private trace export through the actual GitHub workflow. Record limitations; a local test does not prove cloud access.

## Later milestones

Python trace analysis and one narrow evaluation loop, then attachment ingestion. None is implemented by this checkpoint. Finish memory before widening scope.
