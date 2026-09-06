# Reliable execution foundation

This release addresses shared execution failures across research, synthesis and personal assistance. It does not encode the user's recent job-search conversation as a workflow. Gemini 3.8 Flash remains the daily model, on the existing server.

## Runtime responsibilities

- The gateway derives the tool schema from the same Zod operation definitions it validates. Current connection availability accompanies each turn; stale conversation claims do not define capabilities. A configured connection may still need renewed authorization.
- Substantial tasks can have a durable objective, original user request, scope revisions, steps, results, source evidence and tool receipts in Postgres. One active task per user is supported initially.
- Research completion requires a stored passage, a source owned by the user and an explicit applicability assessment. Mismatched or unverified evidence cannot satisfy an evidence step. Search discovery alone is insufficient.
- Write/export completion requires a successful receipt for the step's specified operation. A memory or preparation save cannot satisfy a Sheet export step. Analysis links its underlying evidence or receipts.
- Scope revision resets completion conservatively while retaining source evidence, receipts and the objective/request revision history. Workers from an older revision cannot continue making tool calls. The model must inspect existing outputs before repeating writes.
- Tracked responses render persisted step counts and results rather than the model's unconstrained completion narrative. Ordinary conversation remains conversational.
- Turn exhaustion is an explicit interruption, not success. Framework-generated stop instructions are removed from newly persisted chat history.
- Structured tool errors distinguish invalid inputs, missing connections, authorization, unavailable records, and unrecorded results. Raw provider errors and credentials are not returned to the model.

## Continuation

The model checkpoints steps and calls `work_yield` when work can continue without user input. A Postgres-backed worker runs up to three additional passes, each retaining the existing 12-iteration turn ceiling. It reports recorded progress to Telegram. These are execution bounds, not a measured dollar budget.

`/continue` queues a further bounded set of passes for active/paused work. `/workcancel` stops future work; it cannot undo an external action already in progress. Background passes use the recorded task rather than overwriting the user's conversational history, and cannot revise the scope themselves.

Queued work survives process restart. A running lease stale for five minutes pauses for inspection instead of blindly replaying uncertain writes. Saved task results remain available through `work_status`. There is no separate development server or shell access.

## Repo skills and personal overrides

Four small baseline packs live in `skills/`: research, synthesis, task-execution and personal-assistance. They guide source applicability, uncertainty, full-scope planning, checkpointing and use of general task tools. They ship with the application and are versioned through Git.

Personal skill versions remain private in Postgres. A relevant approved version can override the baseline guidance; drafts remain inactive until evaluation and owner approval. Skills cannot grant permissions or bypass the gateway's validation. Repo skills supply reusable reasoning guidance; completion checks and permissions belong in code.

## Validation and practical limits

Deterministic regressions cover cross-domain version/location mismatches, invented quotes, owner isolation, failed exports, wrong-operation receipts, expanded scope, stale/background revisions, continuation limits, interrupted turns and configuration-derived schemas. The pinned Hermes runtime smoke exercises the actual registry, authenticated tool callback and repeated turn-specific schema registration against a local fake model.

`services/hermes/evaluate_behavior.py` is an optional paid-model evaluation using synthetic tools and no production data. It checks version-specific research and preservation of uncertainty about a user's experience. Build first and run with the pinned Hermes Python and model credentials in the environment. Results are examples of observed behavior, not a broad benchmark or a guarantee.

Remaining limitations:

- Task decomposition, whether substantial work gets tracked, source applicability, claim entailment and semantic deduplication still involve model judgment. A stored quote is not independent factual verification.
- Receipts validate ownership, task and operation, but do not independently prove that the returned content fully satisfies the user's intent. Step selection itself is agent-authored.
- A Sheet export remains a separate explicit tool action. A failed tracked export stays incomplete and can be resumed; there is no standalone export outbox or exactly-once guarantee across external services.
- A bounded continuation is not an unlimited background workflow engine. Paused work and expired OAuth connections can still need user intervention.
- No frontier delegation, autonomous code deployment, arbitrary shell, authenticated browser, Gmail sending, Calendar writing or realtime voice is enabled by this release.

### Observed evaluation — 6 September 2026

Both synthetic Gemini 3.8 cases passed against the pinned Hermes runtime. The product-version case initially omitted a source ID and later attempted to complete an analysis from mismatched evidence. The fixture rejected both; the model retrieved the source, recorded the mismatch and left the unsupported work blocked. The background-experience case asked questions and preserved uncertainty without writes. This is evidence of recovery under enforcement, not flawless first-attempt model behavior. The initial looser fixture was corrected to require retrieval and the returned source ID before accepting evidence.

### Deployment verification

PR #4 was merged and deployed to the existing DigitalOcean host. Migration 005 succeeded; gateway, Hermes and Postgres health checks passed. A direct authenticated model/bridge health turn recognized the generated work and Sheets capabilities, without Telegram delivery or production task writes. The work table was empty after deployment; older conversations are not retroactively converted into tracked tasks. A follow-up validation fix rejects whitespace-only source quotations.
