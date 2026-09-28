# 39 — A recall eval for one long chat

Work date(s): 2026-09-28. Written/revised: 2026-09-28.
Status: in review. This adds an eval and a measured baseline. It changes no runtime behaviour.

## User-visible problem and preceding iteration

[Journal 36](36-bounded-context.md) and the context research (outside the repository) found that Chief has no real compaction:

- Older conversation is cut newest-first under a 48,000-character budget.
- The previous exchange is always sent whole.
- An extractive archive covers roughly messages 13–40 back.

On 27 September, after the Jev tool picker ([journal 37](37-jev-tool-picker.md)), production requests still left out older history on 25 of 25 calls. The fixed part averaged about 45,000 characters. Before changing context handling, we needed a repeatable way to measure what the model can see and answer after topic switches.

## Evidence

**Eval design.**

- `evals/context/replay.ts` loads each synthetic conversation into an in-memory PGlite database, stored as completed runs would store it: journaled tool calls, projected results with observation IDs, and conversation rows.
- It then sends each probe as the next owner message through the real `Assistant` pipeline.
- `evals/context/run.py` scores the results (`npm run eval:context`).

**Fixtures.** There are 6 fictional conversations of 10–19 turns each, with 54,000–114,000 characters of tool results. Two are rewrites of the 11 and 13 September incidents. There are 36 probes across six slices:

| Slice       | Where the answer is                                                |
| ----------- | ------------------------------------------------------------------ |
| previous    | the previous exchange                                              |
| gap         | 2–6 turns back                                                     |
| distant     | older than that                                                    |
| tool-detail | only inside an earlier tool result                                 |
| switch      | a new topic, with a tempting wrong answer in the previous exchange |
| same-word   | a term that two topics share                                       |

**Measured baseline, 28 September.** Main at `211b657` plus this eval. Integrations were off, so the model had to recall rather than re-fetch.

| Slice           | Visible in prompt | Correct (`openai/gpt-6-sol`, 1 run) | Used conversation search |
| --------------- | ----------------- | ----------------------------------- | ------------------------ |
| previous (6)    | 100%              | 100%                                | 0%                       |
| gap (5)         | 100%              | 100%                                | 40%                      |
| distant (7)     | 71%               | 86%                                 | 86%                      |
| tool-detail (9) | 11%               | 44%                                 | 89%                      |
| switch (6)      | 83%               | 100%                                | 50%                      |
| same-word (3)   | 67%               | 100%                                | 67%                      |
| all (36)        | 67%               | 83%                                 | 58%                      |

- No reply gave only the known wrong answer.
- The median fixed prompt was about 30,000 characters, smaller than production's, because the eval has no skill catalogue, approvals or production memories. Compare arms with each other, not with production.
- The answer run cost $1.09, with a median latency of 6.1 s.

**What failed.** Tool-detail answers failed because:

- conversation search rarely surfaced facts that sit inside tool results;
- nothing in the prompt said which stored result held them.

Correct tool-detail answers mostly came from `observation_read` on an ID the model found.

**Earlier run, kept as evidence.** In a first run with integrations on and stub data, the model re-ran Gmail, jobs or watchlist tools instead of reading stored results, and once exhausted its tool budget. That run also showed the grader counting replies that mention the other value for contrast as "confused". The grader now counts a reply as confused only when it lacks the correct answer.

## Diagnosis and alternatives

A literal-evidence check alone undervalues pointers, so the eval also reports whether evidence is "one read away": inside a stored result whose ID is in the prompt. At baseline that was 67%, the same as "visible", because nothing in the prompt points at stored results.

The next change is issue #77 stages 2 and 3:

- the previous exchange's large tool results become excerpts with their IDs;
- the extractive archive is replaced by a contiguous exchange index that carries message and observation IDs.

## Implementation and review

- **Harness:** `evals/context/` holds `replay.ts`, `run.py`, the generator `fixtures/gen.py` with the `fx_*.py` fixture modules and the generated `*.json`, `test_score.py`, and a README.
- **Tests:** `npm test` now runs the scorer tests.
- **Cost:** answer mode is paid (about $1.1 per 36 probes) and run by hand, as with the picker eval.

## Verification and outcome

- The baseline above is measured.
- It is one answer run, a smoke baseline rather than a success rate.
- The fixtures are synthetic and written by the developer.
