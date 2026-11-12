# 185 — What should happen when the judge finds a fact wrong?

Work date: 2026-11-13 (Singapore). Written: 2026-11-13.
Status: tested on synthetic data; not released. The repair has not run on production, and it cannot run there until the judge has a record against planted errors.

## User-visible problem and preceding iteration

The judge's first run found 12 of 26 learned facts overstated ([journal 181](181-one-request-is-not-a-preference.md)). Those 12 are still in every turn's context. Since then facts are saved with their kind and the judge checks itself with planted errors, a decoy, repeats and a second model ([journal 183](183-can-the-judge-be-trusted.md)), but its verdicts are still read by nobody, and the owner can change memory only through a coding session. This is batch 3 of the review: let verdicts repair memory, let the owner correct memory by saying so, and give pruning something to rank by.

The owner approved building it on 13 November ("go, build batch 3"), having been shown that it lets judge verdicts change memory and adds a memory tool to turns.

## Evidence

- **Measured, 12 November (production, read-only):** 26 facts judged, 12 overstated, 10 of those a single request saved as a standing preference. None unsupported or contradicted.
- **Not measured:** the judge's catch rate on planted errors. The checks went live at 01:47 SGT on 13 November and no night has run with them.
- **Read in the code (`origin/main` at `36aad4f`):** nothing read `judge.fact`. `memory_set` could already overwrite a learned key as the owner's fact, but nothing could retire one in a turn, and the prompt told Chief to save memory only after asking.
- **From the review's research (not independently verified):** products correct memory in conversation ("forget that") and fall back on a list; systems that revise memory automatically archive instead of deleting, cap what one pass may change, and keep a way back.

## Diagnosis and alternatives

- **The repair is a rewrite by the learner's model, not a host edit.** Someone has to write the narrower sentence. The model is shown the fact, the judge's verdict and reason, and the owner's messages, and may rewrite, retire, or keep the fact when it thinks the judge is wrong.
- **The host decides what a rewrite may be.** It must quote the owner from the fact's own messages. It may become a note of one occasion (the usual repair, and a note is out of every turn), or stay in turns as a standing or dated fact only when every word of substance comes from the quote. A note may be reworded but not filled out, and can only stay a note. Only a contradicted fact may be retired: the owner did say something like an overstated one, and an unsupported one may rest on an attachment the repair cannot see.
- **A gate the judge has to earn.** The owner's decision was whether verdicts may change memory at all; the recommendation was yes, once the planted-error tests show the judge catches errors. That condition is in the code: the repair runs only when, over the last 14 days, the judge was shown at least 8 broken copies and 8 controls, caught at least 75% of the broken ones and faulted at most 25% of the controls. The thresholds are a judgement, not a measurement; with about four bases a night the gate cannot open before the second night.
- **Contested verdicts are left alone.** A verdict that a repeat changed, or that the second model answered with "supported", is not acted on.
- **Small and undoable.** Five facts a night, oldest verdict first; each key at most twice; every change a revision of that night's repair run, so one rollback by learner run undoes the night. A retirement by the repair leaves the key open to newer evidence.
- **Rejected: flag instead of rewrite.** A flag changes nothing Chief sees; the overstated preference would still be applied every turn.
- **Rejected: retire overstated facts.** It loses what the owner did say.
- **Correcting in conversation.** `memory_set` on the same key already replaces a fact with the owner's own version. The missing half is forgetting: `memory_forget` retires a key as the owner, which also stops the learner proposing it again. The turn prompt now tells Chief to forget a memory the owner says is wrong, was for one occasion or should go, or to save their corrected version, in the same turn, and to say in a line what changed. No approval is asked, because the owner's message is the instruction.
- **Pruning.** One read-only query ranks every learned item by what is now known about it. No separate retire script: the owner tells Chief to forget a key, and a session on the host would need the owner for a production write anyway.

## Implementation and review

- [src/memory-repair.ts](../../src/memory-repair.ts): limits, the gate, the prompt and tools. [src/learning.ts](../../src/learning.ts): `judgeRecord`, `repairRows`, `repairDue`, `checkRepair`, `runRepair`, and the repair as the night's last pass.
- [src/protocol.ts](../../src/protocol.ts), [src/tools.ts](../../src/tools.ts), [src/tool-domains.ts](../../src/tool-domains.ts), [src/plugins.ts](../../src/plugins.ts): `memory_forget`, a coordinator tool no agent can be granted. [src/context.ts](../../src/context.ts): the sentence on correcting memory.
- [scripts/memory-ledger.sql](../../scripts/memory-ledger.sql): the ledger. [scripts/judge-report.sql](../../scripts/judge-report.sql): the use query counts claims of "contradicted" the host found no proof of.
- [src/memory-judge.ts](../../src/memory-judge.ts): evidence matches whole words (a low note from the review of journal 183).
- Tests ([tests/memory-repair.test.ts](../../tests/memory-repair.test.ts)), scripted models on a test database: the gate; a preference rewritten as a note and restored by one rollback; each refusal and one correction; retire, keep, and a key the owner changed meanwhile; the gate closed, a stale window, a contested verdict and a key at its limit; the repair as the last pass; forget and narrow through the tool; the ledger's ranking.
- Design: [learning](../learning.md#nightly-repair).
- Independent review (Claude Opus 5.5) requested changes on `54f7f1a4`, reproducing two in throwaway tests.
  - Blocking: a `time_bound` rewrite needed only one word of the quote and any end date, so "Prefers aisle seats" could become "Aisle seat on all flights" until 2099, broader than the fault and still in every turn. A fact that stays in turns must now be made only of the quote's words, an end date may be at most a year away, and a note can only stay a note.
  - The check that the key was unchanged ran before the write, in another transaction, so the owner's save in between could be overwritten. Writes and retirements now name the revision they were decided against, checked under the row's lock.
  - Five faulted facts with no messages left came back every night ahead of any that could be repaired. Candidates now need a message still on record.
  - A `one_off` rewrite could invent content from one shared word. It may now be reworded but not filled out.
  - A true fact backed by an attachment looks unsupported, because attachments are cut from what the judge reads, and could be retired with nobody reviewing it. Only contradicted facts are retired now.
  - The prompt turned "that was only once" into a permanent owner fact through `memory_set`. It now says to forget such a memory, and to act only on the owner's own words in the conversation.
  - The docs said a forgotten key could be restored by rollback, which undoes only the learner's revisions. Corrected.
  - The gate and the candidates counted every judge prompt version. Only the current judge's record and verdicts count; older faults are judged again first.
  - Smaller: the repair count was lost on new evidence or a restore; the ledger joined across owners.
- CI failed on `54f7f1a4` for a reason the review did not look at: the new tool and prompt sentence took the coordinator's fixed context from 54,227 to 55,120 characters, past the 54,264 that [tests/context-continuity.test.ts](../../tests/context-continuity.test.ts) pads to, which main was 37 characters under. The sentence was shortened (55,014 now) and the fixture pads to 56,000; those tests need a fixed context of that order, not the incident's exact figure. My local run of related suites had not included that file.

## Verification and outcome

Tested only. A scripted model shows the plumbing and the host's checks, not what a real model writes. Unmeasured until production nights:

- when the gate opens, and whether it stays open;
- what the repair makes of the 12 overstated facts once the current judge has read them again: rewritten, kept or refused;
- whether the judge then calls the rewrites supported;
- whether Chief uses `memory_forget` and the narrowing `memory_set` when the owner corrects it, and only then.

### Release closure

Not released. Pending: independent review, merge, the automatic release, and the first nights.

> **Update, 13 November 2026:** [PR 478](https://github.com/akhilvuputuri/chief-agent/pull/478) merged at the approved head `1b900ea2` as `a869463`, after CI passed. The independent review approved `c292d5e7`, then the merge of main and the context-fixture change at `9d57b767`, then the prompt wording at `1b900ea2`. Release run 43280621237 finished at 02:32 SGT on 13 November; the gateway reported `RELEASE_SHA` `a869463`, healthy, with no error lines in its first minutes. Still pending: the gate opening, the repair's first night, and whether Chief uses `memory_forget` only when the owner asks.

## Follow-up and next iteration

- The repair's model and the judge are the same model, so a rewrite may simply match the judge's taste. The planted errors and the second model's cross-check on facts are the only outside checks.
- Nothing is repaired for procedures: the judge does not check them against their evidence.
- A forgotten procedure key stays forgotten: the procedure pass will not write that kind of work again until the key is restored.
- Batch 4: frame procedures as things to follow, load them by kind of work, and measure whether a memory helped by regenerating a reply without it.
