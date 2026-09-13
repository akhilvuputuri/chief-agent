# Normalizing conversation and execution storage

Work date: 2026-09-13. Revised: 2026-09-14.
Status: released v0.3.7; storage reduction measured, API-cost impact not established.

## Problem and evidence

Conversation JSON arrays grew indefinitely. Each run could copy earlier history into its message array, and each checkpoint rewrote that array. Bounding the model prompt did not bound application reads or repeated persistence. A read-only production measurement before implementation found 1,986,341 logical bytes in conversation arrays and 64,593,295 in 41 runtime message arrays. The database occupied 65,246,899 bytes on disk. Logical JSON sizes and physical database sizes are different measurements; these numbers do not establish an API-cost problem or capacity emergency.

## Change

Owner-scoped immutable content plus ordered references replaces repeated payload copies. Checkpoints append their delta; conversation completion appends its new turn. Reads are bounded before transferring payloads to the app. Original messages remain available through lexical search and paged owner-scoped reads. Existing domain records, recovery journals and source evidence remain canonical and unchanged.

Migration 012 verifies exact reconstruction before clearing old arrays. Rollback rehydrates those arrays; reapplying the migration reconciles legacy writes while preserving existing message IDs. A reviewed one-time operator deployment script keeps this migration outside the ordinary cloud app-release permission boundary.

## Validation and remaining work

Focused tests cover migration/reapplication/rollback reconciliation, duplicate occurrences, incomplete calls, owner isolation, concurrent stale appends, bounded atomic tool groups, original-message retrieval, reset behavior, restart/uncertain writes and multi-turn integration. Full checks, exact-head independent review and verified deployment were required before release; their completed outcome is recorded below. No paid model evaluation is part of this work.

Storage diagnostics report sizes/counts without private content. Detailed model-input traces and journal result copies remain; no automatic retention purge is enabled. The observable-memory checkpoint and personal-wiki design remain subsequent work. See [architecture and rollout](../authoritative-storage.md) for current details and limitations. The v0.3.7 release closure below links the final review and published evidence.

## Independent review correction

Astra requested changes on initial head `c4d52e3`: unbounded full-text indexing rejected an 852,011-character legacy message at PostgreSQL’s tsvector limit, and fallback paging transferred the whole message before slicing it. The follow-up bounds indexing to 32,000 content characters and extracts pages/length inside SQL. Regression coverage preserves a very large original and checks non-BMP Unicode across page boundaries. Complete content remains stored; lexical search covers only the indexed prefix. The corrected head required re-review before release; that approval is recorded below.

## Release closure — 14 September 2026

[v0.3.7](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.7) shipped [PR #39](https://github.com/akhilvuputuri/companion-agent/pull/39) at `099e7478ff5d33bb240740406f822e3a01e7a580`. The [release workflow](https://github.com/akhilvuputuri/companion-agent/actions/runs/34749330357) completed successfully for that exact SHA; published release evidence records deployment and health verification. Astra approved corrected head `9e1346c624813237561cbc40daf73b4f3595c7e6`; validation included 146 TypeScript tests, two scope tests, typecheck/build/format, the operator migration, live read-only history/ownership smoke and [shared diagnostics](https://github.com/akhilvuputuri/companion-agent/actions/runs/34749415084). Domain counts were preserved.

Measured during the 13 September deployment: the previously measured conversation/run JSON arrays totaled 66,579,636 logical bytes; normalized unique content totaled 2,209,620 logical bytes, a 96.7% reduction for that stored dataset. All 15,038 ordered references were retained (14,545 run and 493 conversation references), sharing 541 owner-scoped payloads. Physical database size was measured separately at 65,246,899 bytes before and 29,914,803 afterward. These are one-deployment storage observations, not API token/cost savings or a guaranteed future compression ratio. No paid model call or real Telegram conversational acceptance was performed. The later [rolling-conversation work](17-rolling-conversation.md) addressed which originals reach context; the [observable-memory checkpoint](06-observable-memory.md) remains separate.
