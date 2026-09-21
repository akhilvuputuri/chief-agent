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
