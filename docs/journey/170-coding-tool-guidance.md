# 170 — Why did the Opus coder make one shell call per turn?

Work dates: 12 November 2026. Written: 12 November 2026.
Status: tested on synthetic fixtures. Worker change only; it takes effect when a worker image built from it is pinned in `config/coding-pi.json` (a later PR). Not yet released. Whether it shortens a real job is unmeasured.

## User-visible problem and preceding iteration

[Journal 169](169-three-hour-coding-attempts.md) found that coding job `9600af57` ran out of time because Opus 5.5 at `high` effort thinks at length before most steps: 35 calls of over a minute took 78 of the coder's 102 minutes. The fewer model turns a job needs, the fewer of those long thinking steps it pays for. Looking at what each turn asked for showed that the coder and reviewer used almost one turn per tool call, and that the coder did nearly everything through `bash`.

## Evidence

**Measured, production job `9600af57`, 12 November 2026** (counted from the job's coding model-call journal by the session that investigated journal 169; aggregates only, not re-measured in this PR):

| Role     | Responses | Responses with exactly one tool call | Tool calls                                                                                                                         |
| -------- | --------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Coder    | 173       | 168                                  | 178, all but 9 `bash`: 49 `sed`, 42 `grep`, 14 `cat`, 25 `python3` edit scripts (2,543 characters on average); `read` and `edit` 0 |
| Reviewer | 69        | 63                                   | 60 `bash`                                                                                                                          |
| Planner  | 15        | not counted                          | the planner has no shell; it requested 2–3 calls together in 12 of 15 responses                                                    |

**Read from source, 12 November 2026:**

- The worker's system prompt (`coding_runtime_pi/src/runtime.ts`) replaces Pi's default prompt in full (`coding_runtime_pi/src/resources.ts` returns it from `getSystemPrompt`), so Pi's own guidelines about its tools never reach the model. Before this change the prompt said nothing about which tool to use for what, or about requesting several calls at once. The only batching hint was for `read_document` pages ("request several pages in one turn").
- Tools per intent (`coding_runtime_pi/src/tools.ts`): learn and plan get `read`, `grep`, `find`, `ls` and `report`; review gets the same plus `bash` when it is given a command executor, which Chief's bridge (`src/coding/pi-worker.ts`) supplies to every runtime it makes, so both the candidate review and the plan check have a shell in a disposable checkout; build gets `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash` and `report`. `read_document` is added whenever task documents exist.

**Tested, 12 November 2026: several tool calls in one message work end to end.**

- Pi 1.1.0 (`@earendil-works/pi-agent-core`, `executeToolCalls`) runs every tool call of one assistant message before the next model turn. Chief marks all its tools `executionMode: "sequential"`, so they run one after another in the order given, never at the same time; a batch of edits cannot race. On cancellation Pi stops between calls, and `pi-ai`'s message transform gives any call left without a result a synthetic "No result provided" result on replay.
- Pi's OpenAI-completions parser keys a streamed tool call by `index`, or by `id` when there is no index. Chief's facade (`src/coding/pi-proxy.ts`) frames a completed generation as one chunk whose `tool_calls` carry ids but no index. A new synthetic test (`coding_runtime_pi/tests/native-protocol.test.ts`) serves two calls framed that way: both run, and the next request replays one assistant message with both `tool_calls` followed by their two results in order.
- Host path: `piCompletion` passes the messages to `controller.generate` unchanged; on the direct route `src/anthropic.ts` turns each `tool_calls` entry into a `tool_use` block, merges the results into one user message with the `tool_result` blocks first, and turns every `tool_use` block of the response back into `tool_calls`. Neither route asks the provider to disable parallel tool use. A new host test (`tests/anthropic.test.ts`) drives two calls through `piCompletion` and the direct adapter in both directions.
- Limit: the facade accepts at most 20 `tool_calls` per replayed assistant message (`pi-proxy.ts`). A response with more would be accepted once and then make the next request fail validation. The guidance therefore asks for up to eight at a time.

## Diagnosis and alternatives

The prompt gave the model no reason to prefer Pi's file tools or to batch, and replacing Pi's default prompt also removed Pi's own advice. The planner, which has no shell, already batched; the coder and reviewer, which have one, fell back to shell habits.

- **Tool guidance in the system prompt, generated from the tools the session actually has (chosen).** One sentence group per available tool: `read` with offset and limit to view files, `edit` to change them and `write` for new files instead of `cat`, `sed -n`, `head` or `python3`/heredoc scripts through `bash`; `grep`, `find` and `ls` to search; `bash` for commands, tests, git and searches the other tools cannot do; independent reads and searches requested together, up to eight, with `report` called on its own afterwards. Because the text is built from the session's tool names, the planner is never told about `bash` or `edit`, and the reviewer never about `edit` or `write`.
- **Restore Pi's default prompt and append Chief's.** Rejected: Pi's prompt describes tools and behaviours Chief does not grant, and the host prompt is deliberately the only instruction source.
- **Remove `bash` from the reviewer.** Rejected: the owner approved the reviewer running commands in its disposable checkout (4 November 2026) to try to break the candidate.

**Hypothesis, not measured:** fewer turns per job would cut the coder's and reviewer's wall time roughly in proportion, since most of a turn's time is thinking before the call (journal 169). The model may follow the guidance only partly; an `edit` may also need more careful exact-match text than a `python3` script. Batching sends larger tool results per turn, which grows the context faster per turn but not per tool call.

## Implementation and review

- `coding_runtime_pi/src/tools.ts`: `toolGuidance(names)` builds the text from the given tool names.
- `coding_runtime_pi/src/runtime.ts`: the system prompt inserts `toolGuidance` of the session's tools after "Inspect actual source and distinguish facts from hypotheses." Nothing else in the prompt changes; the final-report phase still permits only `report` and `read_document`.
- Tests: `coding_runtime_pi/tests/tool-guidance.test.ts` (wording per intent from the real tool lists; plan, learn and a shell-less review never name `edit`, `write`, `bash`, `cat` or `python3`; a review with a shell never names `edit`, `write` or `python3`), a new case in `coding_runtime_pi/tests/runtime.test.ts` (the captured system prompt for plan, build and review carries the matching guidance), the native protocol case above and the host round-trip case in `tests/anthropic.test.ts`.
- Independent review: pending at the time of writing; recorded on the PR.

## Verification and outcome

- **Tested:** `kite run check` in `coding_runtime_pi` (build and all 128 tests) passes; `kite run typecheck` at the root passes; the host files that exercise the Pi runtime, the facade and the direct adapter pass (105 tests). Prettier passes on the changed files.
- **Not measured:** the effect on a real job's turn count, tool mix, wall time or cost. The comparison to make is the coder's and reviewer's responses with one tool call, their share of `bash` calls, and time per phase, on the next real job against `9600af57`.

### Release closure

Pending. This needs review and merge, a worker image built from the merge, and a separate reviewed PR that pins that image in `config/coding-pi.json`. Existing and paused jobs keep their recorded image.

## Coding-harness learning record

Recorded in [coding-agent lessons](coding-agent-lessons.md#tool-guidance-for-the-pi-coder-and-reviewer--12-november-2026).

## Follow-up and next iteration

- After the image is pinned, compare the first comparable job's per-role tool mix and single-call share with `9600af57`.
- Effort (`medium` against `high`) remains the larger open lever from journal 169 and is an owner decision.
