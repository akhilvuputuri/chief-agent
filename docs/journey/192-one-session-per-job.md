# 192 — One session per job, the review copy, the inbox and short asks

Work date(s): 2026-11-13. Written/revised: 2026-11-13.
Status: implemented and tested offline on branch `coding-revamp/d2-one-session`, stacked on stage D1 (`bd7343e8`, [journal 191](191-go-gate-no-planner.md)). Independent review, merge, release and a worker image are pending. Stage D2 of piece D in [the coding-loop specification](../coding-simple-loop.md).

## User-visible problem and preceding iteration

After stage D1 a job starts at a Start card with no planner, but the box still ran the loop the first full job ([journal 179](179-first-full-coding-job-review.md)) showed to be wasteful: a fresh Pi session for every check repair, review repair, feedback round and model change; the host's own `kite ci`/`check`/`build`/`format:check` after every "done", with up to two repair sessions on a 7,800-character cut of the output; a reviewer that read host-built evidence documents page by page in a fresh session each round, on a fresh GitHub clone without dependencies; a custom compaction and stall detector in place of Pi's; a report-only final phase; per-run time, model and tool allocations; and an owner message after Start that could only return a stopped job to a new Start card.

## Evidence

- **Verified in source (before):** `runPiWorker` derived the session scope from objective, context, plan, base, intent and a round or feedback hash, and its root was `mkdtemp(tmpdir()/pi-coding-)`, so a session restored in a new box named paths that did not exist (a latent bug the plan noted). `fixFailedChecks`, the review loop and `mrFeedback` each set `sessionFile = undefined`. `CodingRuntime.run` replaced Pi's compaction through a `session_before_compact` handler, ended a run after three unchanged eight-turn windows, and after a prose ending ran a report-only phase with a `host_phase` prompt section and one format correction.
- **Verified in source (before):** `finish` refused a Pi candidate without passing receipts for the three `kite run` checks; `approvedArtifact` required the same receipts at the merge gate; `pi-sessions.ts` refused a scope past 10,000 entries.
- **Verified in Pi 1.1.0:** `AgentSession.steer` queues a message that Pi delivers after the current tool batch, before the next model call; a tool result with `terminate: true` ends the agent loop after its batch when every result in the batch terminates; Pi awaits extension `turn_end` handlers before the next call and swallows their errors (`ExtensionRunner.emit`); session events `compaction_start`/`compaction_end` mark Pi's own compaction.
- **Verified in pi-ai 1.1.0 (`dist/api/anthropic-messages.js`):** the keys Pi writes on each content block, used for the host allowlist below.

## Diagnosis and alternatives

Every item above was something Chief added around Pi; each was removed rather than bounded. The few differences kept have a reason Chief cannot work without, listed in the specification's table:

- **One session per role per job at a fixed root** (`$TMPDIR/pi-coding-<job>`): a session continues in the next box at the same paths. Scopes are `sha256("coder:"+job)` and `sha256("reviewer:"+job)`.
- **The review copy** is built by the worker each round: `git clone --no-local --no-checkout --no-hardlinks` of the coder's repository (objects only: fresh configuration, no hooks; `--no-local` because git warns against local-path clones of an untrusted repository), commits `candidate` (base plus the saved files) and `reviewed` (the last reviewed base plus its patch), `core.attributesFile=/dev/null`, a fresh reviewer home each round, and the coder's ignored directories copied whole with `fs.cp` (never linked, so a reviewer write cannot reach the coder's files). The workspace seal is unchanged apart from the fixed `review` path.
- **Saving at turn ends** goes through one extension handler, because Pi awaits it before the next call and tool; saving at tool boundaries without the old admission wrapper raced the coder's own git commands. A failed save stops the run (Pi would otherwise only report it).
- **One report reminder** in the same session, then the fixed ask (decision Q3), instead of the report-only phase.
- **The inbox** (decision summary in the specification): items are `coding_events` rows labelled by source; Pi's steering delivers them; the session itself proves delivery.

Rejected: keeping host checks for Pi as a fallback (no dual flow); counting tool calls to keep the tool limit working (it is D3's to remove, and counting needs the wrapper this stage deletes); a host round trip for review findings (they go straight into the coder session); a per-option length limit on asks (no reason; Telegram shortens a long button).

## Implementation and review

Runtime (`coding_runtime_pi`):

- `runtime.ts`: roles `coder`/`reviewer`; `start({ workspace, role, base })` checks that the base is a commit in the workspace; `run(id, message)` opens or creates the task's one session in `<store>/<task>/session` and prompts the message; `steer(id, text)`; role text appended to Pi's prompt (the request is the first message, sent once); a report ends the run through `terminate`; a steered message after a report clears it; Pi's settings with only the retry count changed; compaction and cache warming are Pi's defaults. The `rm` of the truncated-output directory is in its own `finally` (plan item 1.10).
- Deleted: `context-maintenance.ts`, `documents.ts`, `rpc.ts`, `planHash`, `approve`, `reply`, `resume`, intents, checks, `checkOutput`, `defaultLimits`, the time charge in `TaskStore.get`, the model admission stream, `removeDependencyLinks` (the snapshot already drops dependency links), the 64,000-byte `AGENTS.md` refusal, and the 120-second git timeout in `snapshot` (the output bound stays; the base is now required).
- `report.ts`: kinds `done`, `review`, `ask`; each refusal names the field, its length and its bound. `tools.ts`: the reviewer has `read`, `grep`, `find`, `ls`, `bash` and `report`; the coder adds `edit` and `write`.
- `cli.ts`: `start`, `run TASK_ID MESSAGE`, `status`, `cancel` (the standalone image and its container smoke use it).

Worker (`src/coding/pi-worker.ts`): rewritten around the above: one coder task and one reviewer task per attempt, sessions restored by scope, findings into the coder session in full from the reviewer's report, rounds continuing the reviewer's session (`git diff reviewed candidate`, the same candidate, a moved base with `git range-diff`, or a resumed round), the inbox from the assignment and each heartbeat, steering into a running coder, delivery recomputed from the uploaded session, a heartbeat before publication, and a loop back when the host refuses a candidate for an undelivered item. The worker's git runs with no time limit. The "commit as you go" instruction and the coder's git identity are gone. `pi-review-evidence.ts` is deleted.

Host:

- `schema.ts`: `piState` is `{version, phase, delivered, reviewed, reportDocument}`; `outcome.options`. `checks` stays for the legacy runtimes.
- `controller.ts`: `inbox()`, inbox in the assignment and the heartbeat, `save` accepts `delivered` only as a growing list of this job's inbox ids, `finish` returns `{accepted:false, inbox}` for a Pi candidate while an item is undelivered and no longer needs check receipts for Pi, `followUp` for `coding_reply` after Start, `answerAsk`, ask buttons in `deliver`. `freshSession`, `piIdentity` and the review-session identity checks are deleted; a model change keeps the session.
- `automation.ts`: each owner-merge feedback item becomes an inbox event `inbox:gh:<id>` (source `owner`, `ci` or `review`) in the requeue statement, with the checkpoint kept. The round count now comes from the `mr-feedback:` revisions; the round, size, handled and allocation caps stay for stage D3. The interim conflict re-application keeps only `delivered`.
- `merge-policy.ts`: `approvedArtifact` drops the receipt clause for Pi. `github.ts`: the PR body names sandbox checks only when there are receipts. `pi-sessions.ts`: no entry count bound. `progress-text.ts`: "Coding started", "Review completed" and so on. `delivery.ts`, `telegram.ts`: `cdq:<index>:<event>` buttons and callback. `src/runtime.ts`: the `coding_reply` description.
- `pi-messages.ts` (piece B's two notes): each content block may carry only the keys Pi writes for its type, and the role lookup uses `Object.hasOwn`.

CI: `.github/workflows/ci.yml` checks the report contract with kind `done` instead of `plan` (a protected path). `scripts/pi-cli-container-smoke.mjs` now has the model run the reaping check as the session's own second command and asserts its tool result is not an error; the security smoke needed no change.

Caps:

| Cap                                                                                    | Decision                                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Check repairs ≤ 2, `CHECK_REPAIR_MIN_MS`, check output 7,800, check command bounds     | Removed with the host checks                                                   |
| Worker time/model/tool allocations, `reservedMs`, `defaultLimits`                      | Removed                                                                        |
| Report-only phase, one format correction                                               | Removed (one reminder, then the owner's fixed ask)                             |
| Custom compaction, eight-turn stall detector                                           | Removed (Pi's compaction)                                                      |
| `read_document` pages and sizes, `deltaIsSmall`, review receipt cuts                   | Removed with the documents                                                     |
| Session entries ≤ 10,000                                                               | Removed                                                                        |
| `reviewRound` ≤ 1,000, `freshSession` round bound, `toolsUsed` ≤ 5,000                 | Removed with the fields                                                        |
| Worker git timeouts (clone, checkout, seal, snapshot)                                  | Removed; output bounds kept as memory guards                                   |
| `AGENTS.md` ≤ 64,000 bytes                                                             | Removed                                                                        |
| Session storage 512 MB per job, entry ≤ 4.1 MB                                         | Kept: sandbox trust boundary and one-request transport                         |
| Report summary 4,000 and detail 32,000                                                 | Kept as the storage contract; the error names what to shorten (decisions file) |
| Ask ≤ 300 characters, ≤ 3 options                                                      | Added by the specification                                                     |
| Owner-merge feedback rounds 3, batch 7,600, handled 200, 7,000-character owner request | Kept for stage D3                                                              |
| Agent publication's 120-second git push and 15-second API timeouts                     | Not touched (publication, outside the loop); listed for D3                     |

Tests: new `tests/coding-one-session.test.ts` (findings into the same coder session; the reviewer's continued session reading `git diff reviewed candidate`; the copy has `node_modules` and none of the coder's git config or hooks; a coder commit does not change the candidate; steering at the next turn boundary with acknowledgement; a message during review blocks publication and the changed candidate is reviewed again; the host refuses a candidate with an undelivered item and a foreign acknowledgement; redelivery after a lost checkpoint without a duplicate in the session; CI text labelled untrusted; ask buttons, tap, double tap, other answer, a tap during cleanup and a stale tap; the Telegram callback). `coding_runtime_pi/tests/runtime.test.ts` rewritten (done with no host command, commit against the base, continued session, reminder then ask, truncated output, ask bounds and messages, reviewer without write, steering, a report reopened by a steered message, refused save, item 1.10's `stat` test and a save failure). `native-protocol.test.ts` adds a restored session with a dangling tool call through Pi's Anthropic client. Ported: owner-merge, model profile, report contract, job update, review shell (a reviewer's edits and commits in its copy never reach the candidate), Pi messages (Pi's own compaction through the host), progress text and others. Deleted: `coding-check-repair`, `coding-pi-review-evidence`, `coding-pi-mr-feedback-worker`, the review document helper, and the runtime's check-output, documents, compaction, context-stress and review-evidence tests.

## Review fixes (13 November 2026)

Three independent reviews of PR 485 asked for changes; all are in this branch.

- **Review independence.** The review copy is a clean clone of the candidate only: no dependency or ignored path is copied (the coder's ignore rules could hide an `AGENTS.md`, a fake `node_modules/.bin` tool or a config file the code imports). The reviewer's role text tells it to install dependencies itself. Its `AGENTS.md` is read with `git show <base>:AGENTS.md`. Before every round its session is rebuilt from the host's stored copy (the restore a new box uses), so the coder's shell cannot edit what the reviewer sees between rounds. The round message's first line is `Candidate under review: <artifact hash>`; the host stores that hash with each reviewer call and `hasPiReviewerProof` takes the newest review report for the hash being finished, from any attempt (each sealed result is opened with the attempt that recorded it). `finish` now checks this proof itself, inside the transaction below.
- **Inbox trust.** Each item, each review finding and each owner message shown to the reviewer is a fenced block: a header naming the source and a worker-chosen random boundary, the text with every `[inbox` and `[chief` marker broken, and `[end <boundary>]`. An item counts as delivered only when a user message holds its exact header and its end. For the host-side check (B2) `finish` runs the same validation as `save` (the delivered list only grows and names only this job's inbox): matching the stored session instead would mean decrypting the whole coder session at every finish and re-deriving the worker's fenced text, and since the box writes that session, it would prove no more than the box's own list. `finish` and the running-job path of `coding_reply` take the job row lock in one transaction, so a follow-up either lands before the inbox check and holds the candidate back, or finds the job publishing and is told to send it again on the PR. Items in one feedback batch carry a `seq`; an empty item is shown as empty. A message that arrives before a session exists, or between a run and the report reminder, is handed to Pi's steering queue and arrives at the next prompt. An answer goes to the session that asked (`askedBy` on the outcome, `to` on the item).
- **Ask options.** Each option is one line of at most 40 characters (Telegram's Bot API states no maximum for a button label, but clients cut a label that does not fit; 40 characters fit a full-width button on a phone); the report tool refuses longer ones naming the option and its length. The message lists the options in full, and a tap is labelled as the owner choosing the proposed answer N.
- **Loop and resume.** The owner's request is appended to both roles' system prompts; every review round lists all the owner's follow-ups in their exact words. A resumed coder is told how many changed files were restored on which base. The interim conflict path writes an inbox item (source `chief`) saying the base moved and the change must be re-applied; a round whose `reviewed` commit could not be built reads the whole diff. A coder that changes nothing finishes as `no_change` (state `paused`, stage `no_change`, the coder's summary in one or two sentences); nothing is reviewed or published. When the coder returns the same candidate after findings and the reviewer asks for changes again, the job asks the owner, with two answers, and the answer goes to the coder. `piState.next` records `review` (the coder finished this hash) or `finish` (the reviewer approved it), so a new box goes straight to review or straight to finishing.
- **Model slot and warming.** Requests for one job queue for the slot in arrival order (a waiter that hangs up passes its place on) instead of the second being refused. Pi's cache warmer is the only caller that asks for one output token (`core/cache-warmer.js`, `refresh`), so the worker sends those with purpose `cache_warm`; the host accepts that purpose only with `max_tokens` 1, records it, and does not count it in `used_models`.
- **Wording.** Owner-facing and model-facing text that named host checks, plans or a leader now says review and CI.

Second round of review fixes:

- **Model-call queue.** A failed claim passes the job's place on (a test fails one claim and the next call proceeds). A job may have at most four Pi requests in flight or waiting: Pi sends one turn at a time, so legitimately there are the call the host is still recording after its stream ended, Pi's next turn, one cache-warming replay, and one retry of a call whose first connection the host is still closing. A fifth gets a retryable 503, so a box cannot hold unlimited open requests on the gateway.
- **Fences.** Every line of fenced text (inbox items, findings, the coder's summary, owner messages shown to the reviewer) is quoted with `> `, so no line of it can open or close any block; delivery still needs an item's exact header.
- **Approval and the owner's word.** The proof also needs the approving reviewer call to be recorded after the job's newest owner message or answer.
- **Sessions from memory.** Pi's `SessionManager` exposes the session it holds in memory (`getHeader()` and `getEntries()`, the same content as the file's lines). The runtime hands that to the worker at each turn end and run end, and the worker uploads only those entries; the local file is never read back. Before every run, of either role, the session is rebuilt from the host's stored copy. A reviewer command that appends a forged turn to its file therefore changes nothing stored.
- **Cache warming** is accepted only when the request, apart from its output cap, has the same canonical shape as the role's previous recorded call in the attempt (the host stores each call's shape).
- **The candidate travels out of band** in an `x-chief-candidate` header the worker sets for the round, recorded with every reviewer call, so a compacted round message cannot cost a legitimate approval. The host no longer reads it from message text.
- **Publication is committed before any push.** The worker asks `publish` first: under the job's row lock the host checks the inbox and the proof, sets the stage to `publishing` and records the approved hash; only then does the worker push and open the draft PR, and `finish` requires that record for the same hash. A follow-up after the commit is told the change is being published. Nothing is pushed when the host refuses.
- **Stopping finishes.** A `no_change` or a question waits for undelivered inbox items too; the coder gets them first. A job that ends `no_change` with an open PR says so; `coding_resume` on it says there is nothing to resume without a new message; open loops describe it.
- **Disagreement** needs the same findings as last round (a hash is kept in `reviewed`); new findings on an unchanged candidate go to the coder.
- The host refuses a multi-line ask option.

The reviewer installs dependencies itself in every round, because its copy is rebuilt from a clean clone each time. That cost is accepted for independence.

Known suspects, not changed here: the artifact bounds (500 files, 1 MB per file, 10 MB in total, no binary files) can stop a job that adds large or binary assets; a git filter the coder configures can hang the snapshot until the box ends, now that the worker's git timeouts are gone.

Tests added for these: the clean copy and base `AGENTS.md`, a coder's edit to the reviewer's local session file, hash-bound approval (approve candidate 1, finish candidate 2 refused; approve 2 accepted; a later REQUEST_CHANGES overrides), hostile CI text, an empty item, nothing to change, the disagreement ask, resume straight to review and straight to finishing, the truthful resume message, the follow-up and finish interleaving, four concurrent model requests with one warm request, the 40-character option bound, early steering, and the rebase inbox item.

## Verification and outcome

Run locally on 13 November 2026, offline with the repository's fakes (no paid model call):

- `kite ci`, `kite run build:pi`: passed. `coding_runtime_pi` tests: 39 of 39.
- Every `tests/coding*.test.ts` file on its own, and `open-loops`, `openrouter-stream`, `plugins`: all passed; `tests/coding-one-session.test.ts` 8 of 8.
- `kite run check` with the Python venv active: passed (TypeScript tests 1,739, 1,738 passed and 1 skipped, 0 failed; script tests 77 of 77; the Python suites; `coding_runtime_pi` 39 of 39). `kite run format:check`: passed.
- The container smoke could not run here (no Docker daemon). A local variant of its plumbing (the CLI run directly against the same fake Anthropic server) passed, and with the check command replaced by `false` it failed on the new assertion, so the assertion is live. The daemon-reaping part needs Linux CI.

Not verified: a real job on a worker image; the container and security smokes in CI; Telegram rendering on a phone.

## Deployment status

Not deployed. The host change needs the gateway release, and the worker image is pinned right after this stage merges (not after stage D3). Checkpoints written by stage D1 do not load in this stage and there is no compatibility path, so a job in flight at the deploy cannot continue; none is open in production, and the orchestrator holds the merge while one is. The dormant October row (`c273a330`) is only passed over and is unaffected. No coding job should be started between the host release and the pin. The workflow edit needs the protected-path merge.

## Follow-up and next iteration

- Stage D3: the rebase in the box (`roundMessage` already gives a `range-diff` when the base moved; the interim conflict path now keeps the sessions but clears the files, so a conflicting job's coder continues its session on an empty candidate until D3), the backstop, `limits`, `remainingMs`, the feedback caps (the round count is now `mr-feedback:` revisions), the `used_models` admission, the leader plumbing.
- A tap on an ask while the last box is still being cleaned up is refused with "tap again in a moment"; the tick finishes cleanup within seconds.
- Cache warming is Pi's default (`streaming`): during a run, when no real request has refreshed the prompt cache for 90% of its lifetime (about 4.5 of 5 minutes), for example during a long test run, Pi replays the last request with a one-token output cap, only when it expects to save at least $0.05, and for at most an hour after the request that started it. Each refresh costs a cache read of the prompt plus one output token, against a full cache write on the next real call. The host passes it like any call (it keeps the smaller output cap) and records it. An earlier draft of this stage turned it off without a need, so it is not a difference from stock Pi.
- Pi retries a report the tool refuses as Pi does; there is no cap, so a model that keeps sending an oversized report keeps getting the exact reason.
