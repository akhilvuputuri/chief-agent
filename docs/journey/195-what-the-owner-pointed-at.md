# 195 — May a fact name what the owner only pointed at?

Work date: 2026-11-13 (Singapore). Written: 2026-11-13.
Status: tested on synthetic data; not released. No night has run with it.

## User-visible problem and preceding iteration

The first night under the fact kinds, the judge's self-checks and the gated repair ([journal 181](181-one-request-is-not-a-preference.md), [183](183-can-the-judge-be-trusted.md), [185](185-verdicts-repair-memory.md)) saved one new fact, correctly as a note of one occasion. The judge then called that note overstated. The owner had asked Chief to check whether "this" worked; the note named the thing. The learner knew what "this" was because it reads the whole turn. The judge is shown the owner's cited messages and nothing else, so to it the name was an added detail. The repair, once its gate opens, is told to take out every detail the owner's messages do not state, which would have left a note that says the owner asked for a check of "this".

The owner asked how this happens and then for research into how other memory systems handle it. They approved building the first step of the resulting plan on 13 November ("go"): store a fact as the owner's claim plus labelled context, adopt a measured prompt rule against inferring preferences, have the repair turn a wrongly promoted fact into a note, and raise reasoning effort on the judge and the repair. Tightening the repair gate was offered as a separate step and was not approved, so it is unchanged.

## Evidence

- **Measured, 13 November (production, read-only), the first night under `learner-v6` and `judge-v3`:**
  - The learner saved 1 note and recorded a second day for 1 standing fact. No new standing fact.
  - The judge read 13 facts and called all 13 overstated: the 12 it had faulted before, again, and the new note.
  - Planted errors: 4 of 4 caught. Controls: 1 of 4 wrongly faulted. Repeats: 6 of 6 the same. The second model found a fault in 3 of 3 and named a different kind for one. Decoy: 0 hits in 30 turns.
  - By the judge's own reasons, about 4 of the 13 faults name a detail the owner's message lacks, and about 9 are one request saved as a standing preference. This is a reading of its reasons, not a check against the turns.
  - Judge cost for the night: $0.68, of which $0.005 was the second model. Learner: $0.08.
- **Read in the code (`origin/main` at `7642fae2`):**
  - The learner's prompt said to add no detail from Chief's reply. It did so anyway, and the host flagged the result (`paraphrased`, `loosely_quoted`) but accepted it.
  - `judgeMessages` gave the judge and the repair the owner's words only.
  - The repair accepted a standing rewrite only if its quote showed the owner speaking generally, even for a fact seen on two days.
  - The learner, the judge and the repair all ran at `medium` reasoning effort.
  - `jsonSchema` drops every `describe()` text and every array limit from a tool's parameters, so the model learns a tool's fields from their names and from the instructions only.
- **From research (six Opus agents, 13 November; the orchestrator checked the items marked "verified" against primary sources):**
  - Hermes Agent added a rule to its memory prompt on 1 November 2026: never infer traits, and never turn a one-off request into a standing preference unless the user marked it general or stated a like or dislike. Its own A/B on a deliberately weak model, 4 transcripts by 3 runs: a one-off "make that shorter" was saved as a preference 3 of 3 times before and 0 of 3 after, with stated facts still saved 3 of 3 (verified, PR 80788 of that project).
  - Leon rejects a memory whose quoted evidence is not in the user's message and tells its extractor that assistant text is context, not evidence (verified in its source).
  - Honcho requires at least two source observations before it records a pattern (verified), and treats the details of a proposal as stated by the user only when the user accepted it. MemOS ties reuse to the scope the user expressed (verified).
  - Claim-extraction work in fact-checking adds context to a claim only when the source states it, and keeps it apart from the claim: in brackets, or in its own field that is verified separately. These figures were read through a page-summarising tool and not re-checked.
  - No surveyed system re-checks stored facts with a judge or plants errors to test one.

## Diagnosis and alternatives

- **The fault is in what the judge is shown, not in its judgement.** Read against the owner's message alone, the name of the thing is an addition. A stronger model would reach the same verdict from the same input.
- **Banning the detail makes the note useless; trusting Chief's side lets anything in.** Chief's reply can repeat an email, a web page or a tool result. The rule taken from the research separates two things. What the owner was referring to may come from the exchange. What the owner wants, likes, usually does or believes must be in the owner's own words.
- **Brackets in the value, and what they rest on beside it.** A detail the owner did not spell out goes in `[square brackets]` in the value, and `source.context` holds, for each, exact words of the exchange and whose they were. The host checks both when the fact is written, so the judge does not have to take the learner's word for it.
  - Alternative considered: a separate `claim` field and no brackets. Every reader of a value (turns, `memory_list`, the judge, the ledger) would need the second field to make sense of it. Brackets keep one string and still mark what is not the owner's.
  - Alternative considered: only change the judge's prompt and inputs. Nothing would then stop the learner writing a preference from Chief's words, and the judge would be the only check on it.
- **The judge and the repair read Chief's side.** Beside each cited message they see the end of what Chief said just before it, where a question or proposal sits, and the start of Chief's reply, cut as the learner read it. An owner who answers "yes" or picks an option takes on the details of the proposal; "ok", "thanks" or silence takes on nothing.
- **The second model still reads the owner's words only.** Chief's replies can carry tool content, which stays with the judge's own provider. A fact whose brackets rest on Chief's words is left out of the cross-check, since it cannot be judged fairly from the owner's words alone.
- **A planted error for the door this opens.** A copy of a supported fact that quotes Chief's reply and says the owner told Chief so. A judge that lets Chief's words stand as the owner's will call it supported.
- **The repair counts days as the learner does.** A fact seen on two separate days may stay standing in the owner's words. Before, the repair had to turn it into a note, which takes a repeated choice out of every turn.
- **Effort.** `high` on the judge and the repair, which judge and are small. The learner stays at `medium`. A stronger model was considered and deferred by the owner; it would not have fixed the input.
- **Not done here:** the repair gate still opens at 8 broken copies and 8 controls. Six of eight caught is consistent with a true catch rate anywhere from about 41% to 93%. The owner has been told and has not decided.

## Implementation and review

- [src/learning.ts](../../src/learning.ts): `bracketed`, `claimOf`, `contextProblem`, `placeContext`, `contextFlags`; `learn_fact` takes `context`; the quote checks and flags apply to the claim without its brackets; `source.context`; `chiefSides` and Chief's side on `judgeMessages`; `learner-v7`; effort.
- [src/memory-judge.ts](../../src/memory-judge.ts): `judge-v4`, `FactContext`, `JudgeMessage`, `ownerOnly`, `restsOnChief`, the `chief_words` planted error. [src/memory-repair.ts](../../src/memory-repair.ts): `repair-v2`, `context` on `repair_fact`.
- [src/memory.ts](../../src/memory.ts): `chief_context` is a routine flag; a restored fact keeps its context. [src/context.ts](../../src/context.ts): a turn is told what square brackets mean, only when a learned item in view has some.
- [scripts/judge-report.sql](../../scripts/judge-report.sql): the decoy query no longer counts turns judged before decoys existed, which had doubled the first figure read from it (60 for 30).
- Tests, scripted models on a test database: [tests/learning-durability.test.ts](../../tests/learning-durability.test.ts), [tests/memory-judge.test.ts](../../tests/memory-judge.test.ts), [tests/memory-repair.test.ts](../../tests/memory-repair.test.ts), [tests/memory.test.ts](../../tests/memory.test.ts).
- Design: [learning](../learning.md#host-checks), with notes under the judge and the repair.
- The examples in tests, prompts and comments are invented. The owner's message that showed the problem is not in the repository.

## Verification and outcome

Tested only. A scripted model shows the plumbing and the host's checks, not what a real model writes. Unmeasured until production nights:

- whether the learner uses brackets when the owner points at something, and only then;
- what `judge-v4` says of the 13 faulted facts, which it reads again because its prompt changed;
- whether the judge still catches planted errors with Chief's side in view, the new kind included, and how often it now faults a control;
- what the repair writes once its gate opens. A new judge prompt starts with no record, so the gate cannot open before the judge's second night under `judge-v4`;
- the cost of `high` effort and the longer inputs.

### Release closure

Not released. Pending: independent review, merge, the automatic release, and the first nights.

## Follow-up and next iteration

- The gate decision above.
- Chief's reply is cut at 2,000 characters and the previous one at its last 1,000, so what the owner pointed at can fall outside both. A tracked task has no Chief's side.
- The host checks that a bracketed detail's words are in its quote, not that the detail is what the owner meant. That is left to the judge.
- A habit word is the only test for "a want" in brackets. A want worded without one is not caught by the host.
- Parameter descriptions never reach a model. Whether to send them is a separate question for every tool.
- The rest of the plan from the research: a small always-loaded core with procedures loaded by kind of work, procedures as numbered rules edited one at a time with a replay check, and retiring unused items to an archive.
