# 169 — Why did the first Opus coding job run out of time?

Work dates: 12 November 2026. Written: 12 November 2026.
Status: new Pi jobs get 180 minutes instead of 150. Effort is unchanged; lowering it is an open owner decision. Not yet released.

## User-visible problem and preceding iteration

Coding job `9600af57` (the study-links feature, rerun after [journal 164](164-claude-models-everywhere.md) moved the planner, coder and reviewer to Opus 5.5) paused with "Coding time ran out while the coding box was still working; saved work is retained". It was on worker image `sha256:33639fbe…` from [journal 167](167-review-that-reads-what-changed.md). The owner asked why it took so long, since the same kind of task is faster in an interactive Claude Code session.

## Evidence

**Measured, production database, job `9600af57`:**

| Phase                       | Wall time | Model calls | Cost   |
| --------------------------- | --------- | ----------- | ------ |
| Plan and requirement check  | 7 min     | 22          | $1.12  |
| Implementation              | 102 min   | 173         | $19.55 |
| Checks (`kite run check` …) | 8 min     | —           | —      |
| Review, round 1 (cut off)   | 40 min    | 65          | $6.96  |

The implementation attempt started at 01:44:52 UTC and its deadline was 150 minutes later, at 04:14:52; the job paused at 04:14:51 with the reviewer's next call in flight. Every call went `anthropic-direct`, and 99% of prompt tokens were cache reads. Two gateway restarts from unrelated releases each cost one reviewer call.

**Measured, same job, where the coder's time went:**

- 458,408 of its 553,125 output tokens (83%) were thinking. The reviewer's were 195,312 of 203,709 (96%).
- Opus streamed at about 100 tokens a second on the long calls, so the coder's thinking alone accounts for roughly 76 minutes of its 102.
- 35 calls of over a minute took 78 of the 102 minutes; the longest was 251 s, with 25,982 thinking tokens and 133 visible ones. 104 calls under 15 s took 8 minutes in all.
- The review's prompt grew only from 105,000 to 152,000 tokens over 62 calls, so it was reading in small steps and thinking for about a minute before each one.

Job settings: `effort: "high"` for all three roles (`config/coding-pi.json`), passed as `output_config.effort`.

## Diagnosis and alternatives

The job was not stuck or looping; it was slow because Opus 5.5 at `high` effort thinks at length on most steps, and one attempt has to fit the implementation, the full checks and an independent review. The 150-minute limit was chosen when a much faster DeepSeek model did the coding.

- **Raise the time limit to 180 minutes (chosen).** It is the most one Pi attempt may run (`PI_ATTEMPT_MS`, inside the box's four-hour task deadline). Costs nothing unless a job needs it.
- **Lower effort to `medium` (owner decision, not made).** Anthropic's guidance for Opus 5.5 is that its default is `medium`, that it thinks more per turn than Opus 5 at the same level, and that `medium` matched or beat Opus 5 at `high` on agentic coding in Anthropic's testing. Thinking is about four-fifths of the coder's output here, so this is the largest lever on both time and cost. It is untested on Chief's jobs; quality on this repository's large changes is the risk.
- **Per-role effort** (for example `medium` for the coder, `high` for the reviewer) would need a code change; the setting is shared today.

**Hypothesis, not measured:** an interactive Claude Code session feels faster partly because the person approves a plan and watches small steps, while this job also ran a separate plan check, the repository's full eight-minute check suite and an independent review from scratch. The effort setting Claude Code used for comparable work was not checked.

## Implementation and review

`config/coding-pi.json` `limits.ms` 9,000,000 → 10,800,000. Existing jobs keep their snapshot; a paused job can be given 180 minutes with `coding_job_update`. Dated notes in `docs/coding.md` and `docs/model-providers.md`.

## Deployment status

Not yet released. Job `9600af57` is paused at review round 1 with its candidate and session saved; resuming continues the review.
