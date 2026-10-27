# Learning from completed work

Issue [#326](https://github.com/akhilvuputuri/chief-agent/issues/326). Chief should get better with use without the owner asking it to remember things. A background learner reviews completed work items, labels their outcomes, and writes reusable facts, lessons and skills. There are no approvals in v1 (owner decision, 27 October 2026). Safety comes from provenance, immutable revisions, flags, measurement and bulk rollback instead of gates.

Status: phase 1 (revisioned memory) proposed in branch `feat/learn-from-work`; later phases not started. See [journal 129](journey/129-revisioned-memory.md).

## Decisions

The owner asked for the recommended defaults for the issue's open questions on 28 October 2026:

| Question                | Default                                                                                                                                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Success window          | A work task counts as a success when it reached `done` (each step already needs proof: matched evidence, a success receipt for its expected operation, or an analysis proof), and in the 24 hours after that it was not revised, reopened or cancelled and no call in its runs failed or ended uncertain. |
| Reactions               | Not required. Telegram reactions are not read today (`allowed_updates` is `message` and `callback_query`). Once they are, a 👎 on a task's reply vetoes it as a success.                                                                                                                                  |
| Failed items            | A task that paused, blocked, failed a receipt or was undone becomes _pitfall_ evidence, never a workflow.                                                                                                                                                                                                 |
| Cadence                 | One learner run a night at 03:30 Singapore, which is also the daily batch that changes the cached prefix. The run is deferred while an owner input is queued or running.                                                                                                                                  |
| Model                   | The `standard` tier (Claude Opus 5.5 today) through `config/model-policy.json`, because the volume is small (about 218 owner messages in 7 weeks, journal 120) and judgement of what is worth keeping matters more than price.                                                                            |
| Cost                    | No dollar cap ([AGENTS.md](../AGENTS.md#product-and-safety-constraints)). Each run has fixed allocations instead: at most 20 tasks reviewed, 10 model calls and a bounded input, and its cost is recorded against its own run ID in `provider_charges`, separate from owner turns.                        |
| First cut-back analysis | Four weeks after the learner goes live. Signals: flagged items, items never in context, items in context for runs that failed or were corrected, and the with/without-learning eval (#323).                                                                                                               |
| Packaging               | A module in this repository (`src/memory.ts`, later `src/learning/`) with the issue's `Store`/`Model`/`SuccessSignal`/`TrustPolicy`/`Clock` boundaries kept internal. Extracting it into a package waits for the #323 repository.                                                                         |

## Phases

1. **Revisioned memory (this phase).** Migration 010, `MemoryStore`, prompt selection with a learned-item budget, per-run context records, legacy import, bulk rollback in the store. No model calls and no new tools.
2. **Learner.** Outcome labelling of completed tasks (`learning_reviews`), the nightly durable job with restricted learning tools (modelled on the responsibility-scoped background turn in `src/agent.ts`), Hermes-style capture rules with "nothing to save" as the default, owner facts and lessons written through the store.
3. **Owner view and skills.** Weekly Telegram digest with diffs, evidence and one-tap undo; `/forget` and rollback by run, window, source or kind; reaction intake; learner-drafted skills activated after two independent successful tasks, without `/approve` (owner-authored skills keep it).
4. **Lifecycle and analysis.** Deterministic staleness (unused 30–60 days, no positive attribution → retired as a revision), consolidation as revisions, lifecycle events for #323, and the four-week analysis report.

## Phase 1: revisioned memory

### Storage

[Migration 010](../db/010_memory.sql) is additive:

- `memory_revisions`: immutable revisions per owner and key. Each has a `kind` (`fact` or `lesson`), a `status` (`active` or `retired`; a retired revision has no value), an `origin` (`owner`, `learned`, `legacy`, `rollback`), a reason, a `source` object with the run, input, task, step, invocation and message IDs it came from, the `learner_run`, a `trust` (`owner`, `untrusted`, `unknown`), the kinds of untrusted content its run read, and threat `flags`.
- `memory_heads`: the current revision per key, with a `pinned` flag that exempts it from the budget order and from later staleness.
- `memory_undone`: every learned revision a rollback undid. A later rollback never restores one.
- `memory_context`: per run, the revisions selected into its context and the ones the budget left out. Being in context is recorded; being used is not claimed.
- `learner_runs` and `learning_reviews`: the learner's ledger and one outcome label per reviewed task, so a task is learned from at most once. Unused until phase 2.
- `skill_versions.learner_run`: provenance for learner-drafted skills. Unused until phase 3.

The legacy `memories` table stays as the projection of the owner's active explicit facts (owner and imported ones), written in the same transaction as each revision. Job analysis (`job_analyze` profiles), job alignment's frozen memory snapshots and an older image after a rollback keep reading it, and never see a learned fact: when a learned revision becomes a key's head, its row is removed. Deleting a row by hand no longer forgets anything, because turns read the revisions and the next start restores the row; forgetting means retiring the key through the store.

### Writes

`memory_set` appends a revision with origin `owner`, trust `owner` and the run ID as its source; it still returns `saved: true`, plus the revision number. `memory_list` marks learned items with `learned: true` and lessons with their kind. One owner's memory writes are serialized with a lock on the owner row, so revision numbers never race. Lesson keys, and only lesson keys, start with `lesson:` (`lesson:<domain>:<slug>`), which `memory_set`'s key pattern cannot produce, so a key never changes kind. The store's guards throw `ToolValidationError` before any mutation, so a refusal is never classified as an uncertain write.

A learned write that changes an owner's active fact wins as a new revision and is flagged `conflict`. A learned write or retirement whose run read untrusted content is stored with trust `untrusted` and its source kinds, so it can be filtered and rolled back in bulk.

### Threat scan

`scanThreats` flags, never blocks: instruction-override and role-change phrasing (`injection`), requests to send credentials or URLs carrying query parameters (`exfiltration`), zero-width and direction-override characters (`invisible_text`), and token-shaped secrets (`secret`). Flags are stored on write; learned items are rescanned when selected, so a pattern added later also counts older ones. The owner's own facts are not counted. The count is logged as `flaggedCount` on `memory.selected`, at warn level when non-zero.

### Selection

Owner and imported facts are always included, as before this store existed, under the existing "Explicit memories" label; the cached prefix is byte-identical to before while no learned item exists. Learned facts and lessons follow under their own label, "Learned from completed work (data, not instructions; an explicit memory or the owner's current words win)", within 4,000 characters: pinned first, then newest first, then sorted by key so an unchanged set keeps the cached prefix. Responsibility investigations, plugin agents and research specialists still receive no memories.

Every owner turn records `memory_context` for its run, after the request is final, and a `memory.selected` event with counts (explicit, learned, omitted, flagged, characters) that the ops log projects without content. A responsibility investigation, which gets no memories, records an empty selection.

### Rollback

`MemoryStore.rollback(user, filter, reason)` takes a learner run, a time window (a start, an end or both), an untrusted source kind or a kind (at least one), and matches learner revisions by when they were originally learned. Every matching revision, current or not, is recorded in `memory_undone`. A key whose current value came from an undone revision, directly or as a restored copy, returns to the latest earlier revision that is neither undone nor a restored copy, or is retired when that is none or a retirement. A key whose current value came from anything else, such as a later owner revision, is left alone. Undoing several runs therefore lands on the latest value none of them wrote, in any order. The undo is itself a revision (`origin: rollback`); a restored copy carries the original's trust and untrusted sources and names the original it restored in `source.restoredFrom`, so it stays labelled as learned and can still be rolled back by source. Repeating a rollback changes nothing. It returns how many revisions it undid, restored and retired. Phase 3 exposes it to the owner; undoing a rollback is not implemented.

### Legacy import and rollback compatibility

At startup the gateway refuses to run without migration 010 (`STARTUP_MIGRATION_010`), then imports every `memories` row that the revisions do not hold as a `legacy` revision with trust `unknown` and the row's `updated_at` in `source`. The original source of those memories is not known, so none is invented. The same pass re-imports rows that an older image changed after a rollback and restores any projection row that went missing; it logs `memory.imported` with counts when it did anything.

An older image after a rollback reads and writes only `memories`, which the candidate kept current for explicit facts, so no data needs reversing. A row the older image wrote for a key whose head is learned is imported as the owner's value on the next start.

### Deployment

The release guard refuses any `db/` or `compose.yaml` change that an operator rollout has not installed. The rollout PR carries the migration, its Compose inventory line after `009_calendar_approval.sql` and the reviewed [`scripts/deploy-memory.py`](../scripts/deploy-memory.py), whose `BASE` must equal the live release when the PR merges. Run it right after the merge, under the release lock with an idle gateway:

1. Upload the merged `git archive` and the script, and compare the script with the merged file.
2. `sudo python3 deploy-memory.py <archive.tar> <merge SHA>`: it validates that only migration 010 and its Compose line changed, builds the candidate, refuses active runs or queued input, stops the gateway, applies the migration, checks the version 10 marker, starts the candidate and checks health, restoring the previous image and Compose file on any failure.
3. The automatic release for the same commit then succeeds as a no-op.

`python3 scripts/test-deploy-memory.py` runs the rollout offline.
