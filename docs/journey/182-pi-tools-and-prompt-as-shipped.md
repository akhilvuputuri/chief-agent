# 182 — Pi's tools and prompt as shipped

Work date(s): 2026-11-13. Written/revised: 2026-11-13.
Status: in progress. Implemented and tested offline on branch `coding-revamp/c-stock-pi-tools` from `2910171b`; review, merge, a worker image and a real coding job are pending.

## User-visible problem and preceding iteration

The first full Pi coding job took 10 machine-hours and $104 ([journal 179](179-first-full-coding-job-review.md), on branch `docs/coding-job-after-action`). The review found that most of the waste came from what Chief adds around Pi. This piece covers the worker runtime (`coding_runtime_pi/src/`): the system prompt, tool execution mode, the shell time limit, the wrappers around Pi's tools, the gate on task documents and the compaction settings. The model protocol and the host loop are separate pieces of the same revamp.

## Evidence

Measured in the review of that job (journal 179), not re-measured here:

- 96% of coder turns asked for exactly one tool; 93% of the coder's tool calls were shell commands (`sed -n`, `cat`, `grep`, Python edit scripts). Pi's `read` was used 6 times and `edit` 5 times in 779 turns.
- One attempt ran the 7.5-minute test suite in the background and polled it with twelve `sleep 100` calls, because a shell command was cut at 120 seconds.

Checked in the Pi 1.1.0 package source for this piece:

- `dist/core/system-prompt.js`: when the resource loader returns a custom prompt, Pi uses it as the whole preamble and skips its tool list and its rules section (`buildRules`), which carries each tool's guidelines, such as "Use read to examine files instead of cat or sed." Text from `getAppendSystemPrompt()` is added as an `addendum` section after Pi's own prompt.
- `pi-agent-core/dist/agent-loop.js`: one tool with `executionMode: "sequential"` makes every call in the message run one after another. Without it, all calls of one assistant message start together; `tool_execution_start` is emitted for every call before any of them runs, and each `tool_execution_end` as it finishes.
- `dist/core/tools/bash.js`: no timeout unless the model passes one; output is kept to the last 2,000 lines or 50 KB, with the full output in a temporary file.
- `dist/core/tools/grep.js`: runs `rg --hidden` over the tree and truncates to 100 matches or 50 KB with a notice. A local run of `rg --json --hidden` in a scratch repository returned matches from `.git/description` and `.env`.
- `dist/core/tools/find.js`: runs `fd`, which `Dockerfile.coding-pi` does not install; Pi's `ensureTool("fd")` would download it from GitHub at run time. A custom `glob` operation replaces `fd`.
- Pi's compaction defaults are `reserveTokens` 16,384 and `keepRecentTokens` 20,000.

## Diagnosis and alternatives

1. **Replaced prompt.** `resources.ts` returned the whole role text from `getSystemPrompt()`, so the model never saw Pi's tool list or tool rules. The objective and plan were also sent twice: in the prompt and again as a JSON first user message.
2. **Sequential tools.** Every tool was registered with `executionMode: "sequential"`. The cause recorded for it was the per-tool checkpoint: the host snapshots the workspace with `git add -A` on each tool start and end, which must not overlap a running tool.
3. **120-second shell cut.** The bash operation capped every command at 120 seconds, and the prompt told the model not to run the full suite.
4. **Custom grep.** It threw "Scoped search failed or exceeded its bound" when output passed 64 KB or took 10 seconds, capped context at 5 lines and cut output at 32,000 characters.
5. **Document gate.** Unread required pages refused `edit`, `write`, `bash` and `report`.
6. **Other wrappers.** `read` refused files with a NUL byte and `Workspace.read` refused files over 2 MB; the command executor kept the last 32,000 characters; the file inventory used by `find` threw past 20,000 files.
7. **Compaction overrides.** `reserveTokens` 8,192 and `keepRecentTokens` 12,000, with no recorded reason.

For the checkpoint race, the alternatives were: keep tools sequential (rejected: a symptom fix that keeps the cost), lock the workspace per tool (rejected: adds a mechanism), or checkpoint only at batch boundaries. The last needs no new mechanism: before the first call of a batch runs (each call's admission already waits for queued checkpoints) and after the last call ends. With one call per message it is the same as before.

For grep, Pi's options (`isDirectory`, `readFile`) cannot stop `rg` from reading `.git` and `.env` files, so stock grep would weaken confinement that `read`, `ls`, `find` and `edit` enforce. Grep stays custom, but only for which files `rg` may read; it now follows stock grep's schema, output format and truncation.

## Implementation and review

- `resources.ts`: `getSystemPrompt()` returns `undefined`, so Pi builds its default prompt; the role text goes through `getAppendSystemPrompt()`. The final-report phase adds a `host_phase` section through `before_agent_start`'s `systemPromptOptions.sections` instead of forcing a whole replacement prompt.
- `runtime.ts`: the role text keeps the meaning of the old one but includes only the sentences for the current intent. Removed: the two-minute bash limit, "do not repeatedly run a longer full suite", "Retain requirements during compaction" (the compaction prompt already says the host supplies them) and the empty placeholders ("No additional working findings"). The objective, owner instructions, approved scope and the document list are sent once, in the appended prompt, which compaction never removes; the first user message only starts the task. The task-document list moved from a fake `<trusted-task-documents>` project-instructions file into the same text. The document gate and the `sequential` mode on `read_document` are gone. Checkpoints run at batch boundaries. Compaction uses Pi's defaults.
- `tools.ts`: no `executionMode` override. Bash has no time limit unless the model passes `timeout`; output streams to Pi's own accumulator; abort and timeout produce stock bash's messages. Grep as described above. `read` has no size or NUL-byte refusal of its own and keeps Pi's truncation. `find` stops walking when it reaches its result limit.
- `workspace.ts`: `Executor` takes an optional timeout and an optional output stream; `Execution` reports `timedOut`. The 2 MB read refusal and the 20,000-file throw are removed; `files()` walks lazily.
- `documents.ts`: `unread()` removed; it only served the gate.

Changes after independent review (second commit, same day):

- **Image reads.** Custom read `operations` replace Pi's defaults as a whole, so without a `detectImageMimeType` operation a PNG came back as about 27,000 characters of mojibake once the NUL-byte refusal was gone. `read` now detects images with Pi's own `detectSupportedImageMimeTypeFromFile`, on the confined path. `autoResizeImages: false` and `images: { blockImages: true }` stay, because the current OpenAI-shaped model proxy does not carry images; revisit when the native protocol lands (another piece of this revamp).
- **Truncated bash output.** Now that output streams to Pi's accumulator, a command printing more than 50 KB has its full output written to `os.tmpdir()/pi-bash-*.log`, and the model is told that path. Pi has no option for the directory: it calls `os.tmpdir()`, which reads `TMPDIR`. For the length of a run the runtime sets `TMPDIR` to a private `outputs` directory inside the task's storage, which is disjoint from the workspace, so snapshots and diffs never include it; `read` (and no other tool) may open files directly inside it; the previous `TMPDIR` is restored and the directory removed when the run ends. Commands are unaffected: the executor gives them their own `TMPDIR`. This assumes one run at a time per process, which `CodingRuntime` enforces per instance and the bridge runs its runtimes one after another.
- **Ordered task saves.** Tools admitted together each saved the task concurrently; a save renames a temporary file, so an older state could land last. `TaskStore.save` now runs saves of one task in call order. The new test failed three runs out of three without the change.
- **Checkpoint window.** An edit sent in the same message as a long-running command is not checkpointed until that command ends, so a worker crash in that window loses the edit. Accepted: the checkpoint cannot run while a command may be writing the workspace.

`read_document` remains: the host hands long immutable evidence to the model through it (for example an approved plan over 6,000 characters, review evidence such as `candidate_inventory`, `candidate_diff` and `review_delta`, `check_failures`, `mr_feedback` and `requirement_gaps`; up to 500,000 characters each). The prompt still asks the model to read the required pages; reading them is no longer a precondition for other tools.

Remaining differences from stock Pi in the worker runtime, each with its reason:

- `read`, `edit`, `write`, `ls` and `find` use Pi's `operations` options to keep paths inside the workspace and away from `.git`, `.env` files and symlinks.
- `find` uses a custom `glob` operation because the box does not ship `fd`, and Pi would download it at run time.
- `grep` is a custom `execute` because stock grep reads `.git` and `.env` files.
- `bash` runs through the isolated executor, whose environment holds no secrets, so `exposeSessionEnvironment` is off (Pi's `PI_*` variables never reach the command).
- During a run `TMPDIR` points at the task's private `outputs` directory, which `read` alone may open, so Pi's full-output files stay outside the workspace and are removed at the end of the run.
- Tool admission still counts tools against the task allocation and blocks repository tools during final reporting (host-loop mechanics, outside this piece).

## Verification and outcome

Box disk and `/tmp`, read from the source (not measured on a box): the worker container runs `--read-only` with a 512 MB tmpfs at `/tmp` and a 1 GB tmpfs at `/home/worker` (`src/boxes/agent.ts`), but its environment sets `TMPDIR` to `/workspace/tmp`, on the box's EBS volume (60 GiB default in `deploy/boxes/boxes.json`), because "the /tmp tmpfs is too small" (`src/boxes/coding-task.ts`). The clone, task storage and therefore the bash output files are on that disk, not on a size-limited tmpfs. Pi's output-file write stream has no error listener, so a full disk would crash the worker; no guard was added.

Run locally (offline, no model calls):

- `kite --prefix coding_runtime_pi test` before the change: 124 passed. After: 128 passed, 0 failed.
- New tests in `coding_runtime_pi/tests/runtime.test.ts`: the build prompt contains Pi's read guideline and its tool list, no registered tool (including `read_document`) sets an execution mode, and bash passes no timeout to the executor; two bash calls in one message overlap and every checkpoint sees no tool in flight; a run deadline of 3 seconds kills `sleep 60` (status paused); grep excludes `.env`, `.env.local` and `.git`, reports the 100-match limit and the 50 KB limit instead of throwing, and refuses `.env` and `../` as search paths.
- Changed tests: the document-gate test now checks that an edit before reading `approved_plan` succeeds; `planning-headroom` reports 20,000 prompt tokens instead of 28,000 so the fixture stays below Pi's default compaction threshold for its artificial 40,000-token window (the test is about the final-report output budget, not compaction).
- Repository tests: `tests/coding-pi-review-evidence.test.ts` no longer asserts `unread()`. In `tests/coding-model-profile.test.ts` the reviewer-recovery fixture failed in its "format" case: its models are missing from any catalog, so they fell back to a 32,000-token window, Pi's default compaction ran during review and summarised away the inventory pages the scripted reviewer checks for. The fixture now gives its three models a 128,000-token window, as a catalog would.
- `kite run check` in the repository root: TypeScript 1,709 tests, 1,708 passed, 1 skipped, 0 failed; Python coding runtime 77 passed; Pi package 128 passed. `kite run format:check` passed. The first full run, before the two repository test changes above, failed exactly those two tests. After the review changes: Pi package 133 passed; root `kite run check` TypeScript 1,709 tests, 1,708 passed, 1 skipped, 0 failed; Python 77 passed; `kite run format:check` passed. Each new guard test was run against a reintroduced regression (a `sequential` `read_document` wrapper, a forced final-phase prompt, a 120-second default in `localExecutor`) and failed.

Inferred, not measured: a real job whose models are missing from the catalog also gets the 32,000-token fallback, and with Pi's defaults it compacts from about 15,600 tokens instead of about 23,800. The fallback, not the compaction setting, is the thing to fix if that happens.

Not measured: whether a real coding job now uses `read`/`edit`, issues several calls per message, or finishes faster or cheaper. That needs a real job after deployment.

## Follow-up and next iteration

- The planning budget (32 navigation operations or ten minutes) and the final-report phase remain in `runtime.ts`; they are host-loop mechanics for the session restructure.
- The per-run tool and model allocations remain.
- `images: { blockImages: true }` and `autoResizeImages: false` remain until the native model protocol carries images.

> **Update, 13 November 2026 ([journal 190](190-pi-native-anthropic-protocol.md)):** with the native Anthropic protocol both overrides are removed, so image reads follow Pi's defaults (resized and sent as image blocks). Tested: a PNG the model reads reaches the fake Messages API as a base64 `image` block inside the `tool_result`.
