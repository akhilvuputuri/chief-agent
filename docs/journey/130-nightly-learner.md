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
- **Facts need the owner's own words, and the words must state the fact.** The host checks the quote against the owner's text in the cited task, with attachment content cut off, and requires every content word and number of the value to appear in it, so a fact cannot be lifted from an email, web page or attached document even if the model is misled. ([Saving more](#saving-more--2026-11-01) later loosened this at the owner's request: up to half a reworded fact's words may come from outside the quote.) Lessons are not quote-checked; they carry the tasks' untrusted tags instead, and are rolled back by source if needed.
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

**Change.** Each run now records `learner.input`, `learner.model_call`, `learner.proposal` and `learner.applied` privately in `events` ([learning](../learning.md#telemetry-and-the-private-record)). Behaviour is unchanged. Writes stay on: a proposal to pause them with a shadow mode was the implementer's overreach, and the owner rejected it, since the no-approvals decision stands and only the record was missing. Tested in `tests/learning.test.ts` (22 tests): the record's contents, credential scrubbing, the verdict on each proposal, the outcome of each accepted item, nothing reaching the ops log, a pre-empted run keeping its record, and neither text the database refuses nor a failed insert affecting learning. Independent review of `c233481` (Claude Opus 5.5) requested changes: half an emoji at a clip boundary made the first record fail the whole run, every night, and a failed record could fail a run after it had written an item. The record is now best effort and made storable first, and clipping no longer splits a surrogate pair. Trace export is not connected. Released in `ea9943c`.

**Unknown.** Why nothing has been saved: the model may be too cautious, the quote check too strict, or the turns thin. The record lets later nights answer that.

## Saving more — 2026-11-01

**Owner decision.** The goal is that Chief gets better from use, both knowing the owner and doing the work, with nothing asked of the owner. Saving nothing from 55 turns does not serve "accumulate, then cut back", so the learner should save more and the owner will prune later. Pruning goes through a coding session for now; a Telegram tool waits until the core works.

**Change (`learner-v3`).**

- The instructions no longer say most nights nothing is worth saving. They err toward saving, and a lesson may come from one item.
- A reworded fact is applied and flagged `paraphrased` rather than refused. It still needs a real quote of the owner's own words, no added number or negation, and at least half its content words from the quote.
- Learned items reach the prompt up to 12,000 characters instead of 4,000, or they would never reach Chief.
- Up to 60 turns a night instead of 30, and items reviewed under the earlier prompts are mined again once.

**Accepted risk.** More mediocre or wrong items reach Chief's prompt until they are pruned, and more prompt text means more cached input and can leave less room for older history on each turn. A fake model drives the tests (24 in `tests/learning.test.ts`), so what real nights save was unmeasured at this point. Released in `c54ddcb`.

## First night under the new rules, and pruning — 2026-11-01

**Measured (production, 03:32 SGT on 1 November, `learner-v3`, read from the new private record):** 55 items reviewed (36 success, 4 pitfall, 15 skipped), one model call, $0.17. It saved 1 fact and 5 lessons and refused 5 facts. The model sent everything and finished in the same response, so it never saw the refusals.

**Reading the proposals (owner and implementer judgement, not a measurement):**

- Three refused facts were good. Each was stopped by the negation check because the owner's sentence held an unrelated "no" or "not".
- Two saved lessons were wrong. The rain format lesson read silence as approval and contradicts the plain rain replies decision ([journal 109](109-plain-rain-replies.md)). The artifact-size lesson told coding jobs not to update the repo's records, a workaround for one error.
- A third, on cancelling blocking tasks without asking, is doubtful and stays for now.
- Five of the six saved items are tagged `untrusted`, largely because domain tools count as external. That tag is too broad to help pruning.

**Production edits, approved by the owner.** The two wrong lessons were retired and the three facts added as the owner's own, through `MemoryStore`, in a coding session.

**Change.** The negation check refuses only an added negation; a dropped one is applied and flagged. A response with refusals earns one more turn to correct them. Learned facts and lessons each have half the prompt budget, with unused room shared, after the research found that newest-first selection would let lessons evict facts about the owner. Tested in `tests/learning.test.ts` and `tests/memory.test.ts`. Not yet released.

**Still open.** "Not corrected" was read as approval for a format rule, and nothing checks a lesson against earlier decisions. Hermes's "almost never fires" warning cited above concerns its forget-and-recall loop, not review learning (found in the research on 1 November); Chief's measured task shortage stands independently.

## Looking further back — 2026-11-01

The owner asked the learner to save more, after only 14 memories had built up. Production counts showed why so little had come out:

- **It saw little.** Of 183 conversation turns since 13 September, only 55 were within the 14-day limit, so 128 were never reviewed.
- **Facts were refused.** The one `learner-v3` run proposed 6 facts and lost 5 to host checks: 3 on negation, 1 on a number and 1 on word overlap. `58a921a` relaxed the negation check and added a retry after that run, but those items were already marked reviewed under the same prompt version, so they would not have been looked at again.
- **One pass over everything.** That run reviewed 40 items in one model call and proposed 11 things.

**Change, prompt `learner-v4`.** Work up to 90 days old is reviewed, oldest first. Each run takes up to 40 tasks and 100 turns, in batches of 10, with each batch kept as it finishes. Items reviewed under `learner-v3` are mined again. Tested in `tests/learning.test.ts`. No migration.

**Review found the wider window had three costs (`7c242bc`), now handled.** Forwarded text was stored as the owner's own until 28 October, so items whose text was stored before 29 October are tagged `possible_forward` and what they produce is `untrusted`. Re-mining could bring back the two lessons retired on 1 November, so keys the owner or a rollback retired are refused and shown to the model. Old work could overwrite newer learned items, so the host refuses a change from work older than the work behind the key's value. A failed batch no longer ends the run, and each model call times out after five minutes.

**Measured.** The counts above, and $0.17 for the 40-item run.

**Hypotheses, not measured.** Smaller batches may find more per item. By proportion, 140 items would cost about $0.60 a night, and the backlog should clear in about two nights. Old lessons may describe failures fixed since, which the owner would prune. More learned items than the prompt budget holds stay reachable through `memory_recall`, but are not in every turn's context. A removed lesson could still return reworded under a new key.

## Procedures replace one-item lessons — 2026-11-01

The owner asked whether the answer to thin memory was looser rules or a different mechanism, because "sometimes the problem is the mechanism".

**Experiment (private and offline; the exported data was deleted and none is recorded here).** Both designs ran over the same 14 days of production conversation, simulated by Claude Opus 5.5 subagents. One blind judge, also Opus 5.5, scored all 83 results shuffled together, with no sign of which design wrote them.

| Measured by the judge                  | One item at a time, loosened     | All 14 days read together |
| -------------------------------------- | -------------------------------- | ------------------------- |
| Saved                                  | 49, of which 10 internal repeats | 34, no repeats            |
| How-to: strongly useful                | 1 of 33                          | 8 of 11                   |
| How-to: clearly backed by the messages | 3 of 33                          | 5 of 11                   |
| Facts: strongly useful                 | 2 of 16                          | 1 of 23                   |
| Facts: clearly backed by the messages  | 13 of 16                         | 6 of 23                   |

Of the 7 most valuable clusters, 5 appeared in both designs and each design alone found 1. So the redesign mostly did not find new things. It expressed how-to knowledge better, while its facts were largely guesses.

**Limits.** One judge from the same model family, one small sample, and simulation rather than the production pipeline. Procedures are longer, which may have favoured them, and whether replies improve was not tested. The first design was given looser rules than production, so its yield does not predict production's.

**Decision (owner, 1 November).** Keep the store, revisions, rollback, nightly job and pgvector. Replace one-item lessons with procedures first. Facts keep the quote, and the idea of allowing implied facts is dropped, because the experiment undercut it. Turning the word-matching refusals into flags is the next step, not in this change.

**Change, prompts `learner-v5` and `procedures-v1`.** The nightly pass saves facts only. A second pass reads two weeks at a time, moving a week per pass, and revises one procedure per kind of work, retiring the lessons each absorbs. See [procedures](../learning.md#procedures). No migration. `learner-v4` is not superseded, because it asked for the same facts. Tested with a fake model in `tests/learning.test.ts`.

**Hypotheses, not measured.** Production procedures may be as useful as the simulated ones, and the two-item rule may keep out one-off rules without losing good ones. By proportion to the $0.17 for 40 items, a window of about 70 items would cost about $0.30, so the windows from 13 September, about six with work in them, would cost about $2 once, then about $0.30 a week. Repeated revision may drift from what the owner wants. Revising in place may lose detail that the `shrunk` flag does not catch.

**Deployment.** Live in `385e0d7` on 1 November. No production pass has run yet, so everything above about procedures is from the simulation and fake-model tests. `learner-v4` never ran either, so the first night is also the first production test of the 90-day batches.

**Accepted risk.** Procedures compete for the prompt's lesson budget, so older ones can be left out of a turn. They are written after reading untrusted content and have no quote check. It stays labelled as data, carries the window's untrusted tags, is threat-scanned and can be rolled back. A permanently failing window stops procedures until it ages out at 90 days. How-to learning now lags by up to about 8 days, and a one-off correction survives only as a quoted fact or by repeating within a window.

**Review.** Independent review (Claude Opus 5.5) requested changes on `8111a1a`, and reproduced four defects in throwaway tests. Revisions dropped earlier untrusted tags, so a rollback by source missed carried-forward text. Older windows could retire lessons from newer work. A procedure outside the `current` limit could be overwritten unseen. A cut-off response advanced the window as if it had been read. It also estimated from the code that input size had no hard limit. All are fixed, with tests. Its next review, of `c04c301`, reproduced a regression from that fix: a complete response ending in plain text failed the window and could stall procedures on a quiet window. Such a response now gets one reminder, and its proposals stand.

## First two nights of procedures, and refusals become flags — 2026-11-03

**Measured in production (counts only; what was saved stays private).** Both nights' passes completed with no failed batch or window.

| Night (03:30 Singapore)       | 2 November | 3 November |
| ----------------------------- | ---------- | ---------- |
| Item pass: items reviewed     | 109        | 91         |
| Facts saved (flagged)         | 7 (6)      | 9 (8)      |
| Fact proposals refused        | 9          | 5          |
| Procedure pass: items read    | 48         | 162        |
| Procedure writes (absorbed)   | 7 (0)      | 11 (2)     |
| Procedure proposals refused   | 4          | 11         |
| Read up to                    | 28 Sep     | 26 Oct     |
| Reported charges, both passes | $0.79      | $1.28      |

After them, 16 learned facts and 10 lessons were active, 9 of them procedures. The charges are what OpenRouter reported. The host's estimates were $9.14 and $12.12, because it reserves before each call.

**What the refusals were.** All 15 refused procedure proposals were over the 800-character limit (809 to 1,231 characters), and the model was told only "Invalid arguments", so it could not tell what to fix. Several saved procedures sit at the limit, cut off mid-sentence. The 13 fact refusals came from the word checks: 8 had under half their words from the quote, 4 had a number the quote lacked (mostly a month and year the model added) and 1 added a negation. Read by me (Claude Opus 5.5), most of the refused facts were better worded than ones that were saved, and every one shared words with its quote. One judge, not blind.

**Change, no prompt or migration change.** A procedure may run to 2,000 characters, and the learned part of each turn's context grows from 12,000 to 30,000 characters so that the longer procedures still fit. A malformed call's refusal now names the failing field and the length sent. A fact still needs the owner's exact words in a cited item and must share at least one content word with them. Everything the word checks refused is now saved and flagged instead. An added number or negation counts as a warning, as do two new flags for an address or link and a payment word the quote lacks; looser wording does not. All 18 word-check refusals in the private record would now be saved, 6 of them with a warning flag. The threat scan's exfiltration pattern now matches any form of the verb ("sends", "sent"), because with one shared word enough, it is the remaining check on a value like "Sends OTP and PIN to Tan". See [host checks](../learning.md#host-checks).

**Hypotheses, not measured.** Longer procedures may hold more of what matters, or may drift and need more pruning. A full context of learned items is about 7,500 tokens a turn, up to about 4,500 more than before, mostly cached. A fact can now carry a name or payee the owner did not say with only routine flags; the review below found this, and it is accepted under "save, prune later". Facts from before this change that were refused are not reviewed again, because the prompt versions are unchanged.

**Review.** Independent review (Claude Opus 5.5) requested changes on `4492e8b`, and reproduced three defects in throwaway tests. The procedure pass was shown only the first 1,000 characters of each procedure, so revising a long one would silently drop the rest; it is now shown whole. One shared word let an invented recipient, address or payment destination save with routine flags only, and the docs no longer said so. Addresses, links and payment words now get warning flags, and the remaining gap for names is documented. The exfiltration pattern missed "shared" and "sharing" and newly flagged harmless text such as "a pin of the restaurant". It also corrected the token estimate and two record wordings. It then approved `a739ab6`, and `67a5d90`, which widened domains to any ending, compared payment words by root and restored plural PINs. File names such as "notes.md" now also raise the contact warning, which is accepted as noise to prune.

**Deployment.** Merged as `d3f1234` (PR 418) and live in `c8f00dc` from 22:05 SGT on 5 November, after an independent review approved the final merge of main (`6db5285`). Its own release run stopped at the current-main check because PR 423 had already landed, and the release of `c8f00dc` carried it. The facts pass first ran under these limits on the night of 6 November. The procedure pass had already caught up on 4 November and runs weekly, so its next window was not due until 11 November; see the next section.

## Re-running one procedure window under the new limit — 2026-11-08

**Measured.** On 4 November, under the 800-character limit, the procedure pass proposed coding, stocks and calendar procedures of 896, 904 and 888 characters. All three were refused as invalid arguments, then resent at 719, 657 and 659 characters and accepted, so each lost about a fifth of its text. On the nights of 5 to 8 November the facts pass read 3, 0, 3 and 1 items and saved 1 fact, on 7 November (flagged `paraphrased`), with no refusals, at under $0.06 a night. The procedure pass did not run, because its next window ends 9 November and must then pass the 24-hour success window.

**Change, a production database write approved by the owner.** There is no manual trigger for the procedure pass. To run the 20 October to 2 November window again under the 2,000-character limit, the `through` value of procedure run `9ec53071` was moved back from `2026-11-02T19:41:01.291Z` to `2026-10-26T19:41:01.291Z` at 17:15 SGT on 8 November. The old value and the reason are kept in that row's summary under `rewound`. No code changed. The night of 9 November should run exactly that one window and return `through` to 2 November, so the weekly window due on 11 November is unchanged.

**Hypothesis, not measured.** With the procedures shown whole and room for 2,000 characters, the pass may restore what the three refusals cut. It may also leave them as they are, since nothing in the evidence has changed. Expected cost is about $0.30, as on 4 November.

**Deployment.** The write is live; the re-run is due on the night of 9 November SGT. Update with what it wrote.

## Follow-up and next iteration

After the phase 1 rollout and this release: check the first night's `learner.finished` counts and charges, and read what it wrote (`memory_revisions` with `origin='learned'`). Phase 3 adds the weekly digest with undo and skills drafted from two independent successes. The owner decided on 29 October not to use reactions or any other manual labelling, so outcomes come only from task proof and corrections in the owner's next message.
