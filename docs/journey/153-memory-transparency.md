# 153 — Can the owner see what Chief remembers, where each item came from, and what each prompt held?

Work dates: 2026-11-03 to 2026-11-04 (Singapore). Written: 2026-11-04.
Status: merged in agentwatch (`ce79f96`, image `sha256:45d4c67c…`); the Chief export is under review with that image pinned. Nothing is deployed.

## User-visible problem and preceding iteration

Chief keeps revisioned memory ([journal 129](129-revisioned-memory.md)), and a nightly learner adds facts, lessons and procedures ([journal 130](130-nightly-learner.md)). Postgres records which revisions each run had in context (`memory_context`), but none of it was visible outside the database: agentwatch showed prompts only as text, and the learner was not traced at all. Phase 6 of issue #323 asks for each item's history linked to its source, and for what each model call had in context, labelled "in context", never "used". The owner chose on 3 November that memory history is kept indefinitely in agentwatch, and that learner runs are traced in full, with content following the existing switch.

## Evidence

- **Convention (read 3 November 2026).** semantic-conventions-genai defines memory spans, at development status: `create_memory`, `update_memory`, `upsert_memory`, `delete_memory` and `search_memory`, with `gen_ai.memory.store.id`, `gen_ai.memory.record.id` and opt-in `gen_ai.memory.records` (`{id, content, metadata, score}`). It has no attribute for what a model call had in its prompt.
- **Chief's selection (code read).** `MemoryStore.select` chooses once per turn, so every model call in a run has the same items. Child agents and research children get none. A responsibility investigation gets none.
- **Tested, not measured on real traffic.** Unit tests cover the spans' shape with and without content capture, the parent and links of each change, the store reporting only committed changes, and a traced learner run. No production trace exists yet.

## Diagnosis and alternatives

- **Spans, not a custom log.** The convention's memory spans fit: the selection is a `search_memory` on the run, before its first model call, and each committed revision is a write. agentwatch then decides "in context" with one rule: the reads in the same agent that ended before the call.
- **A key is written text.** Chief exports no model- or owner-written text without content capture. Keys such as `wife_name` are such text. The first version sent a hash of the key and of the owner, and review showed both can be reversed: owner keys are short lowercase words, and the owner ID is a Telegram number. The IDs now come from the data: the owner's first revision ID names the store, and a key's first revision ID names the item. The content goes as `null`, and the size is still sent, so what each prompt held is known without the text.
- **Links, not parents, for learned items.** A learner revision comes from turns in other traces. OTel span links point at them, which needed run span IDs derived from run IDs, as the backfill already derived them.
- **Learner calls apart.** Learner runs go under the service `chief-learner`, so their long night-time calls do not feed the turns' monitors, whose limits were set from turns.
- **Links to older turns.** Live run spans had random IDs until this change, so links from learned items to turns exported live before it name spans agentwatch does not have; their trace IDs are still right.
- **Kept indefinitely, in agentwatch.** Memory outlives the 90-day trace retention. A read's copy of the content goes when its trace is pruned, and an item's history can be deleted.

## Implementation and review

- agentwatch#20: `memory_records` (schema 11), the Memory and item pages, and "Memory in context" on model call spans. Independent review (Opus 5.5) of `9072170` requested changes. The fixes: a later read with no content no longer hides captured content; the Memory pages count reads instead of claiming context; one item per call; chunked re-derivation; pruned reads lose their content copy; deletion of an item's history. Review of `b32c79b` found the deletion did not stick: the item's text stayed in the stored spans and came back when they were read again. Deletion now rewrites those spans and is remembered.
- agentwatch#20 merged at the approved head `98d045e` as `ce79f96`, after one more round: review of `a2b26a3` approved, and review of `0adbab3` found that the text search for a deleted item's spans missed IDs that are escaped twice inside a JSON-string record (quotes, backslashes, control or non-ASCII characters). Every memory span of the store is now checked instead. Review of `98d045e` approved, with low notes on store IDs outside the conventions.
- Review of this branch at `c93cd27` requested changes: the reversible hashes above; the learner feeding the turns' monitors; `memory_list` reads not exported; a stale backfill note; missing tests for rollback, the import, a real recall and a failed learner call. Review of `13ee5e3` approved. `compose.yaml` then pins the image from agentwatch `ce79f96`, which upgrades the database to schema 11; the older image cannot read it.
- [src/otel.ts](../../src/otel.ts): `memoryContext`, `memorySearched`, `memoryChanged`, `memorySpan`; deterministic run span IDs. [src/memory.ts](../../src/memory.ts) reports each committed change and describes each selected item. [src/recall.ts](../../src/recall.ts) reports what `memory_recall` found. [src/learning.ts](../../src/learning.ts) traces learner runs and their model calls.
- Design: [tracing](../tracing.md#memory), [learning](../learning.md#telemetry-and-the-private-record).

## Verification and outcome

Pending: review of both pull requests, the agentwatch update (schema 11 cannot be read by the older image), the Chief release, and a first look at real traces.

## Follow-up and next iteration

- The learning evaluation: the owner-correction rate, split by whether learned items were in context, from existing signals. Then a with/without replay, which needs paid calls and the owner's approval.
