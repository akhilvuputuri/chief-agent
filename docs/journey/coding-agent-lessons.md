# Coding-agent engineering: changes, failures and evidence

Updated: 8 October 2026. Baseline: integrated main `135e9898db15a19dc602ba04d03e42e970b174cf`, containing the verified v0.3.51 activation. This is a cumulative learning guide; dated journal entries retain detailed incident, review and release evidence. A healthy release does not by itself establish better coding quality.

## How to read the evidence

For each change, ask what failed, why that mechanism was suspected, what changed, which failure it actually prevented, and what would demonstrate improved engineering outcomes. Keep failed approaches and review corrections; a history containing only successful releases hides useful lessons.

- **Observed:** production metadata or CI results, with workload/window and limitations.
- **Reproduced:** a synthetic failure and correction exercised independently; proof of that mechanism, not model quality.
- **Deployed:** exact release receipt plus the stated configuration/health verification.
- **Unmeasured:** real-task success, quality, efficiency or cost impact without a comparable trial.

## The connected journey

| Iteration                                                                             | Change and engineering lesson                                                                                                                                                                                                    | Evidence boundary                                                                                                   |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [56 — Remote work](56-coding-runtime.md) → [57 — Python](57-python-coding-runtime.md) | Chief owns durable dispatch/auth/publication; the separately packaged worker owns disposable repository execution. Language/process separation makes lifecycle and credential boundaries explicit.                               | Architecture/isolation tests and releases; no evidence that the language change improves reasoning.                 |
| [58 — Requirements](58-coding-requirements.md)                                        | Bind owner confirmation to the delivered complete brief, owner, scope and revision. A model assertion is not authorization.                                                                                                      | Approval/delivery/fencing tests and release evidence.                                                               |
| [61 — Fixed squad](61-coding-squad.md)                                                | Separate leader/coder/reviewer contexts; deterministic checks and exact candidate identity. Review exposed swallowed checkpoint failures and stale finishes that could rewind acknowledged state.                                | Independent reproductions; three members outperforming one remains unmeasured.                                      |
| [64 — MR automation](64-coding-automation.md)                                         | Bind review evidence to the published tree/head and handle readable CI/MR feedback. An old approval cannot authorize changed code.                                                                                               | Mechanism/release validation; general reviewer accuracy unmeasured.                                                 |
| [66 — Benchmarks](66-coding-benchmarks.md)                                            | Freeze tasks and grade independently of the agent workspace; keep invalid predictions, timeouts and infrastructure failures visible.                                                                                             | Six component fixtures/four public selections; live inference and real model scores pending.                        |
| [68 — Continuation](68-coding-tool-index.md)                                          | Optional provider `index` metadata broke the next strict host request. Accept the known field without weakening unrelated validation or altering reasoning. Diagnose the failing boundary before blaming the model or sandbox.   | Indexed continuation reproduced as HTTP 409 before correction and 200 after; full live completion not established.  |
| [70 — Allocations](70-coding-allocations.md)                                          | Expand compatible capacity and expose the remainder. More allowance permits work but does not make it productive.                                                                                                                | New defaults deployed; a later attempt exceeded forty calls and still failed. No matched quality comparison.        |
| [71 — Progress/recovery](71-coding-progress-recovery.md)                              | Persist member notes/evidence during inspection, summarize before trimming, add targeted navigation and loop recovery, admit complete model responses, expose useful status. Observations stay separate from approval authority. | Six mechanisms deployed in v0.3.51; 992 tests/image/health proofs. Real-provider completion improvement unmeasured. |

## What the incidents taught

### Capacity and useful progress are different

On 8 October, one resumed DeepSeek V4.1 Flash planner completed forty calls without a plan. A later fresh attempt admitted 139 calls over approximately 24 minutes: 138 complete and one uncertain. It still produced no acknowledged plan or changed file. These were different attempts, not a controlled before/after experiment. More admitted calls do not prove efficiency or quality gains.

The forty-call attempt reported USD 0.0210415264 model usage plus USD 0.03 estimated compute: approximately USD 0.051 combined. This was a read-heavy, cache-using workload, not an invoice or a forecast for coding/reviewer work. Chief chat, fixed hosting, credits, tax and ancillary charges were excluded. [Journal 70](70-coding-allocations.md#evidence-and-cost-scope) records the date, token/cache counts and pricing basis.

**Lesson:** support task duration, retain useful work and classify stopping reasons. Low observed cost is not evidence that extending an unproductive loop will complete it.

### Reading information is not retaining it

The later attempt made 237 reads across 58 files. It repeated 114 path/offset pairs after each previous result ID had left the request. Page sizes varied, so these were not necessarily identical complete ranges. This supports the context-loss hypothesis but does not prove every repeat was unnecessary or caused solely by trimming.

The old implementation deleted old groups without preserving findings. Planning checkpointed at initialization/completion, leaving a stored zero tool count despite activity. V2 saves working state during inspection and acknowledges a replacement notebook before removing older groups.

**Lesson:** externalize subtask, evidence references, unresolved questions and next action. A heartbeat, acknowledged progress and verified completion are three different signals.

### Tool ergonomics matter

The earlier leader could list paths with `rg --files`; that is not content search. Missing files yielded opaque errors. The later incident recorded 24 file-read errors. Grep/glob, clear character-versus-line cursors, fingerprints and actionable errors address those observed interface gaps. Their success-rate or cost impact still needs comparable trials.

**Lesson:** inspect actual schemas/results before adding retrieval infrastructure. Having a reader does not establish effective navigation or useful feedback.

### Recovery is a side-effect decision

A failed generation may have executed no tool; a failed command/write may already have had an effect. V2 permits one fresh generation after recognized transient model failures, while uncertain commands/writes are not blindly replayed. Working notes cannot change the approved plan, mark checks passed or substitute for review. Failed/lost generation cost can remain unrecorded after partial output; unknown accounting is not zero.

**Lesson:** save acknowledged state, classify failure and retain scope/cancellation boundaries; do not retry every exception indiscriminately.

## What independent review demonstrably prevented

These are reproduced safety improvements, not inferred coding-quality gains. [Journal 71](71-coding-progress-recovery.md#implementation-and-review)/[PR #190](https://github.com/akhilvuputuri/chief-agent/pull/190) retain rejected revisions, fixes and exact approvals.

| Failure reproduced                                                            | Correction and supported conclusion                                                                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| An output-limit stream exposed a valid first write and malformed second call. | Reject incomplete terminal reasons/malformed wire batches before actions; the regression executes neither write.                                 |
| A nudge made a newest 90 KB opaque reasoning/tool group removable.            | Protect the latest assistant group independently of hints; retain within the hard envelope or pause. The tested group survives.                  |
| SSE authentication errors entered transient recovery.                         | Consistent HTTP/transient classification; tested authentication/request failures receive no fresh-generation recovery.                           |
| Reset plus ordinary compaction summarized twice with one tool remaining.      | Admission checks and one summary per recovery pass; the regression saves once, reaches zero and reports exhaustion without an excess checkpoint. |
| Hosted navigation tests lacked ripgrep.                                       | Declare CI/manual-check and portable prerequisites; the corrected hosted workflow installs the dependency and passes.                            |

**Lesson:** happy-path tests did not expose these boundaries. Independent counterexamples changed the implementation before release.

## 8 October — finishing is different from delivering a useful result

After the v2 progress/recovery release, one real planning job reached `plan_ready` in about 5 minutes 23 seconds using 44 host model calls. Its 1,854-word approval plan rendered as five Telegram messages. This establishes a completed planning result on that configuration, not a comparative completion-rate gain or a completed coding/review/PR job.

**Hypothesis/intervention:** the report contract conflated an internal engineering audit with owner-approved scope. Python 0.1.6 guides a concise complete brief, rejects oversized new proposals with revision feedback, and keeps detailed working evidence outside approval authority. Chief avoids repeating the summary. Synthetic tests preserve findings, count Unicode correctly and deliver legacy long scopes completely; independent implementation review approved, with a non-blocking journal-table issue corrected; final foundation review/CI passed and the Python 0.1.6 image was independently verified; v0.3.53 activation/exact release/current health passed; real-provider brevity/scope completeness and full coding acceptance remain unmeasured. See [journal 72](72-coding-approval-brief.md).

**Lesson/next falsifying test:** successful execution can still yield an unusable product result. Test a fresh real plan for concise presentation and complete scope, then an actual coder/reviewer/PR trajectory. A shorter plan that drops requirements is a failure, even if it fits the boundary. No measured quality, cost or latency improvement is claimed from this change.

## 9 October — compare the economics of the squad, not just model prices

[Research and proposed comparisons](../coding-model-efficiency.md), recorded in [journal 73](73-coding-model-efficiency.md), identify grounded edit/test feedback, focused handoffs, context strategies and stronger review as candidates. Published benefits depend on model, task, extra inference and sometimes selected nonempty patch pools; they do not establish a cheap-model advantage for Chief. Compare cheap solo, stronger solo, coder/reviewer and the full squad with common requirements and independently graded outcomes. Include failed attempts, review/rework/compute cost and reviewer mistakes. The inference adapter and live comparisons remain unimplemented/unrun; no production policy or allocation change follows from the research.

## 9 October — recovery classifications must survive every boundary

A v0.3.53 plan paused after 34 completed calls and one uncertain generation. Provider metadata is consistent with a normal terminal response containing only reasoning; the original discarded wire is unavailable. Independently, the adapter-to-gateway path demonstrably turns a transient empty-answer error into a non-recoverable generic provider failure. [Journal 74](74-coding-provider-recovery.md) tracks a fixed subtype, existing bounded fresh-generation recovery and replay/permission safeguards. Independent review reproduced malformed content masquerading as empty; strict known-field admission and boundary regressions correct that counterexample. Synthetic reproduction supports the mechanism; updated review/exact release and owner-authorized live concise-plan/retained-understanding trials remain pending. A healthy container or a short proposal alone is not that acceptance result.

## 9 October — live validation exposed a second stopping boundary

After the v0.3.54 provider recovery release, the first owner-authorized real planning trial failed with 33 completed calls: a correct-shaped summary exceeded its 6,000-unit findings bound by 511 units. Prior notes survived but no owner brief was produced. [Journal 75](75-coding-summary-repair.md) proposes one constrained correction and no truncation, with allocation, wire and acknowledgement guards. Synthetic tests retain old history/notes on repeated invalid output and deny repair without continuation headroom. Activation and actual concise-plan/task-understanding acceptance remain pending; this failed trial is not removed from the record or relabelled a success.

## 9 October — independent failure kinds need separate bounded opportunities

The scoped Python 0.1.7 trial produced a 420-word plan, survived two compactions and recovered a real empty provider answer. Presentation and final-notebook quality remained short of acceptance. A feedback-conditioned second trial failed when an empty summary generation consumed the same retry allowance needed to correct a subsequently oversized 6,055-unit summary. [Journal 75](75-coding-summary-repair.md) records both outcomes. Python 0.1.8 proposes one provider recovery plus one validation correction, bounded to three summary generations with unchanged allocation/acknowledgement guards. This is a measured failure mechanism and tested proposal, not established production reliability; new image and live acceptance remain pending.

## What has not yet been shown to help

The record does not establish that the squad beats one agent, summaries retain every important fact, v2 completes more real tasks, the latency profile is optimal, or RAG improves this workload. The 992-test suite checks contracts/failure behavior; image/startup checks validate installation and configuration.

Known information had already been retrieved and then omitted, making retention/navigation the first justified intervention. Repository maps, semantic retrieval, model/effort changes and different team topology remain hypotheses to compare, not established fixes or permanently rejected approaches.

## How future changes enter the record

Append a dated case here in the same PR as meaningful coding-harness changes, linking the detailed journal. Include:

1. **Trigger/result:** sanitized failure and expected outcome.
2. **Baseline:** exact source/image, workload, models, effort, allocation and relevant tool/context settings.
3. **Observation:** dates, units, denominators and what tests/ledger establish.
4. **Hypothesis:** mechanism and credible alternatives.
5. **Intervention:** behavior changed and its rationale.
6. **Counterexample/review:** what broke the first approach and the correction.
7. **Outcome:** reproduced behavior or real-task result, cost/latency/accounting limits and unresolved failures.
8. **Release/next test:** exact approval/deployment evidence or pending boundary; the smallest experiment that could falsify the benefit.

Keep negative/mixed results. Do not relabel implementation as demonstrated benefit after deployment.

For comparisons, follow [the benchmark contract](../../evals/coding/README.md): freeze workloads, vary one factor, hold models fixed for harness trials and harness fixed for model trials, retain infrastructure failures and grade independently. Add a realistic planning/navigation case to the small repair pack. Measure completion, time to first durable finding, repeated unchanged evidence, summary recall, recovery outcomes, actual usage and reviewer false approvals/rejections. A few initial repeated trials are diagnostic, not statistical proof. Paid trials need separate authorization; this record does not start or schedule them.

Raw traces, conversations, private source excerpts, credentials and personal motivations stay out of this public record. Use bounded aggregates and anonymized regressions.

### 9 October: completion did not establish plan correctness

Python 0.1.8 completed one real planning trial with a concise delivered brief and finalized notes (33 model calls, 58 tools, two compactions). Root inspection still found a silent checklist cap and an incorrect plugin-inventory conclusion. These are semantic counterexamples to equating `plan_ready`, field bounds, saved notes or startup health with understanding. The next test uses the legitimate planning-feedback revision to verify full-list/overflow behavior, actual agent inventory and agreement between complete approval scope and concrete handoff; no records or stored plan are manually rewritten. This is an adaptive incident test, not evidence of general quality or cost improvement. See [journal 75](75-coding-summary-repair.md).

The next corrective revision still paused: one provider empty recovered, but a whole-notebook correction returned an oversized `nextAction` (1,163 versus 1,000 UTF-16 units). More permissive limits or silently truncating evidence would conceal the failure. Python 0.1.9 narrows field-local repair to the invalid fields and preserves valid fields byte-exact, with writing headroom; a regression verifies valid scope/evidence retention and rejects attempts to overwrite them. Live model compliance remains a hypothesis until the new worker is tested. The proposed 0.1.8 activation was withdrawn, preserving the negative result.

The real 0.1.9 scoped run recovered three empty summary responses and acknowledged seven bounded summaries; no targeted-repair generation was needed, so that mechanism remains regression-proven rather than live-exercised. Independent grading still rejected its first final handoff for source mistakes and missing contracts. A legitimate feedback revision produced a complete 309-word plan and reconciled implementation handoff that Astra accepted. This demonstrates a guided incident outcome, not autonomous first-pass quality or universal reliability. Preserve the failed first proposal, explicit feedback dependency and implementation-approval boundary when reporting it.

The independently verified 0.1.9 default pin shipped as v0.3.58 with exact review, 1005-test checks, release receipt and separate current health/configuration verification. This closes the harness activation, not the planned to-do feature. Its implementation, real checks and coder/reviewer loop still require owner confirmation and future execution. The next falsifying test is an authorized coding task rather than another duplicate planning run.

## 9 October — prefer a standalone runtime contract over compatibility by default

[Pi exploration](76-pi-harness-exploration.md) began from the owner-reported maintenance burden of custom coding basics. The owner explicitly permits replacing Python and changing Chief's adapter, with repository independence required. Therefore the proposed intervention is a standalone Pi SDK package and small workflow, not a Pi wrapper around the old squad/gateway/checkpoint schema. Chief is a client.

The published 1.1.0 SDK probe passed seven synthetic assertions with zero external model calls. It exposed three concrete integration facts: Node 22.15.0 is below the declared minimum; the direct edit API uses an edits array; and cwd does not confine file access. Explicit tool/resource configuration and an actual execution boundary remain necessary. No independent review or real-model benefit is claimed. Retain those negative observations rather than equating an SDK dependency with a complete product.

Next falsifying tests: copy the package outside Chief and run it; then complete a fixed small task with correct approved scope, durable findings and actual checks under the same model/allocations. Measure semantic correctness and accepted patches before claiming maintenance, quality or cost gains. A production switch and publication authority remain separate.

The follow-up [implementation/cutover plan](../pi-coding-runtime-plan.md) makes coexistence explicit: leave the Python runtime intact, adapt Chief to the independent task contract, and change only new-task routing after acceptance. Stopping legacy dispatch cannot disable status, cancellation or cleanup for existing jobs. A rollback is a routing change, not a transcript migration. This preserves operational recovery without making Python internals part of the new runtime.

## 9 October — verify the execution boundary around a dependency

[Journal 77](77-pi-runtime.md) implements Pi as the inner engine of an independent package. Synthetic fixtures prove actual tool edits and check execution, not semantic task quality. Native protocol continuation preserved reasoning metadata and Unicode. The integration retains the host's exact owner approval/model policy and keeps Pi draft-only.

Counterexamples required canonical path checks, private metadata signatures, serialized decisions, explicit interruption/cancellation handling, indexed UTF-8 identity and guarded Git operations: Git filters can execute source code during artifact capture too. Reusing a mature tool implementation does not remove these boundaries. The old Python code/images/jobs remain intact; only new-job routing changes after acceptance. Linux CI and independent review are pending; no completion-rate, cost or live quality benefit is claimed.

The first independent Pi review found three mechanical failures despite green local fixtures: cwd-filtered recovery dropped history, the standalone CLI discarded cleanup wiring, and SIGKILL restored uncharged time. Explicit session reopening, exact active-file persistence, default cleanup installation and saved time reservation fixed the executable counterexamples; Astra approved the updated head. Linux CI tested the actual guarded CLI, not just its helper. Source/image identity was independently verified across 14 compiled files. These prove mechanism/installation boundaries; real-model acceptance and economic gains remain unmeasured.

The reviewed Pi foundation and verified image pin shipped as v0.3.59/v0.3.60 with exact release receipts and separate gateway-start observations. This establishes build/integration/installation, not accepted real-model changes or a quality/cost advantage. Default remains legacy until separately authorized acceptance and a reviewed new-task cutover.

The owner-authorized Pi default candidate preserves per-job snapshots and request-key identity. Its falsifying case is a delayed duplicate of a legacy request after cutover: it must return the old job, not create a Pi replacement. The synthetic regression also checks cancellation and future-only rollback. Default activation is an operational choice, not real-model quality acceptance; a first normal owner task remains unmeasured.

The owner-authorized default shipped as v0.3.61 with exact receipt and separate running-SHA/healthy-host observations. Independent counterexamples verified queued legacy launch, uncertain-create reconciliation without relaunch, ownership and request-key handling across cutover. These demonstrate routing/recovery and deployment, not real-model task acceptance or a quality/cost benefit.
