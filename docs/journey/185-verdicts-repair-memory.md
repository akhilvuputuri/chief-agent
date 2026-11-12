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
- **The host decides what a rewrite may be.** It must quote the owner from the fact's own messages. It may become a note of one occasion (the usual repair, and a note is out of every turn), a fact with an end date, or stay standing only when every word of substance comes from a quote in which the owner speaks generally. A note or dated fact may claim no habit. An overstated fact may not be retired, since the owner did say something like it.
- **A gate the judge has to earn.** The owner's decision was whether verdicts may change memory at all; the recommendation was yes, once the planted-error tests show the judge catches errors. That condition is in the code: the repair runs only when, over the last 14 days, the judge was shown at least 8 broken copies and 8 controls, caught at least 75% of the broken ones and faulted at most 25% of the controls. The thresholds are a judgement, not a measurement; with about four bases a night the gate cannot open before the second night.
- **Contested verdicts are left alone.** A verdict that a repeat changed, or that the second model answered with "supported", is not acted on.
- **Small and undoable.** Five facts a night, oldest verdict first; each key at most twice; every change a revision of that night's repair run, so one rollback by learner run undoes the night. A retirement by the repair leaves the key open to newer evidence.
- **Rejected: flag instead of rewrite.** A flag changes nothing Chief sees; the overstated preference would still be applied every turn.
- **Rejected: retire overstated facts.** It loses what the owner did say.
- **Correcting in conversation.** `memory_set` on the same key already narrows a fact as the owner's own. The missing half is forgetting: `memory_forget` retires a key as the owner, which also stops the learner proposing it again. The turn prompt now tells Chief to do either at once when the owner says a memory is wrong, was for one occasion or should go, and to say in a line what changed. No approval is asked, because the owner's message is the instruction.
- **Pruning.** One read-only query ranks every learned item by what is now known about it. No separate retire script: the owner tells Chief to forget a key, and a session on the host would need the owner for a production write anyway.

## Implementation and review

- [src/memory-repair.ts](../../src/memory-repair.ts): limits, the gate, the prompt and tools. [src/learning.ts](../../src/learning.ts): `judgeRecord`, `repairRows`, `repairDue`, `checkRepair`, `runRepair`, and the repair as the night's last pass.
- [src/protocol.ts](../../src/protocol.ts), [src/tools.ts](../../src/tools.ts), [src/tool-domains.ts](../../src/tool-domains.ts), [src/plugins.ts](../../src/plugins.ts): `memory_forget`, a coordinator tool no agent can be granted. [src/context.ts](../../src/context.ts): the sentence on correcting memory.
- [scripts/memory-ledger.sql](../../scripts/memory-ledger.sql): the ledger. [scripts/judge-report.sql](../../scripts/judge-report.sql): the use query counts claims of "contradicted" the host found no proof of.
- [src/memory-judge.ts](../../src/memory-judge.ts): evidence matches whole words (a low note from the review of journal 183).
- Tests ([tests/memory-repair.test.ts](../../tests/memory-repair.test.ts)), scripted models on a test database: the gate; a preference rewritten as a note and restored by one rollback; each refusal and one correction; retire, keep, and a key the owner changed meanwhile; the gate closed, a stale window, a contested verdict and a key at its limit; the repair as the last pass; forget and narrow through the tool; the ledger's ranking.
- Design: [learning](../learning.md#nightly-repair).
- Independent review: pending.

## Verification and outcome

Tested only. A scripted model shows the plumbing and the host's checks, not what a real model writes. Unmeasured until production nights:

- when the gate opens, and whether it stays open;
- what the repair makes of the 12 overstated facts: rewritten, kept or refused;
- whether the judge then calls the rewrites supported;
- whether Chief uses `memory_forget` and the narrowing `memory_set` when the owner corrects it, and only then.

### Release closure

Not released. Pending: independent review, merge, the automatic release, and the first nights.

## Follow-up and next iteration

- The repair's model and the judge are the same model, so a rewrite may simply match the judge's taste. The planted errors and the second model's cross-check on facts are the only outside checks.
- Nothing is repaired for procedures: the judge does not check them against their evidence.
- A forgotten procedure key stays forgotten: the procedure pass will not write that kind of work again until the key is restored.
- Batch 4: frame procedures as things to follow, load them by kind of work, and measure whether a memory helped by regenerating a reply without it.
