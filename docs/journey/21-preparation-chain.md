# 21 — Preserving the reasoning behind preparation

Work date: 14 September 2026. Status: locally tested candidate; independent review and deployment pending.

## User-visible problem and preceding iteration

[Job alignment](09-job-alignment.md) introduced frozen target sets, source-backed requirements, qualified experience and minimum preparation. A later capability review found a gap between that rich report and saved preparation tasks: tasks held only a shared topic, exercise, criteria, priority and status. The requirement and interview references disappeared during persistence. A later reader could see what to practise without reliably reconstructing which selected posting or background assessment justified it.

## Evidence and diagnosis

**Code inspection:** the previous `prep_task_save` wrote seven task fields and no assessment links. This is a schema/tool handoff limitation, not evidence of a particular production hallucination. Existing alignment reports already retained source quotations, background evidence and per-role action links. The missing step was preserving that recorded support when the coordinator synthesized shared tasks.

The selected design extends existing Postgres tasks with a bounded evidence-chain snapshot resolved by the host from successful owner-scoped alignment reports. Rewriting quotations in new model arguments would create another chance to alter evidence. A separate learning-management subsystem would duplicate the current preparation workflow. Neither is needed for this change.

## Implementation

- Resolve scope, exact role and preparation IDs to the saved action, quoted requirements, qualified fit, background quotations or explicit question and readiness check. Keep description hashes and source references instead of copying whole descriptions into tasks.
- Require an explicit requirement-specific question for new unknown fit reports; every new preparation action needs a same-role sourced requirement. Interview findings can refine the action.
- Merge contributing role links atomically while preserving omitted progress. Empty legacy chains remain explicit; migration does not invent provenance or restart old work.
- Keep list results compact, provide version-checked paged reads, and expose the chain in the existing preparation Sheet. This follows the context-size lessons from [token investigation](03-token-cost.md) and [authoritative storage](16-authoritative-storage.md).
- Retain ordinary tool/run tracing and source child-run IDs. A status of done remains reported progress, not an independently assessed skill.

## Validation, review and limitations

Focused synthetic tests cover source/owner isolation, frozen snapshots after live edits, unknown questions, invalid/missing references, multi-role persistence, progress preservation, bounded reads and Sheet cells. Local typecheck/build and all 242 application tests plus two Google-scope tests passed. Twelve offline operator-rollout checks passed. The first focused run caught an outdated skill-version assertion and an interview-only preparation fixture; these were updated to the tightened contract. Independent Astra requested changes on `9233af1aa6c77b5d53918258e9105eb9ee3ca021`: provenance/no-link validation refusals were classified as generic tool failures, causing a false uncertain-write pause. The fix introduces a typed host validation error and runtime-level tests proving the model can correct rejected inputs while a genuinely ambiguous database acknowledgement still pauses. Re-review and deployment remain pending. The additive rollout is documented in [the runbook](../preparation-rollout.md).

These checks validate recorded support and persistence. They do not establish the semantic correctness of every fit judgment, teaching effectiveness, completeness of interview research or real-user readiness. No production role reanalysis or paid model evaluation is part of this implementation.

### Release closure — pending

Await exact-head independent Astra review, passing checks, merge, reviewed migration 015 installation and exact deployment/health verification. Package version alone does not establish release.

## Follow-up

Inspect a newly requested real preparation task after launch. Resource selection, prerequisite sequencing and assessed practice feedback can build on these links later. The portable-plugin migration of job alignment/media and observable-memory/evaluation checkpoints remain separate.
