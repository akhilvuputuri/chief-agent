# 129 — Can memory be safe to write without approvals?

Work date(s): 2026-10-28. Written/revised: 2026-10-28.
Status: proposed (phase 1 of issue #326, branch `feat/learn-from-work`); not merged or deployed. Needs independent review, then the operator rollout of migration 010.

## User-visible problem and preceding iteration

Chief only remembers what the owner explicitly agrees to save ([journal 117](117-open-loops-and-memory-offers.md)). Issue #326 asks it to learn from completed work with no approvals: learned items are applied automatically, then analysed and cut back. Without gates, the only safety net is that every change can be traced to its source and undone. The `memories` table cannot do either: one row per key, overwritten in place, with no source, history or record of which runs saw it ([journal 06](06-observable-memory.md)).

The September observable-memory checkpoint (`checkpoint/observable-memory`, `2a85839`) had the right shape but was 483 commits behind main, unfinished and never deployed. This phase redoes the part #326 depends on, on current main, rather than rebasing it.

## Evidence

- Tested (code reading, 28 October): memories are written only by `memory_set` (an upsert) and are never deleted. Every owner turn injects all of them into the first system message, which carries the Anthropic cache breakpoint, so any write rebuilds the cached prefix. Skills are never injected; only their catalogue is.
- Tested: nothing reads Telegram reactions (`allowed_updates` is `message` and `callback_query`), and nothing records which memories a run had.
- Reported (issue #326, from Hermes Agent's source): Hermes stores agent-written skills in a content-addressed ledger whose rollbacks can themselves be undone, and flags but does not block on a threat scan. Its docs warn that in one continuous Telegram chat its session-end learning almost never fires.

## Diagnosis and alternatives

Revisions with heads, as in the checkpoint and the existing skill store, give history and undo without a new mechanism. Three choices differ from the checkpoint:

- **`memories` stays as a projection, not the source.** Job analysis and job alignment read it, and an older image writes it after a rollback. Writing it in the same transaction as each revision keeps both readers unchanged, and a startup pass imports whatever an older image changed. The alternative, migrating every reader at once, makes rollback lossy.
- **Context is recorded per run, not per model call.** Memories are loaded once per turn, so per-call rows would repeat the same set. Per-call prompt manifests, the checkpoint's heavier design, can come later if attribution needs them.
- **Owner facts are never budgeted.** Capping them now could silently drop something the owner asked to keep. Only learned items get a budget (4,000 characters), which is the part that grows without the owner.

Rollback restores the latest earlier revision that the filter does not match, instead of deleting, so an owner correction made after a bad learner run survives a rollback of that run.

## Implementation and review

- [Migration 010](../../db/010_memory.sql): `memory_revisions`, `memory_heads`, `memory_context`, `learner_runs`, `learning_reviews`, and a nullable `skill_versions.learner_run`.
- [`src/memory.ts`](../../src/memory.ts): `MemoryStore` with writes, retirement, rollback by learner run, window, untrusted source or kind, selection, context records and the legacy import; `scanThreats`.
- `memory_set` and `memory_list` go through the store (`src/tools.ts`). Owner turns select through it and record `memory_context` plus a `memory.selected` event (`src/agent.ts`). Learned items get their own label in the cached prefix, which is unchanged while none exist (`src/context.ts`). The gateway refuses to start without migration 010 and runs the import (`src/main.ts`).
- Operator rollout [`scripts/deploy-memory.py`](../../scripts/deploy-memory.py) with offline tests, and the Compose inventory line.
- Design: [learning from completed work](../learning.md), which also records the owner's chosen defaults for the issue's open questions and the remaining phases.

Independent review: pending.

## Verification and outcome

Tested locally on Node 22.23.4 with PGlite: `tests/memory.test.ts` (10 tests) covers revisions and provenance through `memory_set`, the kind guard, the learned-over-owner conflict flag and untrusted tagging, threat flags, rollback by run (restore, retire, a later owner revision left alone, idempotent repeat), rollback by source and kind, owner scoping, the selection budget and order, legacy import including rows an older image changed, and an end-to-end turn whose prefix is unchanged until a learned item exists. `python3 scripts/test-deploy-memory.py` passes.

Not done: production rollout, any learner, any measurement. The prefix is expected to be byte-identical for existing owners until phase 2 writes a learned item; that is tested in the end-to-end test, not yet observed in production cache counts.

## Follow-up and next iteration

Phase 2, the nightly learner, writes into these tables. Before it ships, check after the rollout that `memory.imported` reports the expected count and that cached-token counts on the next owner turns match the days before.
