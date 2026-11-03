# 151 — Can the owner see what Chief remembers, where each item came from, and what each prompt held?

Work dates: 2026-11-03 to 2026-11-04 (Singapore). Written: 2026-11-04.
Status: in progress. agentwatch#20 and this branch are under review; nothing is merged or deployed.

## User-visible problem and preceding iteration

Chief keeps revisioned memory ([journal 129](129-revisioned-memory.md)), and a nightly learner adds facts, lessons and procedures ([journal 130](130-nightly-learner.md)). Postgres records which revisions each run had in context (`memory_context`), but none of it was visible outside the database: agentwatch showed prompts only as text, and the learner was not traced at all. Phase 6 of issue #323 asks for each item's history linked to its source, and for what each model call had in context, labelled "in context", never "used". The owner chose on 3 November that memory history is kept indefinitely in agentwatch, and that learner runs are traced in full, with content following the existing switch.

## Evidence

- **Convention (read 3 November 2026).** semantic-conventions-genai defines memory spans, at development status: `create_memory`, `update_memory`, `upsert_memory`, `delete_memory` and `search_memory`, with `gen_ai.memory.store.id`, `gen_ai.memory.record.id` and opt-in `gen_ai.memory.records` (`{id, content, metadata, score}`). It has no attribute for what a model call had in its prompt.
- **Chief's selection (code read).** `MemoryStore.select` chooses once per turn, so every model call in a run has the same items. Child agents and research children get none. A responsibility investigation gets none.
- **Tested, not measured on real traffic.** Unit tests cover the spans' shape with and without content capture, the parent and links of each change, the store reporting only committed changes, and a traced learner run. No production trace exists yet.

## Diagnosis and alternatives

- **Spans, not a custom log.** The convention's memory spans fit: the selection is a `search_memory` on the run, before its first model call, and each committed revision is a write. agentwatch then decides "in context" with one rule: the reads in the same agent that ended before the call.
- **A key is written text.** Chief exports no model- or owner-written text without content capture. Keys such as `wife_name` are such text, so without capture a key goes out as a hash and its content as `null`. The size is still sent, so what each prompt held is known without the text.
- **Links, not parents, for learned items.** A learner revision comes from turns in other traces. OTel span links point at them, which needed run span IDs derived from run IDs, as the backfill already derived them.
- **Kept indefinitely, in agentwatch.** Memory outlives the 90-day trace retention. A read's copy of the content goes when its trace is pruned, and an item's history can be deleted.

## Implementation and review

- agentwatch#20: `memory_records` (schema 11), the Memory and item pages, and "Memory in context" on model call spans. Independent review (Opus 5.5) of `9072170` requested changes. The fixes: a later read with no content no longer hides captured content; the Memory pages count reads instead of claiming context; one item per call; chunked re-derivation; pruned reads lose their content copy; deletion of an item's history.
- [src/otel.ts](../../src/otel.ts): `memoryContext`, `memorySearched`, `memoryChanged`, `memorySpan`; deterministic run span IDs. [src/memory.ts](../../src/memory.ts) reports each committed change and describes each selected item. [src/recall.ts](../../src/recall.ts) reports what `memory_recall` found. [src/learning.ts](../../src/learning.ts) traces learner runs and their model calls.
- Design: [tracing](../tracing.md#memory), [learning](../learning.md#telemetry-and-the-private-record).

## Verification and outcome

Pending: review of both pull requests, the agentwatch update (schema 11 cannot be read by the older image), the Chief release, and a first look at real traces.

## Follow-up and next iteration

- The learning evaluation: the owner-correction rate, split by whether learned items were in context, from existing signals. Then a with/without replay, which needs paid calls and the owner's approval.
