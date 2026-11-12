# 181 — Why did half the learned facts overstate what the owner said?

Work dates: 2026-11-12 to 2026-11-13 (Singapore). Written: 2026-11-13.
Status: tested on synthetic data; not released. Whether it lowers the overstated share is unmeasured until the judge has read facts written under `learner-v6`.

## User-visible problem and preceding iteration

The nightly judge ([journal 157](157-nightly-memory-judge.md)) ran for the first time on the night of 12 November. Of the 26 learned facts it read, it found 12 overstated. The owner then asked for a review of the whole loop (trace, distilled memory, use in turns); this entry is the first batch of what that review recommended, the part aimed at the one failure that was measured.

## Evidence

Measured on production, read-only, 12 November 2026 (the judge's own records in `events`, on Claude Opus 5.5):

| What                                                      | Value                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| Learned facts judged against the owner message they cite  | 26: 14 supported, 12 overstated, 0 unsupported or contradicted |
| Overstated because one request or question became a habit | 10 of the 12                                                   |
| Overstated because a detail was added                     | 2 of the 12                                                    |
| Turns judged (29 October to 1 November)                   | 30; a memory was relevant in 2                                 |
| Learner labels to date                                    | 143 success, 23 pitfall, 63 skipped                            |

Caveats: the judge shares a model with the learner and has not been calibrated, so "overstated" is its reading, not ground truth. The reasons it gave were read by hand once for this entry and are consistent: "a one-off request is turned into a standing rule" and close variants.

Read in the code (`origin/main` at `2910171`):

- The fact prompt (`learner-v5`) said to "err toward saving" and never separated a request from a preference. Chief's own in-turn memory offer does ("not a one-off detail", `src/context.ts`).
- The host's word check counts `prefers`, `likes`, `wants`, `usually`, `always` and `often` as framing (`FRAMING`), so "Book me an aisle seat" saved as "Prefers aisle seats" raised no flag.
- An unchanged value was not rewritten, and a revision cited only the messages of its own batch. A fact seen on five days looked the same as one seen once, and one promoted on its second sighting would have been judged on one message.
- The owner's next message reached the learner only when a keyword rule called it a correction. The turn loop's richer redirect signal (retry, rephrase, pushback) went to trace export only.

From the review's research pass (sources in the notes; not independently verified beyond the first): mem0's published extraction prompt separates a transient request from a persistent detail and records trials; Letta's reflection prompt says to skip the ephemeral and prefer patterns across sessions; OpenClaw promotes a note only past recurrence gates. No system found requires repeated evidence before saving at all, which matches the owner's wish that memory accumulate.

## Diagnosis and alternatives

- **Label, do not drop.** Each fact now says what kind of statement it is: `standing`, `one_off` or `time_bound`. A request is saved as a past-tense note of the occasion. Saving less would lose the first sighting that a later repeat needs.
- **Notes stay out of every turn.** A note is memory (listed, recalled, rolled back, shown to the learner), but `MemoryStore.select` does not put it in a turn's context. A single request read as a rule is the failure being fixed, and the judge found memory relevant to few turns as it is. Alternative considered: a separate "single occasions" group in every turn. Rejected for now because the list would grow with every request; relevance selection is a later batch.
- **A repeat on another day is the promotion.** The learner sees the note with its day and, when another day shows the same choice, revises the key as standing. Support is carried across revisions, so the host can tell one day from two.
- **Flag what the label does not catch.** A standing fact on one day's evidence is flagged `habitual_framing` when its wording adds a habit word the quote gives no general basis for, and `quoted_question` when the quote is a question. Refusing was rejected: the owner's rule is flag, never block. They do not make a turn's log line a warning (see the review below).
- **End dates.** "This week" was saved like any preference. A `time_bound` fact carries its last day and is retired, as a revision, on the night after.
- **Use the signals already collected.** The redirect is now stored on the turn it redirects, and the learner labels that turn a pitfall. The owner's next message is shown beside a turn, unless it is already there as a correction or the item is over its size limit.
- **The judge has to know.** A note judged as a preference would be "overstated" by definition, and a promoted preference judged on one message likewise. `judge-v2` is told a fact's kind, sees every supporting message with its day, and counts a preference as supported when separate days show it. This changes the judge at the same time as the learner, so the before and after shares are not strictly comparable; the definition of overstated for a single request is unchanged.

Not done here, on purpose: nothing rewrites the 12 existing overstated facts (that is the batch that lets verdicts repair memory, and needs the owner's decision), and the judge still does not read Chief's reply or the next message beside a fact.

## Implementation and review

- [src/learning.ts](../../src/learning.ts): `learner-v6` prompt and `learn_fact` schema (`durability`, `until`); host checks on `until`; `durabilityFlags`; `mergeSupport` and the stored `support`, `seenDays` and `quote`; a same-value proposal from a new day is written as a `reinforced` revision; `expire`; the redirect and `ownerNext` in a turn's evidence; `labelTurn` counts a redirect as a pitfall.
- [src/memory.ts](../../src/memory.ts): `isNote`; `select` leaves notes out; a learned item's `until` reaches the turn; a rollback's restored copy keeps the original's kind and support.
- [src/agent.ts](../../src/agent.ts): the redirect is computed whether or not tracing is on, and stored as a `turn.redirect` event on the turn it redirects.
- [src/memory-judge.ts](../../src/memory-judge.ts): `judge-v2`.
- Tests: [tests/learning-durability.test.ts](../../tests/learning-durability.test.ts) (flags, support, note then promotion then rollback, reinforcement, end dates and expiry, redirect labels), one judge test, one agent-level test of the stored redirect. A scripted model shows the plumbing and the host checks, not what a real model does with the new prompt.
- Design: [learning](../learning.md), dated notes of 13 November.
- Independent review (Claude Opus 5.5) requested changes on `dcfd0f59`, reproducing each in a throwaway test.
  - Blocking: a `one_off` proposal under a key holding a standing preference was written, turning the preference into a note and dropping it from every turn; the prompt's own wording made that likely. The host now refuses it, and the prompt says so.
  - A note could be made standing by a second message on the same day, which only the prompt forbade. The host now requires a second day or a quote in which the owner speaks generally.
  - `habitual_framing` missed "Wants aisle seats", the motivating case, and flagged "Would like a refund". "wants", "needs" and "would rather" are habit words now, and "would like" is not.
  - Support was carried over when a value changed, so "Prefers window seats" replaced by "Prefers aisle seats" counted two days and showed the judge the window message. Support now carries only for the same value or a promotion.
  - Undoing an expiry lasted one night, because the restored copy kept its end date. It is now restored without it.
  - The two new flags were warnings, which would have marked most turns' `memory.selected` lines for as long as a fact was never repeated. They are routine flags now, still named for pruning.
  - Review of `9a207dae` found the same gap one step over: a `time_bound` exception ("a window seat for this trip") under a standing preference's key was accepted, and its expiry then left the key with nothing. The host now refuses that too.
  - Smaller: the prompt said "nearly half" of facts turned a request into a habit (it was 10 of 26; nearly half were overstated in all); a failed run could lose its expiry count; the unchanged check compared day counts, which stop at the limit.

## Verification and outcome

Tested only. Unmeasured until production nights under `learner-v6`:

- the overstated share among new facts;
- how many notes a week the learner writes, and whether it writes notes for plain errands despite the prompt;
- how often a repeat is noticed and promoted;
- how often the new flags fire, and whether flagged facts are the ones the judge calls overstated;
- whether redirect pitfalls change what is learned.

At about five owner turns a day these will take weeks to read.

### Release closure

Not released. Pending: independent review, merge, the automatic release, and the first nights.

## Follow-up and next iteration

- Batch 2 of the review: planted-error tests for the judge, and a judge that sees more (tool arguments, the previous exchange, the next message).
- Batch 3: let verdicts narrow overstated facts (owner decision), a usefulness tally per item, and correcting memory in conversation.
- A habit worded without a habit word ("Checks NLB for ebooks") passes the host; only the label and the judge catch it.
- Work is dated by UTC day and end dates by Singapore day, so an end date worked out from an early-morning message can be a day early, and a fact can stay in turns for up to a day after its last day.
- Untested: a run that fails after it has already retired expired facts.
- Notes accumulate without limit. They cost nothing in turns, but the learner's view of current memory is bounded at 40,000 characters, so old notes will eventually fall out of its sight, newest kept.
