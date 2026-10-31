# 130 — Can Chief learn from finished work without being asked?

Work date(s): 2026-10-28. Written/revised: 2026-10-28.
Status: released in `d7df9aa` on 28 October 2026. The first nightly run and what it learns are pending.

## User-visible problem and preceding iteration

Chief remembers only what the owner agrees to save. Issue #326 asks it to learn from completed work with no approvals. [Journal 129](129-revisioned-memory.md) built the safety net first: revisions with provenance, trust tags, flags and bulk rollback. This phase adds the learner that writes into it.

## Evidence

- Reported (issue #326, from Hermes Agent's source): Hermes triggers on activity counts, not outcomes, and its docs warn that in one continuous Telegram chat its learning "almost never" fires. Chief's conversation is one rolling chat, so this learner triggers on finished work tasks instead.
- Reported ("Demystifying Agent Skills", arXiv 2608.14036, abstract): outcome labels matter (74.6% with success/failure labels against 40.0% without).
- Tested (code reading): a task becomes `done` only when every step has proof, so `done` is a stronger signal than a non-empty reply. Nothing reads Telegram reactions, so no reaction signal exists yet.

## Diagnosis and alternatives

- **Trigger on finished tasks, nightly, rather than after each turn.** Owner volume is low, a nightly batch changes the cached prefix at most once a day, and the 24-hour quiet window needs time to pass anyway. The alternative, a fork after every reply like Hermes, would mostly see unfinished work.
- **A small dedicated loop, not the coordinator runtime.** The learner needs four tools and no domain access. Running it through the coordinator would mean scoping out about 54 tools and their context; a separate loop cannot call them at all. It reuses the model adapter, `Spending` and the run ledger, so its cost is still recorded per run.
- **Facts need the owner's own words, and the words must state the fact.** The host checks the quote against the owner's text in the cited task, with attachment content cut off, and requires every content word and number of the value to appear in it, so a fact cannot be lifted from an email, web page or attached document even if the model is misled. Lessons are not quote-checked; they carry the tasks' untrusted tags instead, and are rolled back by source if needed.
- **Apply after the run, all or nothing on pre-emption.** A run the owner interrupts applies nothing and labels nothing, so it starts over cleanly instead of leaving half a batch.

## Implementation and review

- [`src/learning.ts`](../../src/learning.ts): `labelTask`, `untrustedSources`, `Learner` (schedule window, deferral, evidence, model loop, host checks, batch apply, recovery).
- Gateway wiring in `src/main.ts`: a 10-minute tick per allowed owner on the `standard` tier, stopped at shutdown; `LEARNING` in `config/runtime.json` (`on`; `off` stops it).
- Telemetry: `learner.finished` with counts; `learner.failed`, `learner.item_refused` and `learner.tick_failed` with error classes only.
- Design: [learning from completed work](../learning.md#phase-2-the-nightly-learner).

Independent review of `c77d295` (Claude Opus 5.5): REQUEST CHANGES, with three blocking findings, each reproduced by the reviewer:

- **The quote did not have to support the fact.** Any eight characters of the owner's text passed, so a misled model could store "Pays invoices to account 999-000" quoting "Book my flight". Fixed: every content word and number of the value must appear in the quote.
- **Attached PDF text counted as the owner's words, and as owner-trusted.** Telegram intake stores the caption plus the extracted text as the owner's message and as the task request, with no receipt for the inline excerpt. Fixed: owner text is cut at the host's attachment note and the task is tagged `document`.
- **The untrusted-source map missed operations that return external content** (MCP, links, feeds, files, parcels, invoices, gathering, saved roles). Fixed by failing closed: anything not owner-internal is `external`.

Non-blocking findings fixed in the same revision: paused tasks waiting on the owner could fill the 20-task limit and starve finished work (now excluded in the query); the per-task size cap was not enforced beyond steps (now enforced in order); an owner turn during the last call still let the batch apply (now rechecked before applying); learned facts could replace an owner's fact with the same key (now refused until phase 3); `learn_finish` without a summary was refused (now optional); one owner's failure skipped the others in a tick (now caught per owner). The delta review of `64c8d44` requested changes again: forwarded Telegram messages were stored exactly like the owner's own text, so a forwarded "I prefer refunds paid to account 4410-2231" passed every check as owner-trusted; and the quote check ignored negation and words under four letters, so "Does not want aisle seats" or "Sends OTP and PIN to Tan" passed. Fixed: intake marks forwarded messages with a leading host note and the learner treats a message starting with a host note as none of the owner's words; every non-function word must come from the quote and negation must match. Owner-internal stores (items, preparation, conversation) no longer count as external, and the owner-key check is repeated when applying. The delta review of `f59dc11` approved, with two notes, both addressed in the next revision: the docs claimed the quote check stops inverting the owner's words, but it compares words, not meaning, so a recombination of the owner's own words passes (the docs now say so); and a forwarded `/status`, `/approve`, `/library` or plain "yes" to a brief was still parsed as the owner's command, a gap that predates this work. Every command check now reads only text the owner typed.

Documented rather than changed: items are written one at a time, so a crash can leave part of a batch; the learner's running row makes idle-waiting guards wait for it; any failed receipt makes a task a pitfall.

## Verification and outcome

Tested locally on Node 22.23.4 with PGlite, `tests/learning.test.ts` (14 tests, plus a forwarded-message case in `tests/telegram.test.ts`): labelling rules; untrusted kinds; the 03:30 window, one run a night, and a missed night skipped; a run that accepts a quoted fact (tagged untrusted from the task's email and web reads, with message IDs) and a correctly labelled lesson, refuses an unquoted fact, a mislabelled lesson, invalid arguments and an unknown tool, labels each task once and leaves a too-recent task for the next night; no model call without evidence; deferral while the owner is active, capped at three; pre-emption mid-run applying nothing, then a clean retry; retirement limited to learned items; restart recovery and the off switch; and, after review, owner words cut at attachments, quote-to-value binding (an unrelated quote, a changed number), the owner's keys left alone, fail-closed untrusted tags, no starvation by paused tasks, and deferral when the owner arrives during the last call.

Not done: no production run, no measurement of what it learns, cost per run or effect on later turns. A fake model drives the tests, so the quality of real proposals is untested.

### Release closure — 2026-10-28

- [PR 340](https://github.com/akhilvuputuri/chief-agent/pull/340) merged as `d7df9aa`, from approved head `fa9e0d4` (merged tree identical; hosted CI and Devin passed). No migration.
- The automatic release deployed it at 16:04 UTC; `gateway.started` reported the release on Node v22.23.4, and the gateway's container log had no `error`- or `warn`-level line from its start at 16:03:49 to 16:06:35 UTC. No learner run had happened yet; the first window opens at 19:30 UTC. See the [release record](../releases.md).
- Pending: the first night's `learner.finished` counts, its charges and the items it wrote.

## First night and conversation turns — 2026-10-29

- **Measured (production, 03:32:54 SGT on 29 October, release `4fd53c0`):** one completed run with prompt `learner-v1`. It reviewed 7 tasks, labelled all 7 `skipped` (six routine occurrences as `not_owner_request`, one `cancelled`) and made no model call, so it learned nothing and was charged nothing. Those 7 were every work task updated in the 14-day window.
- **Diagnosis:** most owner requests are answered as ordinary turns without `work_start`, so finished work tasks are rare. A learner limited to tasks would almost never fire, the same failure Hermes's docs warn about for session-end learning in one long chat.
- **Owner decision (29 October):** also learn from ordinary conversation turns, with a weaker success signal (answered, not corrected in the next message within six hours) and the owner's correction as pitfall evidence. Routines stay excluded.
- **Change (`learner-v2`):** up to 30 turns a night after the tasks; `labelTurn` and `isCorrection` in [`src/learning.ts`](../../src/learning.ts); provenance records `turnRunIds` alongside `taskIds`; design in [learning](../learning.md#conversation-turns). Tested with a fake model in `tests/learning.test.ts` (16 tests): labels, correction cues including a "no" to Chief's own offer, a correction becoming quotable owner evidence, tracked-task turns left to the task, recent turns waiting a night, and no turn reviewed twice. Independent review of `69e141c` (Claude Opus 5.5): REQUEST CHANGES. The correction detector treated acknowledgements and new requests as corrections ("No worries, thanks!", "No problem", "Actually that's perfect", "Actually, can you also book a hotel?", "Not right now"), while the prompt told the model a correction is what the owner wants instead; and it missed plain corrections ("That isn't what I asked", "The date is wrong", "It should be Tuesday, not Monday"). Fixed: acknowledgements never count, plain statements of a wrong answer count anywhere in the opening, and the reviewer's cases are regression tests. Also fixed: `finish_turn` no longer stops a "thanks" turn from being trivial, and a delegated agent's reads tag the turn. The owner asked for much larger evidence sizes (cheap, to be cut after analysis): about 8,000 characters a turn and 12,000 a task. Merged as `260c94c`; live in `b6e1071` (03:05 UTC on 29 October) and now `845595e`. The first run with turns is pending.

## No record of what the learner decided — 2026-10-31

**Measured (production, runs at 03:33 SGT on 30 and 31 October, prompt `learner-v2`):**

| Run (SGT)  | Reviewed | Success | Pitfall | Model calls | Refused | Saved | Cost    |
| ---------- | -------- | ------- | ------- | ----------- | ------- | ----- | ------- |
| 30 October | 30       | 19      | 3       | 2           | 1       | 0     | $0.0749 |
| 31 October | 25       | 20      | 2       | 1           | 1       | 0     | $0.0716 |

The turn backlog is cleared. Of the 55 turns, one pitfall came from an owner correction and four from recovered failures.

**The gap.** The owner asked to examine what had been mined. There was nothing to read: for these runs the server held counts in `learner_runs`, two count-only events per run, the same counts in the ops log and tokens and cost per model call, with no saved messages, tool calls or traces. The two refused proposals cannot be recovered, and "refused" also counts malformed calls, so they may not have been real items. An accepted item could also be dropped silently when applied. The cause is the design in this entry: the learner is a small separate loop, which bypasses the run journal and trace export that normal runs use, and provenance was built only for items that get written. Independent review did not catch it, and was not asked to. Learning without approvals rests on being able to inspect what happened, so this undercut the phase's own safety argument.

**Change.** Each run now records `learner.input`, `learner.model_call`, `learner.proposal` and `learner.applied` privately in `events` ([learning](../learning.md#telemetry-and-the-private-record)). Behaviour is unchanged. Writes stay on: a proposal to pause them with a shadow mode was the implementer's overreach, and the owner rejected it, since the no-approvals decision stands and only the record was missing. Tested in `tests/learning.test.ts` (22 tests): the record's contents, credential scrubbing, the verdict on each proposal, the outcome of each accepted item, nothing reaching the ops log, a pre-empted run keeping its record, and neither text the database refuses nor a failed insert affecting learning. Independent review of `c233481` (Claude Opus 5.5) requested changes: half an emoji at a clip boundary made the first record fail the whole run, every night, and a failed record could fail a run after it had written an item. The record is now best effort and made storable first, and clipping no longer splits a surrogate pair. Trace export is not connected. Not yet released.

**Unknown.** Why nothing has been saved: the model may be too cautious, the quote check too strict, or the turns thin. The record lets later nights answer that.

## Follow-up and next iteration

After the phase 1 rollout and this release: check the first night's `learner.finished` counts and charges, and read what it wrote (`memory_revisions` with `origin='learned'`). Phase 3 adds the weekly digest with undo and skills drafted from two independent successes. The owner decided on 29 October not to use reactions or any other manual labelling, so outcomes come only from task proof and corrections in the owner's next message.
