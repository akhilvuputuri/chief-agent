# Job alignment: flexible scope, grounded preparation

The purpose is to turn the user's requested roles into evidence-backed fit assessments and the minimum useful preparation. The user may select any subset or all saved roles. Role comparison is optional, not the default workflow. The general research specialist remains available for other domains.

## Runtime path

The coordinator calls `job_alignment_start` with an objective, either exact saved IDs or `allSaved=true`, and relevant memory keys. All-saved means all non-archived owner records, regardless of application status. New URL-only roles first use existing save tools. The runtime freezes the selected job records, descriptions, selected memory values and timestamps, and active job-alignment skill text/version/hash in a private `job_alignment.scope` event. These snapshots belong to the authenticated owner and cannot be altered through model arguments.

Each invocation handles up to two pending roles through the shared read-only specialist runner. This is an internal context/output bound, not a restriction on the user's requested scope. The coordinator automatically calls `job_alignment_resume(scopeId)` while work and the existing allocation remain. Substantial requests should use existing task tracking; the saved scope ID belongs in the checkpoint. `/continue` uses the existing task-budget mechanism. Scope history in context helps recovery but never authorizes restarting an old request automatically.

Children may use public search/read/source tools, `job_alignment_input` for full assigned snapshots, and `job_alignment_report`. The main agent retains responsibility for conversations, authorized domain changes, preparation deduplication and requested Sheet sync. Child time is bounded to five minutes, twelve model calls and thirty tool calls, further limited by the parent's remaining allocation with a small response reserve. No dollar cap, parallel worker scheduler or new infrastructure is introduced.

## Assessment and validation

A report contains exact target IDs, qualified identity verification, essential/preferred/inferred requirements, experience alignment, interview evidence, minimum/optional preparation and unknowns. Fit is demonstrated, transferable, confirmed gap or unknown. Each non-unknown fit assessment needs an exact excerpt from a selected memory snapshot. Absence from a résumé is not evidence of a gap. Each preparation action references requirements or interview findings for that same role and includes its rationale and a completion criterion.

Interview findings record official/candidate/other source type, date or unknown, confidence, scope and matched/mismatched/unknown role, location and level. An explicitly mismatched or unknown dimension cannot be submitted as exact-role interview evidence. Employer-general guidance must be official and cannot alone make the selected role's process `supported`. Candidate reports cannot be labelled high-confidence official confirmation. Unknown or other-role evidence alone cannot justify minimum preparation. No findings is a valid outcome; `not_found` requires a recorded search attempt. Marking an assessment complete also requires a search attempt, matched identity and sourced requirements.

Web quotes must occur in owner-scoped sources actually read by the child. Saved-description quotes must belong to the exact assigned role. Reports must cover the batch exactly once; preparation/requirement/finding IDs and references are checked. These checks validate recorded support and declared consistency. They do not independently infer whether a source is official, whether the stated geography matches its text, whether a quote proves a conclusion, or whether the search was sufficiently thorough. Those are model judgments, retained for review. No automated hiring score, guarantee of getting a job, or measured quality improvement is claimed.

## Persistence, synthesis and recovery

Validated full reports are stored in successful `runtime_calls` before the parent proceeds. Coverage is reconstructed from these child report records and their scope links, so a restart after child success but before the parent's aggregation event does not lose the report. A child's partial/blocked report is retained and not blindly rerun. Interrupted children without a validated report remain pending. Newly added jobs do not join an old scope; a deliberate fresh assessment starts a new snapshot. Updating earlier partial reports or changing background requires a new explicit assessment, not silent rewriting of prior evidence.

`job_alignment_read` with no job ID pages scope coverage. With a job ID it reads the full report, frozen job input and child reference in 8,000-character pages. Compact coordinator results keep source transcripts out of its conversation; full findings remain retrievable. The coordinator should combine overlapping preparation across roles with their originating requirement/evidence links and check existing preparation before saving duplicates. This synthesis is model-guided, not an automatic semantic deduplication algorithm.

Assessment persistence does not by itself update the preparation tables or Sheets. The main agent uses existing authorized tools when those updates are requested. A returned `reported` count means reports were collected, not that every fact was confirmed or every role was a good fit. Complete/partial/blocked/pending counts remain separate.

## Observability

Existing parent/child model, tool, usage and cancellation traces are retained. New private records:

- `job_alignment.scope`: exact target/background snapshot, task ID, creation time, skill version/text/hash.
- `research.child_started.profile`: alignment scope and skill version/hash linking each internal batch.
- `research.model_input`: normalized child input and tools, including retrieved full snapshots when used.
- Successful `job_alignment_report` runtime calls: authoritative report records for recovery.
- `job_alignment.reported` and `job_alignment.interrupted`: parent aggregation and interruption metadata.

Inspect an owner-scoped scope event, join child-start profile scope IDs, then inspect the associated calls/events/provider charges. Do not sum inclusive parent counters and child counters. The existing cloud diagnostics expose bounded run metadata; full private export and Python analysis remain follow-ups. Snapshots contain personal information and inherit existing private Postgres retention; they are not anonymized. Never commit them or put their contents in CI logs. Skill/source content cannot grant execution permissions.

## Checks and rollout

Focused mocked tests cover all-saved and selected scopes, additions between batches, cross-owner denial, full snapshot retrieval, source/background validation, country/role applicability declarations, unsupported confidence/fit upgrades, and recovery when parent aggregation was lost. Generic research tests continue to cover inherited cancellation, budgets, restricted tools and charge attribution. Full checks, build, format and an independent Astra review are required before merge, followed by the normal main deployment/health verification. There is no database migration or reset. Real-user source applicability and preparation quality must still be observed during normal use; no paid benchmark is part of routine CI.

## Persistent preparation chain — v0.3.10

Every new unknown requirement includes `fit.question`, and every preparation action requires a same-role requirement link. `prep_task_save` accepts references to stored alignment actions and resolves their source/background chain server-side, preserving original checks across shared tasks. Reads are bounded and owner-scoped; Sheets mirrors the chain. Existing scopes/reports remain immutable and are not automatically reprocessed. See [preparation tools](preparation.md), [rollout](preparation-rollout.md) and [iteration record](journey/21-preparation-chain.md).
