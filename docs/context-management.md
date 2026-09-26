# Bounded context management — issue #77

Status: **proposed**, not implemented. The v0.3.22 increase to a 400,000-character internal ceiling is temporary headroom, not a provider-token budget or a bounded-context design. [Issue #77](https://github.com/akhilvuputuri/chief-agent/issues/77) tracks implementation; [journal 28](journey/28-context-wire-compaction.md) contains the measured incidents.

## Why the current projection fails

`context.ts` retains the entire preceding exchange and all complete tool-call/result groups from the current turn. It can shorten recoverable result bodies but has no bound on the number of retained groups, assistant arguments, or unreferenced results. `history.ts` also protects the preceding exchange during reload. The 48,000-character soft allowance only removes optional older history. It does not constrain the fixed instructions/state/tool schemas or those protected groups.

On 22 September a mailbox run failed **before** the model request after 21 tool calls: fixed input 67,736 characters, earlier current-turn work 43,291, preceding exchange 961 and latest group 15,070 exceeded the former 120,000-character guard. A continuation failed with a 36,526-character preceding exchange. A representative local inventory had 62 tool schemas occupying 33,815 characters. These measurements identify application growth; they do not prove provider context exhaustion or a particular semantic mistake. The 400,000-character ceiling delays the same failure and may permit larger, costlier prompts.

## Stage 1 measurements — 26 September 2026

- **Offline inventory** (`npm run context:inventory`, repository definitions only, every integration enabled):
  - 70 tool schemas take **38,480 characters**. The largest domains are canvas (4 tools, 8,135), work (7, 3,672), job (8, 3,402), preparation (5, 2,908) and parcel (3, 2,798). `canvas_update` and `canvas_create` are about 3,700 each.
  - The core instructions are 13,463 characters, and the base runtime state 2,544. `TOOL_DESCRIPTION` in `protocol.ts` (3,587 characters) is imported but never sent.
- **Production, sizes only.** An operator read the stored `context.over_budget` and `context.selected` events for 26 September (20 model attempts; numbers only).
  - The fixed envelope was 72,159–73,678 characters, against the 48,000-character history allowance. That figure includes the 2,000-character reserve and the `finish_turn` schema.
  - 19 of the 20 selections omitted older history.
  - Memories, measured separately as total key and value length in the database, were 2,463 characters.
  - Hypothesis, not yet measured: most of the remaining difference from the offline figures is owner runtime state, the conversation summary and the current message. This assumes production offers the same tools as the all-enabled inventory. The per-call split below settles it.
- **Tool use over 30 days** (93 runs, about 580 journaled calls): about 40 of the 70 offered tools were called. Most used were `web_search` (124), `job_analyze` (71), `web_read` (50), `job_alignment_input` (42), `finish_turn` (39) and `conversation_search` (34). Canvas tools were called **zero** times, yet their schemas are sent on every call.
- **Instrumentation:** `context.selected` (one per model attempt) now records the fixed-envelope parts (instructions, memories, runtime context, tool schemas with count, summary, message). The sanitized operational log projects them as numbers only (see [operational logs](operational-logs.md)), so stage 2 can be compared per call with `npm run logs:cloudwatch -- event --event context.selected`.

These are character counts, not provider tokens. Provider-reported token and cache usage stays in `model.completed`.

## Implementation plan

1. **Baseline and replay.** Create sanitized fixtures shaped like the 21-call mailbox run, a large previous exchange, two-account source selection, a topic switch while a background job runs, and the exact selected job-role scope. Record prompt components, actual provider usage when available, cache reads, latency, cost and stop reason. Never commit private prompt text.
2. **Relevant tool loading.** Keep a compact core of finish, task-state, source-reading and capability-discovery tools. Offer domain schemas selected from current input and task state, then allow explicit discovery of others during the run. The authenticated owner-scoped dispatcher remains authoritative; absence or presence in a model prompt never grants permission. Evaluate added discovery turns against reduced fixed input and cache effects.
3. **Bounded working projection.** At valid completed tool-group boundaries, replace older model-facing groups with a versioned checkpoint. Host-owned fields retain current intent, exact target IDs/account, active task/scope, completed operations, pending approvals, uncertain writes, and observation/source references. A model-authored progress note can summarize interpretation but cannot override those fields. Keep the newest relevant user exchange and live call/result group. Originals remain in Postgres and are read back by ID when detail matters. The checkpoint is a projection, not a second authoritative history.
4. **Token-aware admission.** Budget the whole request, including tool schemas and a useful output reserve, against a conservative capacity for eligible provider endpoints. Calibrate estimates with returned token usage; character and byte counts are not token counts. If necessary, repack older projections at a valid boundary once and retry the model request. If required context still cannot fit, pause with a precise reason and a resumable checkpoint. Never replay an uncertain external write.
5. **Observe and release.** Trace projection version, trigger, component sizes/estimated tokens, tool names/count, omitted/compacted groups, source-reference counts, provider usage and stop reason without raw content. Compare before/after on the same fixtures and a small live acceptance check. Keep the internal hard guard as an emergency backstop, not the normal operating target.

Acceptance requires the reproduced long runs to answer or pause for a real dependency without an internal context overflow; retain the selected mailbox, role IDs, source provenance and approval state; keep tool-call/result groups valid; and show prompt size leveling off rather than rising with each tool call. Report actual token/cost measurements and any cache tradeoff before claiming savings. No framework rewrite, RAG layer, data reset, dollar cap or new infrastructure is required for this work.
