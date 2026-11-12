# 183 — Can the memory judge be trusted when nobody labels anything?

Work date: 2026-11-13 (Singapore). Written: 2026-11-13.
Status: tested on synthetic data; not released. No production night has run with these checks, so nothing below says how reliable the judge is.

## User-visible problem and preceding iteration

The nightly judge ([journal 157](157-nightly-memory-judge.md)) is the only quality signal on memory, and the next batch of the review would let its verdicts change memory. But the judge has never been checked against anything. Since 11 November it runs on Claude Opus 5.5, the model that writes the facts and the replies it judges ([journal 164](164-claude-models-everywhere.md)). The owner rates nothing, so the usual calibration (compare the judge with human labels) is not available. This is batch 2 of the review; batch 1 is [journal 181](181-one-request-is-not-a-preference.md).

## Evidence

Measured on production, 12 November 2026 (the judge's first run, read-only):

- 26 facts judged: 14 supported, 12 overstated. 30 turns judged: a memory was relevant in 2.
- No turn verdict was `unclear`, on 3 uses in all. Too few to say whether hidden tool arguments are a problem in practice.

Read in the code (`origin/main` at `e65e13e`):

- The turn judge saw each call's name and state only, the final reply, and nothing of the exchange before or after.
- A `followed` or `contradicted` verdict needed no evidence.
- Memories reached the judge sorted by key, so the same items always came first.
- One pass, one model, no repeat.

From the review's research pass (sources in its notes, not independently verified): LLM judges are known to favour their own model's output, to be sensitive to position, and to give different verdicts on a repeat. Every vendor's judge-calibration feature found needs human labels. Two label-free methods were recommended independently by the code audit and the evaluation-tools research: plant errors whose right verdict is known because the host made them, and compare repeated verdicts.

## Diagnosis and alternatives

- **Planted errors (fact judge).** Each night the host takes up to three facts the judge has called supported and makes copies broken in fixed ways: negated ("It is not true that: …"), an invented detail appended, another fact's messages, and for a note, the occasion worded as a standing rule. Beside each goes an unchanged copy. The right answer is known without anyone labelling: a broken copy should not be supported, a control should. They are judged in a batch of their own and never stored. Limit: the edits are crude, so a judge that catches all of them may still miss subtler overstatement; and a base the judge wrongly called supported makes a bad control.
- **A planted decoy (turn judge).** One of three fixed, plausible memories about nothing in the owner's life is added to each batch of turns. Calling it relevant is a judge error. It is counted and stripped before anything is recorded.
- **Evidence for a claim of use.** `followed` and `contradicted` need a quote, and the host checks the quote is in the reply or a call. This cannot prove the verdict right, but it stops one made from nothing. `ignored` and `unclear` assert an absence and need none.
- **More to see.** Each call's input and result, cut short and scrubbed; the exchange before the turn; the owner's next message and how the turn loop read it. A procedure about how to call a tool could otherwise only be judged `unclear`.
- **No position.** Memories are shuffled per batch by a hash, so an item's place says nothing.
- **Repeats and a second model.** A few of the night's facts and turns are judged again: twice by the same model and once by a model of another family. Disagreement is recorded, and the recorded verdict stays the first pass's. Alternative considered: move the judge back to another family. Rejected: the owner chose Opus 5.5 for it on 11 November; a cross-check on a sample keeps that choice and still measures how much the choice matters.
- **Restated.** The judge also lists memories whose content the owner had to tell Chief again. That is a direct sign a memory in context is not being used.
- **Rejected: human spot-checks.** The owner-experience research suggested one hand check of the judge. The owner will not label, and planted errors answer the same question each night.

## Implementation and review

- [src/memory-judge.ts](../../src/memory-judge.ts): `judge-v3` prompt; `evidence` and `restated` on `judge_turn`; `shownInTurn`; `shuffled`; `DECOYS`; `factProbes`; `turnSignature`.
- [src/learning.ts](../../src/learning.ts): a judged turn's call digests, previous exchange, next message and redirect; the decoy and the shuffle; `calibrate` (probes, repeats, the second model), which runs after the night's verdicts are recorded and cannot fail the run.
- [src/model-policy.ts](../../src/model-policy.ts), [config/model-policy.json](../../config/model-policy.json): `judgeSecond`, `openai/gpt-6.1-sol`, through OpenRouter, inside the price ceilings. `model.routes` logs its route at startup.
- [scripts/judge-report.sql](../../scripts/judge-report.sql): four more read-only queries (probes, decoys, repeat checks, restated).
- Tests ([tests/memory-judge.test.ts](../../tests/memory-judge.test.ts)), scripted models on a test database: the evidence check; what a turn shows; decoy counted and stripped; how probes are built; a full night with probes, two repeats and a second model that disagrees; a failing check leaving the night completed; the report queries.
- A test found one defect before review: cutting a call's whole result to a length let one long field crowd out the short ones. Each field is cut first now.
- Design: [learning](../learning.md#nightly-judge), dated note of 13 November.
- Independent review: pending.

## Verification and outcome

Tested only. The scripted judges return what the tests tell them to, so the tests show the plumbing and the host checks. Unmeasured until production nights:

- how many planted errors the judge catches, by kind, and how often it faults a control;
- how often it calls a decoy relevant;
- how often a repeat or the second model disagrees;
- whether `openai/gpt-6.1-sol` returns well-formed tool calls through Chief's OpenRouter adapter (it has not run there);
- the cost of the extra calls: one probe batch and up to three check passes a night.

The counts will be small: about three bases a night and six items judged again.

### Release closure

Not released. Pending: independent review, merge, the automatic release, and the first nights.

## Follow-up and next iteration

- Read a week of probe, decoy and repeat counts before deciding whether verdicts may narrow overstated facts (batch 3, the owner's decision).
- If the judge catches the crude probes easily, add subtler ones built from the learner's own overstated facts.
- Measure whether a memory helped, by regenerating a reply without it (batch 4).
