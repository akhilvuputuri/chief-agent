# Bounded research delegation

Issue #27 phase 1. The main agent acts as coordinator and can call `research_delegate`. This reuses the same TypeScript loop and configured model with an isolated prompt, not a new service or framework. Simple requests can stay direct. Only one specialist executes at a time; recursive delegation is rejected. No model-selection changes or dollar caps.

## Assignment and authority

An assignment contains an objective, explicitly selected background, up to six combined saved job IDs/public URLs, or a general topic. Saved jobs are resolved under the authenticated owner's identity before starting the child. The specialist gets these exact targets, a short description, and no conversation history, general memory list, email, calendar or attachments. Context selection is explicit and model-chosen; it is not an automatic privacy classifier.

The child can use only `web_search`, `web_read`, `source_read`, `research_report` and `finish_turn`. The dispatcher independently checks the live child/parent relationship, authenticated owner and cancellation. Neither model arguments nor a prompt can grant extra authority. Shared authoritative memory and job records remain managed by the parent using existing tools and approval boundaries. A child cannot save its own competing version of user facts.

The report must cover exactly the assigned target IDs once. A complete target requires evidence. Each evidence quotation must occur in an owner-scoped source actually read by this child. This verifies recorded source access and quoted text, not the relevance of a page or correctness of the conclusion. Partial and blocked targets remain explicit. The parent receives the compact report; full source observations remain in the child's records. There is no bot-detection bypass or authenticated browser in this phase.

## Execution and recovery

Each child is a normal persisted `runtime_runs` row with a `research.child_started` event linking its parent. Local limits are two minutes, eight model calls and twenty tool calls, additionally bounded by the parent's remaining allocation. Parent model/tool counters include child consumption. Parent elapsed time includes the delegation interval once. Do not sum parent and child counters to estimate total execution. Provider charges belong to the run making the request and can be summed once; missing actual costs remain unknown. The parent's usage summary includes linked children.

Cancellation propagates to the child model request and prevents later dispatch. An already-running research read may finish and be recorded. No automatic retry of an entire delegation; transient model/read retries stay bounded within the shared allocation. Startup recovery interrupts delegated reads and pauses work rather than replaying a whole specialist. Child task IDs remain unset to prevent recovery from treating a child checkpoint as the main task; work-turn task identity is copied for source-cache reuse. Resumption can start fresh research against saved observations, not resume the child loop automatically.

## Trace inspection

Both local and cloud tasks can use the existing `production-diagnostics` workflow for bounded metadata. Its `research` field contains up to 100 parent/child links from the last seven days, counters and stop reasons. The root-owned `scripts/cloud-release.py` handler must be installed by an operator when that script changes; deploying application code alone does not update it. Metadata is insufficient for a semantic review.

Private Postgres records provide the detailed evidence:

- `research.child_started`: version 1 assignment, exact targets, parent ID and limits.
- `research.model_input`: version 1 normalized messages/tools/reasoning supplied to each child model invocation. No hidden chain-of-thought is requested or logged.
- `model.started/completed/failed`: invocation ID, latency, model/provider and available usage. `tool.linked` joins that invocation to its `runtime_calls` observation ID.
- `runtime_calls`: tool arguments, states and full results; `research.completed/failed`: parent-side outcome. `runtime_runs.messages`: persisted conversation checkpoint.
- `provider_charges`: direct request costs, estimates and unknown actuals. Root counters are inclusive; charge rows are not duplicated.

Start from an owner-scoped parent ID, select child IDs using `events WHERE user_id=$1 AND type='research.child_started' AND data->>'parentRunId'=$2`, then read events, calls and charges for those IDs with the same owner filter, ordered by timestamp. Date filtering on child-start events supports a weekly sample. Never paste raw assignments, source text or model inputs into GitHub Actions logs, issues or committed fixtures. Events use best-effort secret-pattern redaction, not guaranteed anonymization; all detailed records remain private. Raw tool/history storage retains existing private-data behavior. No automated retention policy was added.

A private cloud export, Python weekly analyzer, release-to-trace attribution and aggregate quality dashboard are not implemented here. They remain follow-up work in #28. This phase records the evidence those tools can consume; do not describe metadata diagnostics as full cloud access to private prompts.

## Verification and next steps

`tests/research.test.ts` exercises isolated prompts, direct conversations, foreign target rejection, denied writes/recursive delegation, target-set/quotation validation, shared allocations, cancellation, restart and charge accounting with mocked models and PGlite. No paid quality or cost improvement claim follows from those tests. Try a small user-requested research assignment after release before a large batch. Later phases can introduce a media specialist and model-specific routing using the same permission/trace boundaries.
