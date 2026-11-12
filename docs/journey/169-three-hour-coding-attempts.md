# 169 — Why did the first Opus coding job run out of time?

Work dates: 12 November 2026. Written: 12 November 2026.
Status: new Pi jobs get 180 minutes instead of 150. Effort is unchanged; lowering it is an open owner decision. Not yet released.

> **Update, 12 November 2026:** live in `92999f8` (PR 460, release run 43159458020).

> **Update, 12 November 2026:** the owner chose `medium` effort for new jobs; see [Effort lowered to medium](#effort-lowered-to-medium-12-november-2026). The same section records that the coder made one tool call per turn and used the shell instead of `read` and `edit`.

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

Planning was its own attempt the evening before. The implementation attempt, which held implementation, checks and review (102 + 8 + 40 = 150 minutes), started at 01:44:52 UTC and its deadline was 150 minutes later, at 04:14:52; the job paused at 04:14:51 with the reviewer's next call in flight. Every call went `anthropic-direct`, and 99% of prompt tokens were cache reads. Two gateway restarts from unrelated releases each cost one reviewer call.

**Measured, same job, where the coder's time went:**

- 458,408 of its 553,125 output tokens (83%) were thinking. The reviewer's were 195,312 of 203,709 (96%).
- Opus streamed at about 100 tokens a second on the long calls, so the coder's thinking alone accounts for roughly 76 minutes of its 102.
- 35 calls of over a minute took 78 of the 102 minutes; the longest was 251 s, with 25,982 thinking tokens and 133 visible ones. 104 calls under 15 s took 8 minutes in all.
- The review's prompt grew only from 105,000 to 152,000 tokens over its 62 completed calls (the table's 65 also counts two calls lost to gateway restarts and the one in flight at the deadline), so it was reading in small steps and thinking for about a minute before each one.

Job settings: `effort: "high"` for all three roles (`config/coding-pi.json`), passed as `output_config.effort`.

## Diagnosis and alternatives

The job was not stuck or looping; it was slow because Opus 5.5 at `high` effort thinks at length on most steps, and one attempt has to fit the implementation, the full checks and an independent review. The 150-minute limit was chosen when a much faster DeepSeek model did the coding.

- **Raise the time limit to 180 minutes (chosen).** It is the most one Pi attempt may run (`PI_ATTEMPT_MS`, inside the box's four-hour task deadline). Costs nothing unless a job needs it.
- **Lower effort to `medium` (owner decision, not made).** Anthropic's published migration guidance for Opus 5.5 (the "Migrating to Claude Opus 5.5" section; quoted, not measured here) says its default is `medium`, that it thinks more per turn than Opus 5 at the same level, and that `medium` matched or beat Opus 5 at `high` on agentic coding in Anthropic's testing. Thinking is about four-fifths of the coder's output here, so this is the largest lever on both time and cost. It is untested on Chief's jobs; quality on this repository's large changes is the risk.
- **Per-role effort** (for example `medium` for the coder, `high` for the reviewer) would need a code change; the setting is shared today.

**Hypothesis, not measured:** an interactive Claude Code session feels faster partly because the person approves a plan and watches small steps, while this job also ran a separate plan check, the repository's full eight-minute check suite and an independent review from scratch. The effort setting Claude Code used for comparable work was not checked.

## Implementation and review

`config/coding-pi.json` `limits.ms` 9,000,000 → 10,800,000. Existing jobs keep their snapshot; a paused job can be given 180 minutes with `coding_job_update`. Dated notes in `docs/coding.md` and `docs/model-providers.md`.

## Deployment status

Not yet released. Job `9600af57` is paused at review round 1 with its candidate and session saved; resuming continues the review.

## Effort lowered to medium (12 November 2026)

The owner chose `medium` for new Pi jobs after reading the evidence above. `effort` in `config/coding-pi.json` is `medium` for all three roles; per-role effort still needs a code change. Jobs keep the effort they were created with, so `9600af57` stays at `high`. Whether `medium` keeps quality on this repository's large changes is untested; compare the next job's review findings, thinking tokens and wall time with `9600af57`.

## How the coder and reviewer used tools (12 November 2026)

**Measured, production `coding_model_calls` for job `9600af57`, before the resume:** the coder's tools were `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`, `report` and `read_document`.

- **One tool call per turn.** 168 of 173 coder responses and 63 of 69 reviewer responses asked for exactly one tool. The planner, with no shell, asked for two or three at a time in 12 of its 15.
- **Shell instead of the file tools.** All but 9 of the coder's 178 tool calls were `bash`: 49 `sed`, 42 `grep`, 14 `cat`, and 25 `python3` scripts averaging 2,543 characters that edited files. It called `edit` and `read` zero times. The reviewer made 60 `bash` calls, mostly `grep`, `sed` and `cat`.
- **The prompt says nothing about either.** The Pi runtime replaces Pi's default system prompt with Chief's (prompt text in `coding_runtime_pi/src/runtime.ts`), which asks for real checks and scope but gives no guidance on choosing the file tools over `bash`, or on batching repository reads (it does say to request several `read_document` pages in one turn). The replacement is in `coding_runtime_pi/src/resources.ts`.

**Hypothesis, not tested:** each extra turn costs a full model call with its thinking, and each edit script is written out as output tokens at about 100 a second. Telling the coder and reviewer to use `read` and `edit` and to batch independent reads in one turn could cut the number of turns substantially. That is a worker change, so it needs a new worker image and a pin.

**Thinking is counted but not visible.** Each call's thinking tokens are recorded (`model_usage` events), but under the API's default display the thinking text is empty, so why a call thought for four minutes cannot be read afterwards. Asking for summarized thinking costs nothing extra, since thinking is billed the same under every display setting.
