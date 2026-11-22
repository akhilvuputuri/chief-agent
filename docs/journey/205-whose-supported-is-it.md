# 205 — Why did the judge fault its own controls?

Work date: 2026-11-22 (Singapore). Written: 2026-11-22.
Status: tested on synthetic data; not released.

## User-visible problem and preceding iteration

[Journal 195](195-what-the-owner-pointed-at.md) let a fact name what the owner pointed at and showed the judge Chief's side of each exchange. It went live on 13 November. This entry reads its first production nights and fixes three things they showed. The owner was given the first night's reading on 17 November with three proposed fixes and approved them ("Go"). The nights after that confirmed one of the three with numbers and corrected a prediction made that day: the repair was said to be unlikely to start soon, and it ran the next night.

The symptom is in the judge's test of itself. Each night it is shown unchanged copies of facts it has called supported (controls), and should call them supported again. It faulted 6 of 16. The repair's gate allows at most a quarter, so the gate opened for one night and closed again, with five overstated facts still in every turn.

## Evidence

All measured on production, read-only, between 14 and 22 November 2026. No message text or fact key is reproduced here.

- **Nights.** The judge ran on 14, 17, 18 and 19 November. It did not run on 15, 16, 20, 21 or 22 November: the owner sent nothing on 13 and 14 November and little afterwards, so those nights had no new fact and no turn past its 24-hour window.
- **The change of journal 195, first night (14 November).** 15 facts judged, 6 supported and 9 overstated. Of the 13 that `judge-v3` had faulted, 4 became supported with Chief's side in view, and the judge's reasons cite Chief's earlier message for what the owner referred to. One fact of that kind stayed overstated because its detail was Chief's words about where something was, not the owner's. Both new notes were supported.
- **Planted errors, four nights.** 16 of 16 broken copies caught: 8 given another fact's messages, 3 negated, 2 with an invented detail, 3 passing Chief's words off as the owner's.
- **Controls, four nights.** 16 shown, 6 faulted. Split by who had last judged the base fact:
  - judged by `judge-v4` itself: 5 controls, 0 faulted;
  - judged only by `judge-v1`, the first prompt, on 12 November: 11 controls, 6 faulted. One such fact was faulted on both nights it was drawn, another on both of its nights.
- **Repeats and the second model.** Facts: 6 of 6 repeated the first verdict, and the second model agreed on 6 of 6. Turns: 3 of 12 repeats differed from the first pass.
- **Turns.** 27 judged; 36 uses of a relevant memory, 32 followed, 1 ignored, 3 unclear.
- **The gate and the repair.** After the third night the record was 12 broken copies caught and 3 of 12 controls faulted, exactly the quarter allowed, and the repair ran on 18 November: 5 candidates, 4 rewritten, 1 left after two refused attempts. Three became notes of one occasion; one stayed standing, cut down to the owner's own sentence. The host refused 3 proposals: a standing rewrite carrying a bracketed detail from Chief's words, and two that added to what the owner said. One note keeps a bracketed detail resting on Chief's words. The judge called all 4 rewrites supported the next night. After that night the record was 6 of 16 controls faulted and the gate closed.
- **Where the facts stand.** 31 learned facts: 12 supported and 5 overstated by `judge-v4`, and 14 whose only verdict is `judge-v1`'s "supported".
- **The learner.** 4 notes saved over the two nights with work, no new standing fact. It tried a bracket once and was refused: the words it quoted were Chief's reply in the turn before, which its item did not include. The judge, which is shown that reply, cited it when it called the resulting note supported.
- **Procedures.** The weekly pass revised 3 on 18 November. The coding procedure went from 1,932 to 1,679 characters, so it was not refused for length.
- **Cost.** Judge nights $0.23 to $0.50 at high effort (the first night under `judge-v3` at medium effort, with more turns, was $0.68); the repair $0.10; the procedure pass $0.24.
- **Read in the code (`origin/main` at `4586732`).** A night's controls were drawn from facts whose latest verdict was "supported" under any judge prompt. The judge read a fact again under a new prompt only when the old verdict was a fault. Its self-checks ran inside the judge's run, and that run opened only when there was a new fact or turn.

## Diagnosis and alternatives

- **The faulted controls are two prompts disagreeing.** `judge-v1` knew nothing of notes or of days; later prompts hold a standing fact to general words or to separate days. A fact that only `judge-v1` passed is not known to be supported by today's judge, so faulting it is not a false alarm. On the facts the current prompt had judged itself, it faulted none of 5. Five is too few to call the judge steady; it is enough to say the 6 of 16 measured something else.
- **So a new prompt reads every fact again**, not only the ones the old prompt faulted, and controls come only from facts the current prompt has called supported. The gate's record counts only tests built on such a fact. That is applied to past results by looking up who had judged the base when the test ran, so the 5 sound controls already on record still count and the 11 others do not.
  - Alternative considered: bump the judge's prompt version to start the record again. The prompt did not change, and it would throw away the sound results.
- **Some of the 14 are probably overstated.** They have been in every turn as "supported" since 12 November. The first night after this change reads them.
- **The record stood still in a quiet week.** The gate reads 14 days. With the judge running only on nights with new work, three quiet nights added nothing, and five faulted facts waited. The judge's test of itself now runs every night there is a fact to build it on: two model calls, a control batch and a broken-copy batch.
  - Alternative considered: test only while a repair is waiting. Simpler to reason about, but the same counts are the only standing measure of the judge, and they are worth having on a night nothing else happens.
  - What was said on 17 November, corrected: that the repair would not start at this rate. It started the next night, because the judge did run on three of the first five nights. The quiet nights since are what the claim should have rested on.
- **The learner could not quote what the owner was answering.** "It" and "this" usually point at Chief's previous message. The judge and the repair have read the end of that message since journal 195; the learner's item held only the turn's own reply. The item now carries the same text (`chiefBefore`), and a bracketed detail may rest on it, on a note only, as before.

## Implementation and review

- [src/learning.ts](../../src/learning.ts): `judgeFactRows` reads again any fact whose latest verdict is from another judge prompt; `probeBaseRows` takes bases from the current prompt's "supported" verdicts; `judgeDue` is true when such a base exists and the self-checks are on; `judgeRecord` counts a test only when the current prompt had judged its base before it; `chiefBeforeOf`, `Evidence.chiefBefore` and `exchangeOf`; `learner-v8`. The procedure pass leaves `chiefBefore` out (`fitted`).
- [scripts/judge-report.sql](../../scripts/judge-report.sql): the planted-error query counts what the gate counts.
- Tests, scripted models on a test database: [tests/memory-repair.test.ts](../../tests/memory-repair.test.ts) (an older prompt's "supported" is read again and tests built on it do not open the gate), [tests/memory-judge.test.ts](../../tests/memory-judge.test.ts) (a night with nothing new still tests the judge), [tests/learning-durability.test.ts](../../tests/learning-durability.test.ts) (the learner is shown what Chief said before, a note may bracket it, and the procedure pass is not shown it).
- Design: [learning](../learning.md#nightly-judge).

## Verification and outcome

Tested only. Unmeasured until production nights:

- what `judge-v4` says of the 14 facts only `judge-v1` had passed;
- the rate of faulted controls once every base is one the current prompt judged;
- whether the gate then opens and stays open, and what the repair does with the five facts waiting and with any of the 14 that are faulted;
- whether the learner uses a bracket when the owner answers Chief's previous message;
- the cost of a night that only tests the judge.

### Release closure

Not released. Pending: independent review, merge, the automatic release, and the first nights.

## Follow-up and next iteration

- The repair gate's thresholds are unchanged. Eight tests bound the catch rate loosely; whether to pool more nights before the repair may act is the owner's decision and is still open.
- Turn judgements repeat less well than fact verdicts (3 of 12 differed). Nothing acts on a turn judgement yet.
- One fact could not be repaired in two attempts: its only honest wording needs words the owner did not use. It stays for the owner.
- The plan from the 13 November research is otherwise as it was: a small always-loaded core with procedures loaded by kind of work, and procedures as numbered rules with a replay check.
