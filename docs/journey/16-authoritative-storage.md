# Normalizing conversation and execution storage

## Problem and evidence

Conversation JSON arrays grew indefinitely. Each run could copy earlier history into its message array, and each checkpoint rewrote that array. Bounding the model prompt did not bound application reads or repeated persistence. A read-only production measurement before implementation found 1,986,341 logical bytes in conversation arrays and 64,593,295 in 41 runtime message arrays. The database occupied 65,246,899 bytes on disk. Logical JSON sizes and physical database sizes are different measurements; these numbers do not establish an API-cost problem or capacity emergency.

## Change

Owner-scoped immutable content plus ordered references replaces repeated payload copies. Checkpoints append their delta; conversation completion appends its new turn. Reads are bounded before transferring payloads to the app. Original messages remain available through lexical search and paged owner-scoped reads. Existing domain records, recovery journals and source evidence remain canonical and unchanged.

Migration 012 verifies exact reconstruction before clearing old arrays. Rollback rehydrates those arrays; reapplying the migration reconciles legacy writes while preserving existing message IDs. A reviewed one-time operator deployment script keeps this migration outside the ordinary cloud app-release permission boundary.

## Validation and remaining work

Focused tests cover migration/reapplication/rollback reconciliation, duplicate occurrences, incomplete calls, owner isolation, concurrent stale appends, bounded atomic tool groups, original-message retrieval, reset behavior, restart/uncertain writes and multi-turn integration. Full checks, exact-head independent review and verified deployment are required before release. No paid model evaluation is part of this work.

Storage diagnostics report sizes/counts without private content. Detailed model-input traces and journal result copies remain; no automatic retention purge is enabled. The observable-memory checkpoint and personal-wiki design remain subsequent work. See [architecture and rollout](../authoritative-storage.md) for current details and limitations. Candidate v0.3.7; final review/release evidence belongs on the PR and immutable release notes.

## Independent review correction

Astra requested changes on initial head `c4d52e3`: unbounded full-text indexing rejected an 852,011-character legacy message at PostgreSQL’s tsvector limit, and fallback paging transferred the whole message before slicing it. The follow-up bounds indexing to 32,000 content characters and extracts pages/length inside SQL. Regression coverage preserves a very large original and checks non-BMP Unicode across page boundaries. Complete content remains stored; lexical search covers only the indexed prefix. Require re-review of the corrected head before release.
