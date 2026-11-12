# 191 — Go gate, no planner

Work date(s): 2026-11-13. Written/revised: 2026-11-13.
Status: implemented and tested offline on branch `coding-revamp/d1-go-gate` from `991004f2` (main with pieces A, B and C). Independent review, merge, release and a worker image are pending. Stage D1 of piece D in [the coding-loop specification](../coding-simple-loop.md).

## User-visible problem and preceding iteration

Before this change every coding job started with a planning attempt in a box: a planner session on `leaderModel`, a plan check by the reviewer model with one plan repair, then a Start card with the plan attached and Start and Change buttons. The owner taps Start without reading the plan ([journal 151](151-review-that-looks-for-failures.md)), so the planner, the plan check and the repair existed only to protect a document nobody reads. The first full job ([journal 179](179-first-full-coding-job-review.md)) showed the planning attempt as one of the stages that each start a fresh session and add cost before any work.

The specification's step 1 replaces all of it with a go gate: `coding_start` sends the goal in one or two lines with a Start button, nothing runs before Start, and each further owner message before Start is added to the request and replaces the card.

## Evidence

- **Verified in source (before):** `coding_start` inserted `state='queued'`, `mode='plan'`; the tick started a planning attempt; `runPiWorker` ran the planner, `checkPlan` and `planGaps`, then finished `plan_ready` with a `requirements` payload; `deliver()` sent the plan as a document with a caption naming the planner and the check result; `coding_reply` on `plan_ready` set `state='queued'` (a replan).
- **Verified in source (before):** caps on the request: `codingStart.objective ≤ 8,000`, `context ≤ 16,000`, `codingReply.message ≤ 8,000` characters, `assertCodingBrief` (70,000 bytes for the old single-request envelope), a 24,000-character follow-up check, and the Pi runtime's 24,000-character objective and 32,000-character instructions refusals.
- **Checked by the orchestrator (read-only, 13 November):** production has no Pi job in `plan_ready`, `awaiting_input`, `paused` or `failed`; one dormant job (`pr_ready`/`pr_ready`, Pi, no `prWorkflow`) exists; the owner has no stored coding model choice, so `config/coding-pi.json` decides.
- **Checked in Pi's catalogue:** `claude-sonnet-5-5` and `claude-opus-5-5` both have a 1,000,000-token window and 128,000 output tokens, so the profile's `maxOutputTokens` 128,000 and `reviewerMaxOutputTokens` 64,000 fit both. Both have direct routes in `config/model-policy.json`, which piece B's `assertDirectPiModels` requires.

## Diagnosis and alternatives

The planner and the plan check were added to contain a risk (a plan dropping a requirement) that only exists because there is a plan. Removing the plan removes the risk; the reviewer now checks the candidate against the owner's own words. The request caps existed for the old single-request envelope; Pi sends the request once in its system prompt and compacts with its own defaults, so no cap is needed.

Rejected: keeping the planner behind a flag for older jobs (the rules forbid a dual flow, and no job is open); a "revise" button (Change) instead of another message (decision Q4); keeping `legacyRequirementScope` (decision Q7).

## Implementation and review

Host:

- `src/coding/controller.ts`: `coding_start` inserts the job as `plan_ready`/`awaiting_start` with an empty plan and writes the first Start card (`requirements:1:start`) in the same statement. `coding_reply` on a job that is not running (`plan_ready`, and for now `awaiting_input`, `paused`, `failed`) appends `Owner follow-up: …` to `context`, bumps the revision, returns the job to `plan_ready`/`awaiting_start` and writes a new card for the new scope; the statement also requires the context and checkpoint it read. `coding_resume` requeues only an `implement` job that is not waiting for Start. The tick, `authenticate` and therefore every worker route refuse a job that is not in `implement` mode with the owner's approval of its current request. The plan branches of `finish`, `piMessages` (the `leader` role for Pi), `validateReportCheckpoint` and `freshSession` are deleted; `assertDirectPiModels` and the assignment's `nativeModels` no longer read `leaderModel`. The card is `**Ready to start**`, the objective's first two non-empty lines and `Coder: … Reviewer: …`; no attachment. `coding_job_update` no longer offers a planner for Pi jobs, and the settings-change approval carry (which only served the old scope) is deleted.
- `src/coding/requirements.ts`: `startCard()`; one scope (`legacyRequirementScope` deleted); `request()` sends a fresh card for a job waiting for Start and no longer needs a plan.
- `src/coding/schema.ts`: `mode` and the character limits on `coding_start` and `coding_reply`, `piState.planCheck`, `piState.phase` `plan`, `settings.planCheck`, the `plan_ready` outcome kind and `assertCodingBrief` are deleted.
- `src/coding/delivery.ts`, `src/main.ts`, `src/telegram.ts`: the document transport and the Change button are deleted; the callback accepts only `cod:yes`; the acknowledgement says "Started."
- `src/runtime.ts`, `src/open-loops.ts`: the tool descriptions and open-loop labels explain the Start card and that messages before Start add to the request.
- `config/coding-pi.json`: `model` `anthropic/claude-sonnet-5.5`, `reviewerModel` `anthropic/claude-opus-5.5`, `effort` `medium`; `leaderModel` and `planCheck` removed.
- `src/coding/automation.ts`: one-line change to the single scope (stage D3 owns this function).
- `src/coding/worker.ts` (legacy Node): keeps its own copy of the brief check, because that worker still sends the whole brief in one request. No other legacy change.

Worker:

- `src/coding/pi-worker.ts`: refuses a `plan` assignment before its first heartbeat. `piPlanCheckInstructions`, `checkPlan`, `planGaps`, the planner model, the `plan_ready` finish and the plan-phase checkpoint branches are deleted. The reviewer prompt names the owner's request as the scope and has no plan or `approved_plan` document.
- `coding_runtime_pi/src/runtime.ts`: the planning budget (32 navigation operations or ten minutes), the Requirements-section and planning-handoff text and the objective and instructions length refusals are deleted. The build prompt says the host verified that the owner started this exact request. The plan-era API (`learn`/`plan` intents, `approve`, `reply`) stays for the CLI and security smoke until stage D2, so the worker still hands the runtime an approved empty plan.

Caps removed and kept:

| Cap                                                                                     | Decision                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `coding_start` objective 8,000, context 16,000; `coding_reply` message 8,000 characters | Removed. Storage is Postgres `text` with no length check (`db/024_coding.sql`); the worker receives the assignment as one JSON response, which the host does not bound. Nothing else requires a bound. |
| `assertCodingBrief` 70,000 bytes; 24,000-character follow-up check                      | Removed from the host. The legacy Node worker keeps its own copy.                                                                                                                                      |
| Pi runtime objective 24,000 and instructions 32,000 characters                          | Removed (stage D2's list), because a request the host now accepts would otherwise be refused in the box after Start.                                                                                   |
| Planning 32 operations or ten minutes; plan check ten minutes                           | Removed with the planner.                                                                                                                                                                              |
| `requestKey` 100 and model id 120 characters                                            | Kept: identifiers, not the request.                                                                                                                                                                    |
| Start card text: first two lines, 300 UTF-16 units                                      | Presentation of a one-message card; the request itself is stored and sent whole.                                                                                                                       |
| Start card 24 hours                                                                     | Kept: approval freshness.                                                                                                                                                                              |

Interim behaviour, replaced in stage D2: a `coding_reply` after Start reaches a job only while it is stopped (a question, a pause or a failure). It is appended to the request and returns the job to a new Start card, because the approval hashes the request. A reply while the job runs is refused as before. The job keeps its files and patch; the next build starts a fresh coder session on them, because the build identity hashes the request, and its review and session state is reset (see the update below).

> **Update, 13 November 2026 (review of PR 483):** the sentence above first said the job keeps its session state and continues from it. That was wrong when written: the build identity hashes `context`, so a fresh coder session always started. Worse, the reply kept the review-phase state of a job stopped in review, and the next build then failed on every attempt ("Retained reviewer identity does not match the approved candidate"). The reply now keeps the files, patch, tool count and any PR-feedback round, and resets the review and session fields of `piState`, so the build phase starts cleanly. A worker-level test stops a job in review, replies, taps Start and sees the build run and the review approve.

Tests: `tests/coding-go-gate.test.ts` (new), and the planning cases rewritten in `coding-pi-bridge`, `coding-reasoning`, `coding-confirmation-telegram`, `coding-delivery`, `coding-requirements` (via the fixture), `coding-report-contract`, `coding-model-profile`, `coding-pi-messages`, `coding-squad` and others. Deleted: `tests/coding-plan-check.test.ts`, `tests/coding-pi-context-profile.test.ts` (the planning handoff after 32 reads), `coding_runtime_pi/tests/planning-headroom.test.ts` and the runtime's planning-budget cases.

## Verification and outcome

Run locally on 13 November 2026, offline with the repository's fakes (no paid model call):

- `kite ci`, `kite run build:pi`: passed.
- Each coding test file on its own (`kite exec tsx -- --test tests/coding*.test.ts tests/open-loops.test.ts`): all passed. `tests/coding-go-gate.test.ts`: 9 of 9. `coding_runtime_pi` tests: all passed (`runtime.test.ts` 45 of 45).
- `kite run check` with the Python venv active: passed (types; TypeScript tests 1,743 passed, 1 skipped, 0 failed; the legacy Python runtime's checks and 62 tests; `coding_runtime_pi` 75 of 75 and the other suites). `kite run format:check`: passed.

What the new tests show: `coding_start` writes one Start card and no box, model call or `coding_model_calls` row follows, however often the tick runs; Start queues `implement` and the worker's assignment carries an empty plan and the request; a message before Start bumps the revision, appends the text, replaces the card, the old card is refused and the new one starts the job; an identical retry is idempotent and the same key with other text is refused; an unsent card for an older request is never delivered; an expired card is refused and `coding_resume` sends one that works; a job forced into the queue without Start gets no box, and a running attempt whose job lost its Start (mode or context changed) cannot authenticate; the Pi worker refuses a `plan` assignment before any other request; a reply to a stopped job returns it to a Start card with its files kept; a dormant `pr_ready` row of the old shape (a planner, a plan check, a saved plan) passes through ticks, delivery and status unchanged.

Not verified: a real job on a worker image; Telegram rendering on a phone.

### Review of PR 483 (13 November 2026)

Two independent reviews: the safety review approved (no path past the gate); the correctness review asked for fixes, made in a second commit:

- The reply to a job stopped in review (above).
- A model change through `coding_job_update` while a job waits for Start now moves the revision on and writes a fresh Start card in the same statement, so a card that showed the old models can no longer start the job; the owner notice says to tap Start, not to resume. Tested.
- The Start card's goal and model ids are cut first and then sent as plain text after the formatted header, so a Markdown link or markup in the goal, or a cut through it, cannot change the card. Tested with a link and with a cut inside bold markup.
- The decline path is deleted: no `cod:no` handler, no typed "no"/"not yet" decision, no `revise` decision in `requirements.confirm`, no "owner asked for changes" open-loop label. A typed "no" replying to a Start card is now an ordinary message to Chief, which treats it like any message before Start (normally `coding_reply`, so it joins the request and a new card follows).
- Older jobs: stored settings with `planCheck` and checkpoints with `piState.phase = "plan"` no longer pass the worker's strict schemas. No such job can get a worker in production (all are cancelled or finished), so there is no compatibility path. If one ever did, the worker would exit with code 1 at its first assignment parse; the host pauses the job as "The coding box stopped before a result was recorded (the worker stopped on an unexpected error)", the automatic transient retry runs at most once, fails the same way, and the job stays paused. There is no loop.
- Accepted, by the owner's rule that limits are added only when real use shows a need: there is no cap on the number of jobs waiting for Start or on request size.
- For stage D3: the PR-feedback requeue in `automation.ts` does not re-check approval, so a job approved under the deleted legacy scope would requeue and then be paused by the tick ("The owner must tap Start on the current request before any work") with no card. D3 owns that path.

## Deployment status

Not deployed. The host change needs the gateway release; the worker change reaches jobs only through the new worker image pinned after stage D3. No coding job should be started between the host release and the pin (specification, "Build and rollout").

## Follow-up and next iteration

- Stage D2 replaces the interim reply-after-Start with the job inbox, removes the runtime's plan-era API (`learn`/`plan` intents, `approve`, `reply` with its 8,000/24,000 caps, `planHash`, the `approved_plan` document) and the reviewer prompt's receipt cut (its reason, the runtime's 32,000-character refusal, is gone), and rewords `src/coding/progress-text.ts` ("Plan ready for your approval").
- Stage D3 removes the remaining `leader` plumbing (`coding_model_set` role, `coding_job_update.leaderModel` for squads, `outputAllowance` role, `generate`).
- The base commit is resolved at `coding_start`, so a Start a day later builds on a day-old base; stage D3's rebase handling covers a conflict.
