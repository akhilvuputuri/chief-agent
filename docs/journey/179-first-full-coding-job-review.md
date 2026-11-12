# 179 — After-action review: why did the first full coding job take a day and $104?

Work date(s): 2026-11-12. Written/revised: 2026-11-12, 2026-11-13.
Status: investigation complete; no code changed here. PRs 462 and 467 remain open; 464–466 and 469 were closed on 13 November in favour of the loop design (PR 468); see "Plan".

## User-visible problem and preceding iteration

Coding job `9600af57` (the study list, [journal 178](178-study-list-link-classification.md)) was the first Pi job to run from request to a merged PR on Opus 5.5. It produced a correct change (33 files, about 4,000 lines, merged as `2910171b`), but it took 19 hours 14 minutes from the request (11 November, 19:10 UTC) to merge-ready (14:24) and $103.82 in model calls, and the owner had to restart it three times. The owner asked for a thorough review: such a job should need neither that time nor those tokens, and Pi is used by many people without this cost.

Earlier partial findings are in [journal 169](169-three-hour-coding-attempts.md) (time limit, effort, tool use on the first attempt).

## Evidence

Sources: `coding_model_calls` and `coding_events` for the job on the production database (read-only, aggregates only), the Anthropic Console usage export for 11–12 November, `origin/main` at `2910171b`, and the published Pi packages (`@earendil-works/pi-coding-agent` 1.1.0 and its `pi-ai`, `pi-agent-core`).

### Where the money and time went (measured)

| Phase (UTC, 12 Nov unless noted)                                                 | Machine time   | Cost       |
| -------------------------------------------------------------------------------- | -------------- | ---------- |
| Plan and plan check (11 Nov 19:12–19:17)                                         | 5 min          | $1.68      |
| Implement, checks, review, repair, review (01:44–05:52)                          | 3 h 17 min     | $33.75     |
| **First reviewed PR (draft 463 at 05:52)**                                       | **3 h 22 min** | **$35.43** |
| Rebuild on new main after PR 460 (05:53–08:01), stopped on the Kite mismatch     | 2 h 8 min      | $20.84     |
| Resume on new image, review, repair, review (09:26–10:35)                        | 1 h 9 min      | $9.49      |
| Rebuild on new main after docs-only PR 470, review, repair, review (10:37–14:24) | 3 h 44 min     | $38.06     |
| **Everything after the first reviewed PR**                                       | **7 h 1 min**  | **$68.39** |

- 66% of the cost and 68% of the machine time came after the job already had a reviewed PR, because main moved twice and the Kite toolchain changed under it. Each rebuild cost what the first implementation cost ($19.71 and $19.31 against $19.55) and started writing code at the same point (first file written at call 80–90, 41–47 minutes in, all three times): nothing from the earlier build was reused.
- The owner was waited on for 8 h 44 min (6 h 25 min for the plan's Start overnight, then 51, 85 and 3 minutes after three stops).

By role: coder 779 calls, $71.22; reviewer 310 calls, $31.49; planner 15 calls, $1.12.

By token type (list prices: $4 input, $20 output, $0.20 cache read, $5 cache write per million; figures are rounded to the cent, and "All" includes the planner's $1.12):

| Component       | Coder  | Reviewer | All    |
| --------------- | ------ | -------- | ------ |
| Thinking output | $30.69 | $16.38   | $47.23 |
| Visible output  | $7.02  | $1.77    | $9.02  |
| Cache reads     | $24.37 | $7.14    | $31.60 |
| Cache writes    | $9.13  | $6.20    | $15.97 |

The Console export for 12 November shows 117.3M cache-read, 2.4M cache-write and 2.19M output tokens on the `chief` key, about three-quarters of what the database records for the day; the export appears to stop around midday UTC. 46% of its cache reads were in requests over 200,000 tokens. Anthropic's pricing page lists no long-context surcharge for Opus 5.5; the invoice was not checked.

### How the coder and reviewer worked (measured)

- **Model time dominates.** In the first implementation, 92 of 102 minutes were spent waiting for the model and 10 running tools. Across the job the coder waited 320 minutes on the model and the reviewer 163.
- **Thinking is concentrated and mostly precedes a trivial step.** 100 coder calls hold 77% of the coder's thinking and 209 model minutes. Of the 82 coder calls with 8,000 or more thinking tokens (over a minute each), 65 ended by requesting one `grep` or one file read; 11 wrote a file.
- **Thinking is not carried between turns.** A mid-session coder request (call 101 of the first implementation) held 100 earlier assistant messages; none carried a thinking block. The adapter returns thinking as `reasoning_details` of type `anthropic.thinking`, and Pi's OpenAI-compatible client keeps only other shapes (`pi-ai/dist/api/openai-completions.js`), so it never enters the session. Anthropic's documentation says to pass every thinking block back unchanged with the tool call it accompanied.
- **One tool per turn, through the shell.** 746 of 779 coder turns and 278 of 310 reviewer turns requested exactly one tool. 753 of 809 coder tool calls were `bash`: 246 file reads (`sed -n`, `cat`, `head`), 196 searches, 163 test or build commands, 54 Python edit scripts averaging 2,400 characters. Pi's `read` was used 6 times and `edit` 5.
- **Contexts are large.** The coder's average request was 200,000 tokens in the first implementation and peaked at 324,000; 276 coder requests were over 200,000. That mid-session request held 105 tool results totalling 477,000 characters, and a 26,000-character system prompt. Cache reads are a third of the coder's cost because every turn re-reads all of it.
- **Every repair and every review starts cold.** Each repair session began at 13,000 tokens and spent 27–33 calls and 8–17 minutes before its first edit. Each of the six reviews began at 14,000–15,000 tokens; the review after a seven-minute repair took 25 minutes and $5.25.
- **Long test runs are polled.** The full `kite run check` took 400–475 s and ran to completion six times after a "done" report (44 minutes); a seventh failed in 24 s on the Kite mismatch. Inside a session `bash` is limited to 120 s, so in one attempt the coder started the suite in the background and polled it with twelve `sleep 100`-style calls, each a full-context turn.
- **Reviews found real defects.** Three of six reviews requested changes, each for a reproduced bug, and each was approved on the next round. Review quality is not the problem; its fixed cost per round is.

### How the integration differs from Pi as shipped (read in code)

1. **Prompt.** `getSystemPrompt()` replaces Pi's prompt, and Pi then skips its tool list and rules ("Use read to examine files instead of cat or sed", the multi-edit rules). Our text names only `bash`, `report` and `read_document`. The objective and plan are sent twice (system prompt and first user message), with `AGENTS.md` (18 KB) appended.
2. **Tools run one at a time.** Every tool is registered `executionMode: "sequential"` (`coding_runtime_pi/src/tools.ts`, `runtime.ts`); Pi's default is parallel. `bash` is capped at 120 s (Pi has no default cap) and `grep` fails outright over 64 KB where Pi truncates.
3. **Wire protocol.** The worker talks to the host as an OpenAI-compatible provider, although Pi's catalogue uses the Anthropic messages protocol for this model. That is where thinking blocks are lost; the host, not Pi, places cache markers.
4. **Effort.** Jobs ran at `high`; Pi's default thinking level and Opus 5.5's API default are both `medium`.
5. **Context window.** Compaction triggers near the model's 1,000,000-token window, so nothing bounds a session below that.
6. **Sessions.** Check repair, review repair, PR feedback and rebase each start a new session with only a findings document of at most 32,000 characters; each review round clones afresh without dependencies and starts a new session. The review loop has no round cap.
7. **Rebase.** Any commit on main, conflicting or not, clears the saved patch and re-implements from the plan, up to twice (`src/coding/automation.ts`).
8. **Checkpoints.** Every tool start and end re-parses the session, runs `git add -A` and diffs, and posts a checkpoint. Wall time only; the measured tool time is small.

### External reference points

- Pi's author describes the intended use as one session, four tools, a system prompt and tool definitions under 1,000 tokens, no plan mode and no sub-agents (mariozechner.at, "What I learned building an opinionated and minimal coding agent"). No published cost or duration for a comparable feature was found for Pi.
- Anthropic's documentation: effort default `medium` for Opus 5.5; thinking blocks passed back unchanged within a tool-use loop; a system-prompt line asking for independent tool calls in one turn; reviewers that read only the diff in a fresh context.

## Diagnosis and alternatives

The sandbox is not the cause: tool time is a tenth of model time. The cost has four layers, in order of measured size.

1. **Rework from outside the job (66% of cost).** The job was finished at 05:52 and was then rebuilt twice because main moved (one merge was this session's own PR 460, one a docs-only PR), with a toolchain change in between that the frozen worker image could not build.
2. **Fresh sessions inside the job.** Three implementations, four repairs and six reviews each re-read the repository from nothing. This is the plan-then-phases structure: the only thing carried across a boundary is a document.
3. **Per-turn inefficiency.** Long thinking that is discarded at the next turn, one tool per turn, shell commands instead of Pi's file tools, and 200,000-token contexts re-read on every one of those turns.
4. **Settings.** `high` effort and Opus for the coder.

**Hypotheses, not measured:**

- Carrying thinking between turns would cut the coder's thinking substantially. The pattern (long thinking, then a single read, repeatedly) fits a model re-deriving its design each turn, but the thinking text is not stored, so repetition was not observed directly.
- `medium` effort and a Sonnet 5.5 coder keep quality on this repository. Untested here.
- With layers 1–3 fixed, a change of this size should take 60–90 minutes and $10–20. This is a target to verify with `scripts/coding-job-profile.sql` (PR 467), not a measurement.

Alternatives considered: a lower context window (rejected, see plan item 4); dropping review (rejected: it found three real bugs); raising limits further (treats the symptom).

## Plan

> **Update, 13 November 2026 (owner review):** the owner judged several of the prepared fixes below to treat symptoms, and they were looked at again from scratch. PR 469 kept the "main moved" trigger and only made the reaction cheaper; PR 465 re-added by hand the tool rules lost by replacing Pi's prompt and added a hard failure over 20 tool calls; PR 464 capped jobs on worker images that no open job uses; PR 466 stored thinking summaries in the proxy format that is being replaced. All four were closed. The plan now is the one in [the loop design](../coding-simple-loop.md) (PR 468): main moving is not an event, Pi runs as shipped, one session per job, the listed limits removed. PRs 462 and 467 stay. The list below is the 12 November record.

**Already built, awaiting release (no coding job is open):**

- PR 469: carry the reviewed change onto new main with `git apply --3way` and re-review only the difference. Would have avoided most of the $68.
- PR 462: `medium` effort, coder on Sonnet 5.5.
- PR 465: tool guidance (use `read`/`edit`, batch independent reads). PR 464: deadlines follow each job's own settings. PR 466: keep thinking summaries. PR 467: the profile script.

**New, from this review, in order of expected effect:**

1. One session per job (design in [PR 468](https://github.com/akhilvuputuri/chief-agent/pull/468)): no planner or plan check; repairs and check failures continue the coder's session; the reviewer's later rounds continue its session and read only the delta, in a checkout that keeps its dependencies.
2. Use Pi closer to how it ships: append to Pi's prompt instead of replacing it, shorten ours and send the objective once; let read-only tools run in parallel; let `bash` run the full suite (a longer cap) so the coder stops polling.
3. Carry thinking between turns, by speaking Pi's native Anthropic protocol through the proxy or by mapping the blocks. An earlier attempt at this was stopped by the model provider's safeguards; it needs the owner's decision on how to proceed.
4. No context cap. A 200,000-token request costs about $0.04 to re-read from cache; the $31.60 of cache reads came from 1,104 calls, two-thirds of them in rebuilds and fresh sessions, not from the size of each request. Compaction is lossy and rewrites the cache at 25 times the read price, and nothing measured shows quality falling at 300,000 tokens. Send the objective and plan once, watch context size and cache reads per job with the profile script, and revisit only if a job shows a problem. (Owner review, 12 November: growing context to the model's limit is normal for coding agents, and a cap risks worse results.)
5. Process: hold merges to main while a job is open until PR 469 is live; move a job to the current worker image on rebase (in PR 469).

Each step is to be measured on one real job with the profile script before the next.

## Deployment status

Nothing here is deployed. Job `9600af57` is finished: PR 463 merged as `2910171b`, migration 036 rolled out, release run 43239335489 succeeded.
