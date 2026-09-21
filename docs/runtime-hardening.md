# Durable scope and evidence in Chief

**Checkpoint status: candidate implementation on `feature/runtime-evaluations`, not deployed. Further evaluation and rollout deferred at the user’s request on 7 September 2026.** See [resume checklist](checkpoints/runtime-evaluations.md).

## Problem this change addresses

A long task can call the right tools and still answer about the wrong objects. Our incident did exactly that: the original records were retrieved, but repeated full task snapshots displaced the inventory from the model's recent context. A later synthesis substituted plausible companies. The database was not corrupted; the answer was wrong. Counting successful tool calls could not detect this.

The runtime now separates four concepts:

1. **User request:** the authenticated instruction stored in the work turn and task revision history.
2. **Target scope:** exact record identities copied from an owner-scoped, successful collection observation.
3. **Findings:** agent-authored outcomes saved individually against those targets and their captured content hashes.
4. **Execution evidence:** observations, source quotes and receipts proving what was retrieved or executed.

None of these alone proves that an interpretation is true. Their combination makes missing coverage and identity drift visible and enforceable without dictating Telegram prose.

## Request lifecycle

```mermaid
sequenceDiagram
    participant U as Telegram user
    participant A as TypeScript assistant
    participant M as OpenRouter model
    participant P as Postgres
    U->>A: Request
    A->>P: Load explicit memory and current task
    loop Within persisted execution budget
      A->>P: Refresh scope, findings and checkpoint
      A->>M: Instructions + current state + bounded recent history
      M->>A: Tool calls / progress
      A->>P: Journal invocation before dispatch
      A->>A: Validate owner and arguments; dispatch sequentially
      A->>P: Persist complete result before next model call
      A->>M: Compact observation with retrieval pointer
    end
    M->>A: finish_turn with reply and target IDs
    A->>P: Check declared target coverage and saved outcomes
    A->>U: Model-written reply
```

Model settings remain Sol through OpenRouter, medium reasoning, price-first routing with input/output ceilings. Search and speech remain separate existing providers. No framework, shell, new server, delegation or authenticated browser capability is introduced.

## Observation storage and context

`runtime_calls` retains full tool results. `projectObservation` gives the model a smaller representation. Work updates omit accumulated receipts and evidence; role previews shorten large descriptions. Source identifiers and retrieval pointers remain available when content is shortened. `observation_read` retrieves an 8,000-character page from a successful call belonging to the authenticated owner. A page is not itself a new source or target assessment.

These identifiers have different meanings:

| Identifier      | Meaning                          | Used by                                               |
| --------------- | -------------------------------- | ----------------------------------------------------- |
| `observationId` | Persisted tool invocation/result | `observation_read`, scope binding and finding support |
| `sourceId`      | Retrieved research source        | `work_evidence`                                       |
| `receiptId`     | Successful operation receipt     | Step execution proofs                                 |
| target `id`     | Saved domain record              | Scope membership and findings                         |

The system refreshes current task context before every model request. It supplies the captured scope plus saved findings separately from history, so repeated bookkeeping cannot evict the authoritative target list. Up to 50 targets and shortened findings are included directly; `work_scope_read` paginates larger sets in pages of 25. Original observations remain retrievable. The total character allowance reserves space for instructions, memories, tools, current state and the latest request before selecting history. Recent history keeps complete tool-call/result groups and records omissions. This is a character budget, not an exact token budget.

The old recency-only history probe remains as a diagnostic: it can still fail because raw history selection has not become a semantic retriever. The new protection comes from durable state outside that history.

## Scope and findings

Migration `007_task_scope.sql` adds tables without changing existing roles, memories, approvals, schedules or assessments:

- `task_scopes`: one captured target set per task, owner, source observation, revision, binding run and previous target versions.
- `task_findings`: current outcome per task/target, captured hash, summary, complete/blocked status and supporting observation IDs.

`work_scope` accepts only target IDs actually present in a successful `job_list` or `item_list` result belonging to the owner. It does not accept model-authored titles as identity. Membership cannot change again in the same user turn or from a background continuation. A later user turn can revise membership. Previous scope revisions remain stored. Findings for unchanged hashes can be reused; omitted targets do not appear in the active scope view.

`work_finding` requires an in-scope target. Each supporting observation must belong to the owner and identify that target directly or via its exact captured URL. A complete finding requires at least one matching observation. A blocked finding records the reason without pretending to have source evidence. These checks establish recorded support, not semantic correctness. For example, a role read can support identity but cannot establish that the user has customer deployment experience.

`finish_turn` accepts explicit target IDs. Collection completion checks reject outsiders, omitted scoped targets and targets without recorded outcomes. Blocked outcomes count as accounted for, not successfully researched; the model must describe the limitation. Natural reply content is not parsed into a forced visual template.

## Completion and repair

Read operations can prove a retrieval step when the step explicitly names that operation. They cannot prove a write. Matched source quotes remain necessary for evidence steps; write/export steps require their actual operation receipt. Within the same recorded user instruction, plan revision cannot remove a requirement or weaken its verification type to get past an error.

Known pre-mutation rejections use `ValidationError` and produce actionable validation feedback. Unknown failures after dispatch of a write remain uncertain and pause execution for inspection. Reads may be retried under the existing transient-error limit; writes are never blindly replayed. Three identical operation/argument/error failures stop the repair loop. This is an exact-repeat guard, not a complete detector of all equivalent unsuccessful strategies.

Execution traces include context character counts and omitted messages alongside existing model/provider, latency, usage, stop reason and tool outcome records. Missing cost remains unknown.

## Security and recovery boundaries

Owner identity is supplied by the authenticated session, not by tool arguments. Scope reads, observation reads and finding support are owner-scoped. Existing Gmail/Calendar read-only behavior and approval gates stay in place. Evaluation runs create their own synthetic database and cannot write to production integrations.

Scope and findings survive process restarts. Existing conservative recovery pauses interrupted tasks and uncertain writes. No background restart should silently reset completed work or grant a new budget. Deployment must preserve the incident archive and exclude known invalid synthesis from future context; it must not wipe saved records to hide the defect. See the rollout checklist below before applying to a live server.

## Known limitations

- The initial subset is still interpreted by the model. Membership validation rejects invented IDs but does not prove that an initial subset matches every word of a natural-language request. Explicit request-to-scope contracts are a later strengthening.
- A later user turn authorizes the opportunity to revise scope; the host does not semantically prove that the turn requested the exact revision.
- Final target IDs are a structured declaration. They do not prove every sentence in the natural reply refers to those targets. Semantic review/evaluation remains necessary.
- Exact URL matching is deliberately conservative; legitimate redirected postings may need an explicit identity resolution mechanism.
- Scope hashes capture the selected observation. Rebinding identical IDs currently preserves that snapshot; it does not automatically refresh changed domain records.
- Findings are current per-target checkpoints, not a complete append-only history of every draft.
- The first collection adapters are jobs and general items. Other domains need explicit trusted list adapters.
- This small eval suite is a development instrument, not a reliability benchmark or proof of broad assistant quality.

## Rollout checklist

1. Run type checking, regression tests and matched synthetic evals; inspect failed traces and sample explanations.
2. Do not deploy a candidate that cannot finish the primary collection case within the agreed budget without understanding the failure.
3. Record exact source revision and evaluation settings. Review diff and CI before merging.
4. Inspect live active tasks and pause execution during cutover; preserve all domain data and completed work.
5. Archive known invalid conversation/task synthesis and isolate operator test prompts. Keep original incident traces for audit; never replay them as new work.
6. Apply additive migration, rebuild the existing app, check health and exercise an isolated smoke scenario. Do not seed production chat with benchmark instructions.
7. Explicitly resume real user work only when appropriate, using preserved checkpoints. Record deployed revision, checks and any unresolved limitations in the handover.
