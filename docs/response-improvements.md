# Focused response improvements — September 2026

The broader durable-scope/eval candidate is checkpointed on `feature/runtime-evaluations` at `77c1b59` and is not deployed. This smaller change addresses observed response defects without adding its schema or tools.

## Changes

- Refresh the current task before each model request. A checkpoint should not remain frozen for an entire long turn.
- Preserve a compact inventory of successfully retrieved records in current model context. IDs, titles, companies and URLs come from stored tool results for this run or its attached task. Other owners and unrelated tasks are excluded. The initial and latest collection observations are both retained so a later empty/filtered retrieval cannot erase the starting inventory. Up to 60 records per observation are included; larger results retain a retrieval pointer.
- Shorten large observations and repeated work responses. Complete results remain in Postgres and are retrievable through owner-scoped `observation_read`. Keep source IDs visible even when page bodies are shortened.
- Budget instructions, memories, tools and current state before selecting recent history. Preserve complete tool-call/result groups and trace omissions.
- Explain Telegram delivery to the model: lead with useful outcomes, report meaningful changes rather than repeat the ledger, hide internal bookkeeping unless asked, and summarize confirmed Sheet changes with a link. No forced visual template or bullet count is added.
- Clarify tool semantics: `job_analyze` returns inputs, source IDs and receipt IDs are different, and recommended listings are not the saved target.
- Allow an actual successful read receipt to satisfy a step explicitly requiring that read operation. Existing distinct-operation checks still reject using it as evidence of an export/write.

## What this does not claim

The refreshed inventory is a retrieval aid, not an immutable user scope or semantic verifier. It does not prove that the model selected every requested target or that its conclusions are true. The stricter scope/finding and completion system remains deferred. No RAG, vector store, automatic memory consolidation, new provider or paid infrastructure is added.

Existing explicit memories are key/value facts and preferences in Postgres; recent conversation and task checkpoints are supplied separately. RAG would help retrieve relevant material from a larger personal document collection, but it would not replace exact record identity or completion checks.

## Verification

Use `npm run check`, formatting and build checks. New deterministic checks cover compact inventory size, all 22 identities, owner/task isolation, resumed-task retrieval, preserved source identifiers and successful read-step proof. Existing tests retain authorization and write-proof checks. No further paid eval is needed for this focused checkpoint; end-to-end improvement in real conversation remains to be observed, not asserted.

## Release verification

PRs #14 and #15 merged after CI passed. Application revision `1a43301b6504da99a4f9c0af9dd56fa663e5fac7` is deployed on the existing DigitalOcean server. Health passed; 22 jobs and six memories remain. No database migration or data reset was performed.

A read-only check against the actual incident run retrieved the original 22-record inventory alongside its later empty inventory in 4,405 characters. This verifies availability of the correct starting records after the previous context-loss incident; it does not certify a new model-generated analysis. The full 22-role task was not rerun. The previous application image remains tagged for rollback.
