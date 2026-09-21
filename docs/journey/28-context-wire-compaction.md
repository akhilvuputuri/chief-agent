# Recovering context after email retrieval

## Observation

On 21 September 2026 an owner requested three purchase confirmations. Mailbox discovery, searches and reads succeeded, but the response stopped at the application's context guard. Bounded trace metadata showed fixed input of 67,713 characters, earlier current-turn messages of 18,756, the latest tool group of 30,919 and the preceding exchange of 762. Final serialized text measured 121,651 characters against the 120,000-character guard. These are character measurements, not tokens or the provider's context-window limit. Email contents and identities are omitted here.

## Diagnosis

The preliminary estimate was below the guard, so recoverable tool results remained full. Final accounting included JSON escaping and tool wrappers, crossed the guard, and threw without attempting compaction. The latest group was also entirely reserved, preventing recoverable result bodies from shrinking. The user-facing error incorrectly suggested reducing the request despite successful retrieval. The fixed instruction/schema/state footprint already exceeded the optional-history soft target; larger-context models alone would not fix this application guard.

## Change

Keep the hard limit and existing continuity guarantees. If either preliminary or final wire accounting overflows, attempt one bounded repack using exact excerpts and original observation/source references. Compact recoverable tool results, including the latest result group; preserve the latest assistant reasoning, arguments and all call/result pairs. Original journal messages are immutable. Account and thread references survive compaction. Fail explicitly if fixed content or unreferenced results still cannot fit; never silently drop them. Context traces record serialized size and whether fallback repacking occurred. Operational failure wording no longer blames the user's batch size.

## Validation and limits

Regression tests reproduce serialized overflow with escaping, preserve latest reasoning and account provenance, assert original messages remain unchanged and keep the hard failure for unreferenced oversized results. Existing continuity checks retain user/assistant context and incomplete-group handling. This is a general packing correction, not an order-specific prompt. It does not reduce fixed tool-schema bloat or guarantee semantic extraction quality. Lazy tool selection and richer context budgeting remain separate improvements.

Candidate v0.3.20; independent review, CI and deployment pending. No automatic retry of the user's order lookup or external action is part of deployment.

## Release verification — 21 September 2026 SGT

[PR #72](https://github.com/akhilvuputuri/companion-agent/pull/72) passed both CI runs after independent GPT-6 Astra approval at `ee0c0e73a035dffbede449d3a8cada987ab680f7`. Local checks passed 342 application tests and 2 script tests plus formatting; the reviewer independently passed 15 continuity/budget/projection tests.

The installed guarded release command deployed `c323b34da7fb663ebdf8d2805c88f1e7fc1dac1f` and reported healthy. A synthetic no-network regression in the deployed container repacked to 94,033 characters below the 120,000-character limit, preserving original messages. This verifies deployed packing mechanics, not semantic completion of the original email request. No original user task was automatically resumed. Published [v0.3.20](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.20) records this evidence. No schema or Compose migration was needed.

## Follow-up — 22 September 2026: accumulation remains unbounded

A subsequent mailbox lookup failed at 00:36:55 SGT after 21 completed tool invocations. Bounded production diagnostics measured fixed context 67,736 characters, older current-turn work 43,291, protected preceding exchange 961 and latest tool group 15,070: an estimated 127,058 characters against the unchanged 120,000-character internal guard. This was a pre-provider failure, not a model API context rejection. Earlier requests in the same run recorded wireCompacted=true, including a 117,246-character request; the preceding patch was active and did repack results, but did not make a long run bounded.

Read-only aggregate inspection found 8 observation reads, 4 message reads, 3 thread reads, 3 mailbox searches, 2 failed page reads and 1 account lookup. No private message text is reproduced here. The working projection retains every complete current-turn tool group; shortening each result does not bound their total as the run grows. The fixed envelope already exceeds the 48,000-character soft history target. A synthetic local inventory (not an exact live decomposition) with common integrations enabled contained 62 tools with 33,815 schema characters and 12,725 instruction characters, before memory/archive/current-state additions.

The [OpenRouter endpoint metadata](https://openrouter.ai/api/v1/models/openai/gpt-5.6-sol/endpoints), checked on 22 September, advertised 1,050,000 context tokens for this model; several endpoints separately reported 922,000 maximum prompt tokens. The last three completed calls in this run reported 28,528, 26,456 and 31,420 prompt tokens (newest first); these are provider-reported counts for those successful calls, not an estimate for the refused next request. Characters and tokens are different units. Our application guard is not derived from those model limits, so this incident does not establish exhausted provider capacity.

**Diagnosis, not an implemented fix:** separate provider capacity from an operational soft target with token-aware accounting; load relevant capability definitions/instructions on demand; and introduce bounded rolling working checkpoints with exact source/read references. Preserve current intent, selected targets, pending approvals and uncertain actions; do not fix accumulation by silently dropping the preceding exchange, which would regress the earlier conversation-routing incident. Reserve room for a useful final response or resumable checkpoint. Raising the old guard supplies headroom but is not a complete accumulation policy. No limit, model, data or paused-task state was changed during this investigation; remediation needs focused long-run and cross-topic regressions.
