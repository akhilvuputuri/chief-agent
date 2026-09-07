# Runtime development process

## Incident and hypothesis

On 7 September 2026, a 22-role review retrieved the correct saved collection but later produced unrelated postings. The database records remained intact. Inspection showed 99 tool calls, repeated bookkeeping snapshots, and final context eviction of 172 of 198 preceding messages. Completion accepted genuine read receipts attached to unsupported synthesis. The two-role acceptance test had also been placed in production chat history and was subsequently mistaken for a user instruction.

The working hypothesis is that durable execution without durable, retrievable scope is insufficient. Recency-only context selection and verbose control responses remove useful evidence. Model-editable verification categories weaken completion. A read operation returning analysis inputs is not completed analysis. Context loss explains opportunity for failure, not the exact internal cause of every invented company.

## Method

1. Freeze a synthetic baseline before changing runtime code.
2. Establish deterministic checks for identity, scope, coverage and authorization.
3. Run the real model with controlled tools in a fresh isolated database.
4. Inspect full input/output traces and human-review reasoning quality separately.
5. Change one mechanism and repeat the same scenarios and grader versions.
6. Report failures as well as improvements. Keep fixture changes explicit; never present mismatched fixtures as a controlled comparison.
7. Run held-out variations before broader reliability claims. One successful run is not a success rate.

## Planned stages

- Eval foundation: three synthetic cases, offline context-pressure probe, grading tests, reports and comparison tooling.
- Compact observations and fresh context: bounded control responses, retrievable large observations and current checkpoint injection.
- Durable collections and findings: stable identities captured from actual tool observations, versioned scope and per-item saved results.
- Completion and repair: target-linked checks, protected requirements and repeated-error handling.
- Recovery and rollout: preserve the incident record, exclude invalid synthesis from future context, isolate operator tests and validate before deployment.

The application stays TypeScript and Postgres with the existing model/provider configuration. Telegram presentation stays model-written. Structural validation does not certify semantic source interpretation. No new infrastructure is required.

## Baseline interpretation

The offline probe fails to retain inventory under repeated bookkeeping pressure. This is a deliberately constructed selection test, not a replay of the live incident. Initial model trials are smoke baselines; the long collection case reached its 24-call allocation without a valid final artifact, while the missing-evidence case preserved unknowns. Exact final results and run configuration are recorded under docs/evals after the baseline finishes.

The first development trial used a synthetic web response shape before TypeScript validation was added for the eval directory. The adapter was corrected to match the provider contract. Do not compare that preliminary run as an identical-fixture candidate baseline; rerun the finalized runner before runtime changes.

## Review responsibilities

Automated graders check explicit IDs, exact titles, missing and duplicate targets, machine-readable format, and known fixture uncertainty. Humans check whether explanations are supported and useful. No model-based judge is implemented. Production actions and cloud writes are outside the eval environment; only bounded paid model inference is external.

## Research informing this work

- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents — compact context and persistent notes.
- https://www.anthropic.com/engineering/writing-tools-for-agents — concise outputs and actionable errors.
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents — durable requirements and progress.
- https://docs.langchain.com/oss/python/deepagents/context-engineering — offloading and targeted retrieval.

Community reports informed failure hypotheses, not measured claims about our system. We retain our own implementation and test the techniques against our actual boundaries.

## Stage 1 — compact observations and live checkpoints

Full operation results remain in runtime_calls. Model-facing observations now omit repeated owner metadata and large role descriptions, and expose an observation ID. observation_read performs an owner-scoped read of a successful persisted call, with bounded pagination. Work updates omit accumulated receipt/evidence payloads. The current task snapshot is refreshed before each model request instead of remaining frozen at turn start.

Regression coverage includes cross-owner observation denial, bounded task-update size and preservation of collection identities. This stage reduces context pressure; it does not yet enforce immutable collection membership or certify semantic completion. The raw-history context-pressure probe is deliberately unchanged and can still fail: it does not exercise the new observation projection.
