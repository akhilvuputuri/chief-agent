# 157 — Is the memory right, and is it used?

Work date: 2026-11-10 (Singapore). Written: 2026-11-10.
Status: tested on synthetic data; not released. No production judge run exists yet, so nothing below says how good the memory is.

## User-visible problem and preceding iteration

The owner described the loop they care about as trace → distilled memories → use of those memories in daily turns, and asked how it was going. The first two stages run ([journal 130](130-nightly-learner.md)): a nightly pass saves quoted facts, a weekly pass rewrites one procedure per kind of work, and since 5 November word-check refusals are flags. Since [journal 153](153-memory-transparency.md) every turn's context is recorded and exported. What was missing is any check of the two things that decide whether the loop is worth having: whether a saved fact means what the owner said, and whether a memory in context changes what Chief does.

The owner rates nothing (29 October), so the check has to be automatic.

## Evidence

Measured on production on 10 November 2026, read-only, by SQL over `learner_runs`, `events`, `memory_revisions`, `memory_context` and `provider_charges`:

| What                                              | Value                                  |
| ------------------------------------------------- | -------------------------------------- |
| Learned items in force                            | 20 facts, 10 lessons (9 procedures)    |
| Owner and imported facts in force                 | 10                                     |
| Memory in each turn's context                     | 14,342 characters, nothing left out    |
| Turn contexts recorded since 29 October           | 56, of which 54 are owner turns        |
| Learned facts carrying the `paraphrased` flag     | 19 of 20                               |
| Fact proposals, all nights                        | 21 accepted, 18 refused by word checks |
| Procedure proposals, all nights                   | 23 accepted, 18 refused for length     |
| Refusals since the 5 November change              | 0 (3 facts and 2 procedures accepted)  |
| Actual provider charges, every learner run so far | $3.10 (estimates summed to $27.52)     |

- **Not measured anywhere.** Whether any of the 20 facts is wrong in meaning. The host checks compare words; "Prefers window seats" from "I prefer aisle seats" passes them ([learning](../learning.md#host-checks)).
- **Not measured anywhere.** Whether a memory in context was relevant to a turn or followed. `memory_context` records presence and claims nothing more.
- **A flag with no signal.** With 19 of 20 facts `paraphrased`, the flag cannot rank what to prune.
- **Earlier, offline.** One judge over 14 simulated days found procedures clearly useful 8 times in 11 and one-item lessons 1 in 33 (journal 130). That was before production and has not been repeated.

## Diagnosis and alternatives

- **A judge inside Chief, not in agentwatch.** agentwatch already judges each turn (`answer_ok`, [tracing](../tracing.md#judging-traces)), but from one trace's question and answer. Checking a fact needs the owner's message it cites, and checking use needs the memory items by revision; both are in Chief's database. So the judge is a third pass of the nightly learner, with the same ledger, deferral and cost record.
- **A different model family.** The main model and the learner are both Claude Opus 5.5, so a judge on the same model would grade its own replies and its own facts. The judge runs on `openai/gpt-6.1-sol`, the model agentwatch's judge already uses with the same key, at $2 and $10 a million tokens against ceilings of $4 and $20 (OpenRouter's public price list, read 10 November).
- **Measure, do not act.** The judge writes verdicts and nothing else. Letting it flag or retire would put an unmeasured model in charge of memory; whether its verdicts agree with the owner is unknown. Acting on them is a later decision, with a week or two of verdicts to read first.
- **Relevance before use.** All memory goes into every turn, so most items are irrelevant to most turns. The judge lists only the relevant ones and says how each was used; a key that is never relevant is then visible as cost without benefit.
- **No new table.** Verdicts are `judge.fact` and `judge.turn` rows in `events`, and progress is two marks in the run's summary, as the procedure pass keeps its own. A migration would need an operator rollout for a measurement that may change shape.
- **The whole message, not the quote.** A revision stores the IDs of the messages its quote was found in, not the quote. The whole message also shows whether the words were the owner's.
- **Rejected: a deterministic usage signal.** Word overlap between a reply and a memory would count topic matches as use and miss a procedure followed through tool calls.

## Implementation and review

- [src/memory-judge.ts](../../src/memory-judge.ts): the prompt, the three tools, the checks on what the model returns and the per-turn score. [src/learning.ts](../../src/learning.ts): the judge runs after the item and procedure passes, gathers facts and turns, and records verdicts. [src/otel.ts](../../src/otel.ts): `memory_relevant` and `memory_followed` evaluations on the judged turn's own trace. [src/model-policy.ts](../../src/model-policy.ts) and [config/model-policy.json](../../config/model-policy.json): the `judge` model. [scripts/judge-report.sql](../../scripts/judge-report.sql): four read-only queries.
- Tests ([tests/memory-judge.test.ts](../../tests/memory-judge.test.ts)), with a scripted model on PGlite: the checks on judgements; a full pass over facts and turns, including a fact with no source, a turn with no reply and a turn still inside the success window; the reminder and `missed`; deferral when the owner writes; a failed call keeping earlier batches; the order of a night's passes; the judge's own model; the exported evaluations; the log line; and the report queries.
- A test caught one defect before review: a turn listed its memory IDs in the order the context was recorded, which differs between runs. They are now listed in the batch's order.
- Design: [learning](../learning.md#nightly-judge), [tracing](../tracing.md#memory-use).
- Independent review (Claude Opus 5.5) requested changes on `a223976`, and reproduced one defect in a throwaway test.
  - Blocking: a batch the model could not answer in the tools (no tool calls, malformed or cut-off arguments) had every item recorded `missed` and the mark moved past it, so a model that fails on the first night would have used up the backlog with no verdicts. Now a batch with no verdict at all fails the run and is read again.
  - Items written in the same instant at a batch boundary: the mark compared time only, so the second was skipped (reproduced with 41 facts). Marks are now time and ID.
  - A turn still running a day later was passed over without a record. It is now read as it stands, usually `skipped`.
  - A night on which the item pass or due procedure windows are deferred three times has no judge run. Documented.
  - docs/tracing.md said the judge's keys and reasons stay in Postgres; with message content captured, its own trace holds its prompt and reasons. Corrected, and the agent list now names `judge`.
  - Low: message lookups compared IDs as text and could not use the primary keys; they now compare uuids, after dropping malformed IDs. The report joins revisions by owner too. "0 is the usual value" was a guess and is gone.

## Verification and outcome

Tested only. The scripted model returns whatever the test tells it to, so the tests show the plumbing and the host checks, not the quality of a real judge's verdicts. Unmeasured until the first production nights: how many facts each verdict gets, how often any memory is relevant, how much of the turn judging comes back `unclear` because tool arguments are hidden, the cost of a night, and whether `openai/gpt-6.1-sol` returns well-formed tool calls through Chief's adapter.

The first night has a backlog: 20 facts and about 54 turns, so 30 turns on the first night and the rest on the second.

### Release closure

Not released. Pending: independent review, merge, the automatic release, and the first judge run.

## Follow-up and next iteration

- Read the first week of verdicts with the report, and spot-check a sample by hand once to see whether the judge can be trusted.
- If most turn verdicts are `unclear`, show the judge tool arguments or results for the calls a procedure concerns.
- Only after that: decide whether an `unsupported` or `contradicted` fact should carry a warning flag, and whether keys that are never relevant should be left out of turns.
- The judge does not check procedures against the work they were written from.
