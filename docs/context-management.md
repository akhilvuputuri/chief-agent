# Bounded context management — issue #77

Status: stage 1 (measurement) is released. Stage 2 (relevant tool loading) is implemented on a review branch. Stages 3–4 are proposed. The v0.3.22 increase to a 400,000-character internal ceiling is temporary headroom, not a provider-token budget or a bounded-context design. [Issue #77](https://github.com/akhilvuputuri/chief-agent/issues/77) tracks implementation; [journal 28](journey/28-context-wire-compaction.md) contains the measured incidents.

## Why the current projection fails

`context.ts` retains the entire preceding exchange and all complete tool-call/result groups from the current turn. It can shorten recoverable result bodies but has no bound on the number of retained groups, assistant arguments, or unreferenced results. `history.ts` also protects the preceding exchange during reload. The 48,000-character soft allowance only removes optional older history. It does not constrain the fixed instructions/state/tool schemas or those protected groups.

On 22 September a mailbox run failed **before** the model request after 21 tool calls: fixed input 67,736 characters, earlier current-turn work 43,291, preceding exchange 961 and latest group 15,070 exceeded the former 120,000-character guard. A continuation failed with a 36,526-character preceding exchange. A representative local inventory had 62 tool schemas occupying 33,815 characters. These measurements identify application growth; they do not prove provider context exhaustion or a particular semantic mistake. The 400,000-character ceiling delays the same failure and may permit larger, costlier prompts.

## Stage 1 measurements — 26 September 2026

- **Offline inventory** (`npm run context:inventory`, repository definitions only, every integration enabled):
  - 70 tool schemas take **38,480 characters**. The largest domains are canvas (4 tools, 8,135), work (7, 3,672), job (8, 3,402), preparation (5, 2,908) and parcel (3, 2,798). `canvas_update` and `canvas_create` are about 3,700 each.
  - The core instructions are 13,463 characters, and the base runtime state 2,544. `TOOL_DESCRIPTION` in `protocol.ts` (3,587 characters) is imported but never sent.
- **Production, sizes only.** An operator read the stored `context.over_budget` and `context.selected` events for 26 September (20 model attempts; numbers only).
  - The fixed envelope was 72,159–73,678 characters, against the 48,000-character soft budget, which leaves no room for older history. That figure includes the 2,000-character reserve and the `finish_turn` schema.
  - 19 of the 20 selections omitted older history.
  - Memories, measured separately as total key and value length in the database, were 2,463 characters.
  - Hypothesis, not yet measured: most of the remaining difference from the offline figures is owner runtime state, the conversation summary and the current message. This assumes production offers the same tools as the all-enabled inventory. The per-call split below settles it.
- **Tool use over 30 days** (93 runs, about 580 journaled calls): about 40 of the 70 offered tools were called. Most used were `web_search` (124), `job_analyze` (71), `web_read` (50), `job_alignment_input` (42), `finish_turn` (39) and `conversation_search` (34). Canvas tools were called **zero** times, yet their schemas are sent on every call.
- **Instrumentation:** `context.selected` (one per model attempt) now records the fixed-envelope parts (instructions, memories, runtime context, tool schemas with count, summary, message). The sanitized operational log projects them as numbers only (see [operational logs](operational-logs.md)), so stage 2 can be compared per call with `npm run logs:cloudwatch -- event --event context.selected`.

These are character counts, not provider tokens. Provider-reported token and cache usage stays in `model.completed`.

## Stage 2 — relevant tool loading

The coordinator is offered a **core** set of tools on every call:

- conversation search and read
- observation and source read
- memory
- web search and read
- skill list and read
- work status
- `tools_load`

On top of the core, it gets the **domains** a request needs, from `src/tool-domains.ts`: gmail, calendar, daily, jobs, work, research, media, canvas, parcels, library, watchlist, routines, skills.

**How the initial domains are chosen.** Host-visible signals decide them deterministically:

- conservative word cues in the message, including attachment notes;
- a background lane or a bound task (adds work);
- pending Calendar or library approvals;
- the domains of tools the owner used in the last 60 minutes or the bound task used.

**Loading more.** The runtime state lists the other available domains with one-line summaries.

- `tools_load` adds domains for the rest of the turn.
- A follow-up absorbed mid-turn adds its own cue domains.
- If the model calls a known tool whose domain is not loaded, the host loads the domain and dispatches the call. No extra model step is needed, and arguments are still schema-validated.

**What does not change.** Unavailable integrations are neither offered nor loadable. The owner-scoped dispatcher remains the authority: offering a schema grants nothing. Specialists receive the full enabled definitions (`runtime.allTools`), so delegation does not depend on what the coordinator loaded.

Offline effect (`npm run context:inventory`, all integrations enabled, 26 September):

| First message      | Domains         | Tools | Tool-schema characters |
| ------------------ | --------------- | ----: | ---------------------: |
| Before (all tools) | all             |    71 |                 39,030 |
| Plain chat         | none            |    12 |                  4,007 |
| Email lookup       | gmail, calendar |    18 |                  6,600 |
| Calendar           | calendar        |    14 |                  4,827 |
| Job preparation    | jobs            |    25 |                 10,330 |
| Image              | media           |    13 |                  4,927 |
| Background task    | work            |    18 |                  7,317 |

These are offline character counts. Measure the production effect with `context.selected` (`toolsChars`, `fixedChars`, `omittedCount`) and `tools.selected`/`tools.loaded`. Also check provider token and cache usage in `model.completed`, because a changing tool list can reduce prompt-cache reuse. Extra discovery steps show up as `tools_load` calls in `tool.finished`.

## Stage 3 — Jev tool picker

The word cues in stage 2 missed many phrasings (stock tickers, book titles, "has the insurance company got back to me?"). Stage 3 replaces them for foreground messages with a call to TypeSafe's Jev decision model on OpenRouter (`src/tool-picker.ts`).

**How it picks.** Once per user message, Jev answers one yes/no question per available domain. It sees the latest message, the last two turns (user text, a clipped final reply and tool names, never tool outputs), pending approvals, the bound task's objective and tools used in the last hour. Domains scoring at least 0.5 are loaded, highest first, up to 3. If none reaches 0.5, the single best domain is loaded when it scores at least 0.15. A follow-up absorbed mid-turn gets its own call.

**What stays deterministic.**

- A bound task, pending Calendar or library approvals and tools used in the last hour still load their domains.
- Domains Jev picked for the owner in the last hour (`tools.picked` events, by event time) stay offered, so a conversation keeps its tools. A hold is renewed only when Jev picks the domain again; domains actually used are held through recent tool use.
- The initial domains are offered in canonical order, so the same set always produces the same tool list. Domains loaded mid-turn are appended.
- Background job steps use the stage 2 selection without Jev.
- `tools_load` and auto-loading on a direct tool call remain the escape hatch.

**Failure behaviour.** The call times out after 1.5 seconds and is never retried. On a timeout, HTTP error, partial answer or missing key, the stage 2 word cues are used instead. After a 429 the picker is skipped for 5 minutes. A 401/402/403 is logged at error level. The application setting `TOOL_PICKER=off` disables it; production Compose does not pass that variable yet, so turning it off there needs a reviewed Compose rollout or a revert.

**Long messages.** Jev sees the first 2,000 characters of a message. A longer message also keeps its word cues, and each follow-up absorbed mid-turn gets its own decision.

**Configuration and records.** `config/tool-picker.json` holds the pinned model (`typesafe/jev-1.13-20260917`), thresholds, state limits and domain descriptions. It is bundled into the image and shared with the Python eval. Each decision is recorded as a private `tools.picked` event with per-domain probabilities. The sanitized log carries only the outcome, model, domain count, latency, cost and HTTP status. Cost is recorded in the spending ledger as `openrouter-jev`; a definite HTTP rejection is settled at zero, and accounting failures never change the pick.

**Eval.** `npm run eval:picker` runs 174 synthetic labelled scenarios (101 tuning, 73 held-out) three times against the configured model and fails below 97% recall of needed domains. It is a manual, paid run (about $0.04), not a CI gate. See [evals/picker](../evals/picker/README.md) and [journal 37](journey/37-jev-tool-picker.md) for the measurements.

## Previous-exchange excerpts and the exchange index

These are compaction stages 2 and 3 of the plan in the compaction research. They are not the tool-loading stages above.

**Previous exchange.** The previous exchange keeps all its user and assistant text. Its tool results over 1,800 characters that carry an observation or source ID become head and tail excerpts that keep those IDs (`compactToolGroup`). Before this change that happened only when a request passed 120,000 characters. The projection changes only when a new owner message arrives, so it does not change the prompt prefix within a turn.

**Exchange index.** `exchangeIndex` in `src/context-continuity.ts` replaces the extractive archive of messages about 13–40 back. `conversationState` builds it from the heads of the last 400 conversation rows.

- It has one line per earlier exchange except the previous one, newest kept first within 8,000 characters.
- Each line holds how many exchanges back it is, the Singapore time, the user message ID, the heads of the owner's message and of the reply, and the tools used with their observation IDs.
- A header tells the model to read a full message with `conversation_read` and a stored result with `observation_read`, and to use `conversation_search` for older exchanges.
- It is built by code with no model call. The saved-answer-details pointer is not treated as the reply.

**Measured effect** ([journal 41](journey/41-exchange-index.md); one answer run each on the synthetic eval):

- correct answers rose from 81% to 97%;
- tool-detail answers rose from 44% to 100%;
- evidence in the prompt or one read away rose from 72% to 100%;
- eval cost per run was $1.08 before and $1.21 after.

## Bounded growth within one message

The previous two stages bound earlier exchanges. A single long task could still grow: past 120,000 characters every earlier call of the current turn became an excerpt, but each call still added about 2,600 characters, so a long enough task reached the 400,000 hard limit. This is the shape of the incident that opened issue #77.

**What happens now** (`context()` in `src/context.ts`):

- Once the fixed part, the previous exchange, the latest call group and this turn's excerpted calls reach 120,000 characters, the oldest call groups of this turn leave the prompt.
- The newest call groups that fit in what remains stay. What remains is 120,000 minus 6,000 for the digest and 4,000 for JSON escaping that the fixed-part estimate does not count.
- Only call groups leave. The owner's message, anything the owner sent during the task, text-only replies, the previous exchange and the latest group are never removed. The latest group can still be excerpted if the wire check after assembly reaches 120,000, but the margin keeps that from happening in the tested tasks.
- Groups leave in blocks of 8, so the kept part of the prompt stays the same for several calls and the provider cache keeps matching it.
- `turnDigest` in `src/context-continuity.ts` lists every call that left, one line each, oldest first: step, tool name, the start of its arguments, and its `observationId`, `receiptId`, `sourceId` or `extractionSourceId`. Failed calls are marked. The digest, including its header, keeps its newest lines within 6,000 characters and goes in the closing system message. Its header tells the model to read with `observation_read(id=…)` or `source_read(id=…)`, and to record findings before reading many results again, because older reads also leave.
- The journal and `runtime_calls` keep every original. The model reads a dropped result with `observation_read` instead of calling the tool again.
- `context.selected` records `trimmed`, and the operational log shows it as `trimmedGroups`.

**Measured on synthetic tasks** (offline `context()` counts, not provider runs: a 67,736-character fixed part as in the incident, and each call returning a projected mailbox result of about 12,000 characters. Blocks of 8 mean up to 7 more calls leave than strictly needed, which is why the 21-call task keeps only 5):

| Calls | Before: serialized characters | After: serialized characters | Calls kept in full or as excerpts |
| ----: | ----------------------------: | ---------------------------: | --------------------------------: |
|    21 |                       124,445 |                       94,326 |                                 5 |
|    40 |                       173,294 |                      103,319 |                                 8 |
|    80 |                       276,134 |                      106,520 |                                 8 |
|   160 |           failed (hard limit) |                      107,177 |                                 8 |

The 400,000 hard limit remains as a backstop. It now leaves more than 280,000 characters of room above the working size for the reply. Limits are still counted in characters, not tokens. In the incident, requests of about 117,000 characters reported about 26,000–31,000 prompt tokens, against a provider window advertised at over 900,000 tokens, so the character threshold is a cost and focus target, not a capacity limit. The provider's actual prompt tokens per call are recorded in `model.completed`.

## Implementation plan

1. **Baseline and replay.** Create sanitized fixtures shaped like the 21-call mailbox run, a large previous exchange, two-account source selection, a topic switch while a background job runs, and the exact selected job-role scope. Record prompt components, actual provider usage when available, cache reads, latency, cost and stop reason. Never commit private prompt text.
2. **Relevant tool loading.** Keep a compact core of finish, task-state, source-reading and capability-discovery tools. Offer domain schemas selected from current input and task state, then allow explicit discovery of others during the run. The authenticated owner-scoped dispatcher remains authoritative; absence or presence in a model prompt never grants permission. Evaluate added discovery turns against reduced fixed input and cache effects.
3. **Bounded working projection.** At valid completed tool-group boundaries, replace older model-facing groups with a versioned checkpoint. Host-owned fields retain current intent, exact target IDs/account, active task/scope, completed operations, pending approvals, uncertain writes, and observation/source references. A model-authored progress note can summarize interpretation but cannot override those fields. Keep the newest relevant user exchange and live call/result group. Originals remain in Postgres and are read back by ID when detail matters. The checkpoint is a projection, not a second authoritative history.
4. **Token-aware admission.** Budget the whole request, including tool schemas and a useful output reserve, against a conservative capacity for eligible provider endpoints. Calibrate estimates with returned token usage; character and byte counts are not token counts. If necessary, repack older projections at a valid boundary once and retry the model request. If required context still cannot fit, pause with a precise reason and a resumable checkpoint. Never replay an uncertain external write.
5. **Observe and release.** Trace projection version, trigger, component sizes/estimated tokens, tool names/count, omitted/compacted groups, source-reference counts, provider usage and stop reason without raw content. Compare before/after on the same fixtures and a small live acceptance check. Keep the internal hard guard as an emergency backstop, not the normal operating target.

Acceptance requires the reproduced long runs to answer or pause for a real dependency without an internal context overflow; retain the selected mailbox, role IDs, source provenance and approval state; keep tool-call/result groups valid; and show prompt size leveling off rather than rising with each tool call. Report actual token/cost measurements and any cache tradeoff before claiming savings. No framework rewrite, RAG layer, data reset, dollar cap or new infrastructure is required for this work.
