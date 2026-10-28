# 129 — Can memory be safe to write without approvals?

Work date(s): 2026-10-28. Written/revised: 2026-10-28.
Status: released in `e6f75f7` through the operator rollout of migration 010 on 28 October 2026. The cached-prefix check on later owner turns is pending.

## User-visible problem and preceding iteration

Chief only remembers what the owner explicitly agrees to save ([journal 117](117-open-loops-and-memory-offers.md)). Issue #326 asks it to learn from completed work with no approvals: learned items are applied automatically, then analysed and cut back. Without gates, the only safety net is that every change can be traced to its source and undone. The `memories` table cannot do either: one row per key, overwritten in place, with no source, history or record of which runs saw it ([journal 06](06-observable-memory.md)).

The September observable-memory checkpoint (`checkpoint/observable-memory`, `2a85839`) had the right shape but was 483 commits behind main, unfinished and never deployed. This phase redoes the part #326 depends on, on current main, rather than rebasing it.

## Evidence

- Tested (code reading, 28 October): memories are written only by `memory_set` (an upsert) and are never deleted. Every owner turn injects all of them into the first system message, which carries the Anthropic cache breakpoint, so any write rebuilds the cached prefix. Skills are never injected; only their catalogue is.
- Tested: nothing reads Telegram reactions (`allowed_updates` is `message` and `callback_query`), and nothing records which memories a run had.
- Reported (issue #326, from Hermes Agent's source): Hermes stores agent-written skills in a content-addressed ledger whose rollbacks can themselves be undone, and flags but does not block on a threat scan. Its docs warn that in one continuous Telegram chat its session-end learning almost never fires.

## Diagnosis and alternatives

Revisions with heads, as in the checkpoint and the existing skill store, give history and undo without a new mechanism. Three choices differ from the checkpoint:

- **`memories` stays as a projection of the owner's explicit facts, not the source.** Job analysis and job alignment read it, and an older image writes it after a rollback. Writing it in the same transaction as each revision keeps those readers unchanged, and a startup pass imports whatever an older image changed. Learned facts are left out of it, so those readers never see one unlabelled. The alternative, migrating every reader at once, makes rollback lossy.
- **Context is recorded per run, not per model call.** Memories are loaded once per turn, so per-call rows would repeat the same set. Per-call prompt manifests, the checkpoint's heavier design, can come later if attribution needs them.
- **Owner facts are never budgeted.** Capping them now could silently drop something the owner asked to keep. Only learned items get a budget (4,000 characters), which is the part that grows without the owner.

Rollback records every learned revision it undoes and returns a key to the latest revision that is neither undone nor a restored copy, instead of deleting, so an owner correction made after a bad learner run survives a rollback of that run, and undoing several runs lands on a value none of them wrote.

## Implementation and review

- [Migration 010](../../db/010_memory.sql): `memory_revisions`, `memory_heads`, `memory_undone`, `memory_context`, `learner_runs`, `learning_reviews`, and a nullable `skill_versions.learner_run`.
- [`src/memory.ts`](../../src/memory.ts): `MemoryStore` with writes, retirement, rollback by learner run, window, untrusted source or kind, selection, context records and the legacy import; `scanThreats`.
- `memory_set` and `memory_list` go through the store (`src/tools.ts`). Owner turns select through it and record `memory_context` plus a `memory.selected` event (`src/agent.ts`). Learned items get their own label in the cached prefix, which is unchanged while none exist (`src/context.ts`). The gateway refuses to start without migration 010 and runs the import (`src/main.ts`).
- Operator rollout [`scripts/deploy-memory.py`](../../scripts/deploy-memory.py) with offline tests, and the Compose inventory line.
- Design: [learning from completed work](../learning.md), which also records the owner's chosen defaults for the issue's open questions and the remaining phases.

Independent review of `16d55da` (Claude Opus 5.5): REQUEST CHANGES, with two blocking findings, both reproduced by the reviewer and neither reachable in production yet (no learner or rollback caller exists):

- **Undoing two learner runs one after the other left an undone run's value active.** With an owner fact, then runs A and B overwriting it, undoing B restored A's revision as a rollback copy, which a later undo of A no longer matched; in the other order, undoing B chose A's revision as the one to restore. Fixed with the `memory_undone` ledger: every matching revision is recorded, current or not, restores skip undone revisions and copies, and a copy resolves to its original when matching.
- **A rollback stripped a restored value's learned and untrusted status.** A copy of a copy recorded `restoredOrigin: rollback`, so a value learned from email moved into the explicit memories and the projection, and a rollback by source no longer found it. Fixed: a copy always names the original it restored, and carries its trust and sources.

Non-blocking findings fixed in the same revision: responsibility investigations recorded a memory context they never received (now recorded after the request is final, empty for them); a learner retirement copied the old revision's trust (it now carries its own); the store's guards threw plain errors that would be classified as uncertain writes (now `ToolValidationError`); learned facts reached older readers through the projection unlabelled (now excluded); an end-only window was refused (now allowed); owner facts were counted as flagged (now only learned items); `created_at` ordering used string comparison (now time). The docs now say that forgetting means retiring through the store, since deleting a `memories` row no longer forgets anything.

## Verification and outcome

Tested locally on Node 22.23.4 with PGlite: `tests/memory.test.ts` (16 tests) covers revisions and provenance through `memory_set`, the kind guard, the learned-over-owner conflict flag and untrusted tagging, threat flags, rollback by run (restore, retire, a later owner revision left alone, idempotent repeat, two runs undone in either order), a restored value keeping its labels through chained rollbacks, a learner retirement undone by source, an end-only window, guards as validation errors, an older image writing over a learned head, rollback by source and kind, owner scoping, the selection budget and order, legacy import including rows an older image changed, and an end-to-end turn whose prefix is unchanged until a learned item exists. `python3 scripts/test-deploy-memory.py` passes.

Not done: production rollout, any learner, any measurement. The prefix is expected to be byte-identical for existing owners until phase 2 writes a learned item; that is tested in the end-to-end test, not yet observed in production cache counts.

### Release closure — 2026-10-28

- [PR 338](https://github.com/akhilvuputuri/chief-agent/pull/338) merged as `e6f75f7`, from approved head `211b9fd` (merged tree identical; hosted CI and Devin passed).
- Operator rollout with `scripts/deploy-memory.py`, baseline `0a78485` (the live release at merge): deployed, healthy, migration 10. The 7 existing memories became `legacy` revisions with trust `unknown`, every head matching its `memories` row; `memory.imported` logged 7 imported and 0 projected.
- The automatic release first collided with the rollout's release lock (`EAGAIN`) and succeeded as a no-op on re-run. See the [release record](../releases.md).
- Pending: compare cached tokens and `memory.selected` on the next owner turns with earlier days.

## Follow-up and next iteration

Phase 2, the nightly learner, writes into these tables. Before it ships, check after the rollout that `memory.imported` reports the expected count and that cached-token counts on the next owner turns match the days before.
