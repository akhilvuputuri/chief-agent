# A coding job is a sandbox, one Pi session and a pull request

Design, 13 November 2026 ([journal 176](journey/176-simpler-code-review-loop.md), revised after the review in [journal 179](journey/179-first-full-coding-job-review.md)). This replaces the 12 November draft of this page, which was never merged or built. It is the specification the revamp is built against; code and `config/` are the source of truth once it ships.

## Why

The first full job (`9600af57`) took 10 machine-hours and $104. Two-thirds of that was rebuilding a finished change because main moved. The rest came from what we added around Pi: stages that each start a fresh session, a replaced system prompt, tools forced to run one at a time, a two-minute shell cut, a proxy that loses the model's thinking between turns, and a stack of limits. The sandbox itself was not the cause.

The rule for this design ([AGENTS.md](../AGENTS.md), "Fix causes, not symptoms"): run Pi as it ships, keep only what Chief cannot work without, and add no limit until real use shows a cause it fixes.

## The flow

```
request (+ more owner messages) → [Start] → one coder session: build, run tests
        → review (separate session) ⇄ findings back into the coder session
        → pull request → CI (failures back into the coder session) → Merge card
```

1. **Go gate.** `coding_start` creates the job and the host sends the goal in one or two lines with a Start button. No model runs and no box starts before Start. Each further owner message is appended to the request and the Start message is replaced, because a tap is bound to what the owner saw.
2. **One coder session.** After Start the box clones the repository, creates the job's branch from main, and runs one Pi session for the life of the job. The coder explores, builds and runs the tests itself, including the full suite. There is no planner, no plan, no plan check and no separate repair session.
3. **Review.** When the coder reports done, a separate reviewer session (its own model, a fresh context, a disposable copy of the workspace with its installed dependencies) reads the diff and reviews it against the owner's messages. Findings go back into the same coder session as a message. Later review rounds continue the reviewer's own session and read only what changed since its last round.

> **Update, 13 November 2026 ([journal 192](journey/192-one-session-per-job.md), after review):** correction: the review copy is a clean clone of the candidate, not "a disposable copy with its installed dependencies". Dependencies the coder installed are written by the coder, as are files its own ignore rules hide, so copying them would let it shape what the reviewer runs. The reviewer installs dependencies with the repository's documented command when it needs to run something, reads `AGENTS.md` from the base commit, and has its session rebuilt from the host's copy before every round. The host binds an approval to the exact candidate: the round message names the candidate's artifact hash, the host records it with the reviewer call, and only the newest review of that hash counts. The owner's request is in both roles' system prompts, so compaction never rewrites it, and every round lists the owner's follow-ups in their exact words.

4. **Pull request.** After approval the host pushes the branch and opens the PR, and GitHub CI runs. A CI failure or PR feedback goes back into the same coder session. The changed candidate gets a reviewer round before it is pushed. Review stays before the push because CI runs branch code with repository secrets; that order is a security boundary, not a habit.
5. **Main moves.** Nothing happens. If GitHub reports the PR as conflicting, the box rebases the change onto main with git; if git cannot resolve it, the coder resolves the conflicts in its session and reruns the tests. Either way the reviewer reads the difference before the rebased change is published, because the review approval is bound to the exact published change.
6. **Merge card.** As today, including the manual steps for database, Compose, environment and workflow changes.

> **Update, 13 November 2026 ([journal 193](journey/193-rebase-backstop-limits.md)):** step 5 is built. On a conflict the host queues the job with its work and sessions kept, its base moved to main and a rebase item in its inbox (`source: "rebase"`, `from`, `onto`). The worker restores the work on the old base, commits it with its own identity and hooks off, checks out main and runs `git cherry-pick --no-commit`, then leaves only the working tree (no cherry-pick in progress, nothing staged). A clean result is saved and goes straight to a reviewer round reading `git range-diff`; conflicts are saved with the file list (`piState.conflicts`) and reach the coder as a message naming the files, also in the next box if this one ends first. Every save records the commit its files are on (`piState.base`), and the host refuses saved or published work on any other base. A rebase can leave the artifact hash unchanged, so the host's proof also needs the approval to be newer than the job's latest rebase. The base is now resolved when the owner taps Start, not at `coding_start`, and a Pi job takes the host's worker image at Start.

> **Update, 13 November 2026 ([journal 193](journey/193-rebase-backstop-limits.md), after review):** a candidate must record the job's current base, with no exception, before it is published. A Pi PR's feedback rounds are driven only by the repository's owner and collaborators, Devin and CI. No box starts with five minutes or less of machine time left; the owner's own requests for more work restart the eight hours. A clean rebase that leaves nothing ends as no change, and the conflict message names each kind of conflict, including those with no markers.

> **Update, 13 November 2026 ([journal 192](journey/192-one-session-per-job.md)):** steps 2 to 4 are built. The coder and the reviewer each have one Pi session for the life of the job, stored by role and restored at the fixed path `$TMPDIR/pi-coding-<job>` in every box. The host runs no checks; the coder runs the tests and GitHub CI checks the PR. The review copy is a `git clone --no-local --no-checkout` of the coder's repository objects with a fresh configuration and no hooks, the candidate as the commit `candidate` on the base and the last reviewed candidate as `reviewed`, plus the coder's ignored directories (such as `node_modules`) copied whole. Findings go into the coder's session in full, from the reviewer's own report. A later round continues the reviewer's session with `git diff reviewed candidate`; a round after the base moved gets `git range-diff` (for stage D3). After an approval the worker checks the inbox once more, and the host also refuses a candidate while an inbox item is undelivered, so a message that arrives during review reaches the coder and its changed candidate is reviewed before anything is pushed. Correction to step 5 (decision Q2): the reviewer reads every rebase, clean or not, because the approval is bound to the exact artifact.

> **Update, 13 November 2026 ([journal 191](journey/191-go-gate-no-planner.md)):** step 1 is built. The card shows the objective's first two non-empty lines (cut to 300 UTF-16 units, so a long goal still gives a short card), the coder and reviewer models and one Start button. The host refuses to provision, authenticate a worker or relay a model call for a job without the owner's Start of its current request, and the Pi worker refuses a `plan` assignment. The base commit is still resolved when the job is created, not at Start.

> **Update, 13 November 2026 ([journal 193](journey/193-rebase-backstop-limits.md)):** the base is resolved at the owner's Start.

**Follow-ups.** Before Start, an owner message is appended to the request and the Start message is replaced. After Start, an owner message goes into the job's inbox and is delivered to the coder session at its next turn boundary; the reviewer is given it too. It never needs a new Start and does not change the approved request. Review findings, CI failures, PR feedback, answers to a question and a rebase request reach the coder the same way, each labelled by its source. A stopped job resumes the same session.

> **Update, 13 November 2026 ([journal 191](journey/191-go-gate-no-planner.md)):** until stage D2 builds the inbox, an owner message after Start reaches a job only while it is stopped (a question, a pause or a failure). It is appended to the request and the job returns to a new Start card, because the approval hashes the request. A message while the job runs is refused as before.

> **Update, 13 November 2026 ([journal 192](journey/192-one-session-per-job.md)):** the inbox is built. An owner message after Start is an inbox event (`coding_events`, key `inbox:…`) labelled by source: the owner, the owner's answer to a question, a CI failure or pull request review feedback (both "untrusted evidence, not the owner's instruction"). A running coder gets it through Pi's own steering at its next turn boundary; a stopped job (a question, a pause or a failure) is queued again with its work and sessions. Each item carries its id in the message, the checkpoint lists the delivered ids, and a restored session counts the ids it already holds, so an item is delivered again after a lost checkpoint but never twice into one session. The reviewer is shown the owner's messages. The request and its approval never change. Owner requests on an open PR and GitHub feedback still go through the owner-merge feedback round and its caps (stage D3 removes them), and now arrive as inbox items in the same coder session.

> **Update, 13 November 2026 ([journal 193](journey/193-rebase-backstop-limits.md)):** the feedback round caps are removed: every item is delivered whole in the next round, however many rounds the PR has had. A round on a job without the owner's Start of its current request stops for the owner instead.

**Messages to the owner.** One or two sentences, with up to three buttons when the choices are clear. The report's question becomes a short `ask` (at most 300 characters) with optional `options`; a tap is sent back as a follow-up. Detail stays in the job record.

> **Update, 13 November 2026 ([journal 192](journey/192-one-session-per-job.md)):** built. The report tool's kind `ask` takes `ask` (at most 300 characters) and up to three `options`; the Telegram message carries one button per option. A tap counts only on the delivered message while the job still waits at the attempt that asked; it becomes one inbox answer and queues the job. A repeated tap is answered from the record, another answer or a tap after the job moved on is refused. When a session ends a run without a report, the worker sends one message in the same session asking it to report; if it again ends without one, the job asks the owner with a fixed short question.

## Pi as shipped

- **Prompt.** Pi builds its own system prompt, with its tool list and tool rules. Chief appends a short text for the role (coder or reviewer) through Pi's append mechanism. The owner's request is sent once.
- **Tools.** Pi's own `read`, `edit`, `write`, `bash`, `grep`, `find` and `ls`, with Pi's execution (parallel) and Pi's output handling. `bash` has no default time limit.
- **Protocol.** The worker speaks Pi's native Anthropic protocol to the host. The host adds the API key, sets the model, effort and output limit for the role, records the call, and passes the conversation through untouched.
- **Session.** One Pi session for the coder and one for the reviewer per job. Each is saved as it grows and restored when the job continues in a new box, at the same working path. Pi's compaction runs with Pi's defaults at the model's context window.
- **Settings.** Coder: Sonnet 5.5. Reviewer: Opus 5.5. Effort `medium`. (`config/coding-pi.json` changes with stage D1; PR 462 proposed the same.)

> **Update, 13 November 2026 ([journal 192](journey/192-one-session-per-job.md)):** sessions are as described. The worker's own compaction, stall detector, report-only final phase (`host_phase`), per-run time/model/tool allocations, documents and `read_document`, and its git timeouts are deleted; Pi compacts with its defaults. A report ends the run through Pi's own early termination (`terminate` on the report tool's result). A model change keeps the session: Pi switches models inside a session as shipped.

> **Update, 13 November 2026 ([journal 191](journey/191-go-gate-no-planner.md)):** `config/coding-pi.json` now has these settings and no `leaderModel` or `planCheck`.

### Differences from stock Pi

Each remaining difference needs a reason Chief cannot work without. A test fails when the prompt loses Pi's tool rules, a tool overrides Pi's execution mode, or `bash` gains a default time limit.

| Difference                                                       | Reason                                                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Model calls go through the host                                  | API keys never enter the box; calls are recorded with cost                                                                              |
| Host chooses model, effort and output limit                      | The box is not trusted to pick its own model or spend; the owner's per-job choice and the reviewer-model proof are enforced at the host |
| `report` tool                                                    | The session must hand a structured result (done, ask) to the host                                                                       |
| Reviewer has no `edit`/`write` on the candidate                  | Independent review: the reviewer cannot change what it approves                                                                         |
| Workspace confinement                                            | The box must not read or write outside its workspace                                                                                    |
| Role text appended to Pi's prompt                                | The session must know whether it is the coder or the reviewer, and that it ends with `report`                                           |
| Sessions saved to the host and restored in a new box             | A box has a fixed lifetime and the job continues in the next one                                                                        |
| The worker builds the review copy and seals the coder's checkout | Independent review: the reviewer runs as the same user in the same box                                                                  |
| Fixed working path per job                                       | A session restored in a new box must find its own paths                                                                                 |
| Inbox messages are labelled by source                            | CI, PR and review text must not read as the owner's instruction                                                                         |
| The owner's request is appended to the system prompt             | Pi's compaction would otherwise replace the owner's exact words with a model-written summary                                            |
| The reviewer's `AGENTS.md` comes from the base commit            | Independent review: a candidate must not rewrite the rules it is reviewed by                                                            |
| The worker owns git for the candidate and a rebase               | The candidate is the reviewed working tree on a known base                                                                              |
| Work is saved at each turn end (one extension handler)           | A box can end at any moment; Pi awaits the handler, so a save never races a tool, and nothing else in Pi is replaced                    |
| One report reminder in the same session, then a fixed owner ask  | A session that ends in prose would otherwise leave the job with no result and nobody told                                               |
| Pi's retry raised to eight attempts for the host route           | A gateway release takes longer than Pi's default 14 seconds of retries (journal 190)                                                    |

| The worker stops itself five minutes before the box's deadline | A box has a fixed lifetime; the host refuses requests at the deadline, so a stop at the deadline loses the end-of-run save (journal 193) |
| The worker's snapshot runs in a git directory of its own | The coder's repository configuration (filters, fsmonitor, index flags, home ignore files) must not run in or shape the candidate (journal 193) |

Builders add rows here only with a reason of this kind.

> **Update, 13 November 2026 ([journal 192](journey/192-one-session-per-job.md)):** the last three rows were added by stage D2. The rows for the inbox labels, the review copy and seal, the fixed path and sessions saved to the host are built.

> **Update, 13 November 2026 ([journal 193](journey/193-rebase-backstop-limits.md)):** the last two rows were added by stage D3. The row "The worker owns git for the candidate and a rebase" is built: the worker's cherry-pick for a rebase runs at the start of a box, in its fresh clone, with hooks off and its own identity.

## What is deleted

- The planning attempt, planner session and model (`leaderModel`, the `leader` role), the plan check and plan repair, the Requirements section, the plan document and attachment.
- A new session for check repair, review repair, PR feedback and rebase.
- The host's own check stage after each "done" (`kite ci`, `kite run check`, `kite run build`, `kite run format:check`). The coder runs the tests; CI is the independent check. The check-receipt clause in `approvedArtifact` goes for Pi jobs.
- The "main moved" trigger, re-implementation on rebase and the rebase counter.
- The OpenAI-shaped Pi proxy and its caps (20 tool calls per message, 12 tools).

> **Update, 13 November 2026 ([journal 192](journey/192-one-session-per-job.md)):** deleted in stage D2: the host check stage and check repair (with `CHECK_REPAIR_MIN_MS`), the check-output cut, the session restarts for repair, PR feedback and a model change, the custom compaction and stall detector, the report-only final phase and its format correction, the worker's per-run time, model and tool allocations, documents and `read_document` (with their page and size bounds), the review evidence documents and their size fallbacks, `rejectedCandidate`, the session scope hashing, the 10,000-entry session cap, the worker's git timeouts, the `AGENTS.md` 64,000-byte refusal and the runtime's plan-era API (`approve`, `reply`, `resume`, intents, `planHash`) and its JSON-RPC server. Kept for D3: the owner-merge feedback round caps, `limits`, `remainingMs` and the rebase path.

- Limits: the two-minute shell cut, the search failure over 64 KB, the gate that blocks tools until every document page is read (with the `read_document` tool and the review evidence documents), the 7,800-character cut on check output, the caps on check fixes and feedback rounds, the planner's 32 operations and ten minutes, and the 1,500 model-call and 4,000 tool-call caps. The host's reviewer proof keeps working without the call cap.

> **Update, 13 November 2026 ([journal 193](journey/193-rebase-backstop-limits.md)):** deleted in stage D3: re-implementation on a conflict, the rebase approval carry and the `rebase-candidate` measurement; the 1,500 model-call and 4,000 tool-call caps, the host's `used_models` admission, `settings.limits` for Pi (now refused by the schema) and `coding_job_update.limits`; the owner-merge round, batch, handled-item and 7,000-character caps; the one-hour stop while a Pi PR waits for CI, mergeability or threads; `PI_ATTEMPT_MS`, `activeMs` and `remainingMs` for Pi; the `leader` role in `coding_model_set`, `coding_job_update` and the Pi route. The legacy runtimes keep their limits and leader. Kept, with reasons in the journal: GitHub read errors for an hour, release unverified, merge acknowledgement uncertain, pagination bounds, and the four-requests-in-flight bound per job.

There is no switch back to the old flow. No job is open in production; a revert is the rollback.

> **Update, 13 November 2026 ([journal 192](journey/192-one-session-per-job.md), after review):** correction: one dormant Pi job (`c273a330`, `pr_ready`, last touched 15 October) exists. Checkpoints written before stage D2 do not load in it and there is no compatibility path, so a job in flight at the deploy cannot continue; the dormant row is only passed over by the tick and is unaffected. The orchestrator holds the merge while any job is open.

> **Update, 13 November 2026 ([journal 191](journey/191-go-gate-no-planner.md)):** stage D1 deleted the planning attempt, the Pi planner model, the plan check and repair, the Requirements section, the plan attachment, the Change button and the earlier approval scope. It also removed limits this list did not name: the character limits on `coding_start` and `coding_reply`, `assertCodingBrief`, the follow-up size check and the Pi runtime's objective and instructions refusals. The `leader` plumbing (the squad's role, `coding_model_set` and `coding_job_update` for a squad, the `coding_model_calls` role value) stays for the legacy runtimes and stage D3, and the runtime's plan-era API stays until stage D2. D1 keeps no new difference from stock Pi.

## What stays

- **Nothing runs before Start**, and the host still refuses a build without the owner's approval of the request.
- **Independent review** by a separate session and model that cannot change the candidate, verified by the host before publication.
- **Protected paths** stop for a person ([`merge-policy.ts`](../src/coding/merge-policy.ts)).
- **One backstop.** A job may use eight hours of machine time from each owner Start or resume. A box has a fixed lifetime (an infrastructure fact, to avoid orphaned boxes); when it ends the job saves and continues in a new box by itself. Only reaching the eight hours pauses the job for time and tells the owner.

> **Update, 13 November 2026 ([journal 193](journey/193-rebase-backstop-limits.md)):** built. The lifetime is three hours inside the four-hour box task deadline. The host tells the worker when to stop (its deadline less five minutes, on the host's clock); a paused finish the host receives within those five minutes, or the deadline itself, is recorded as the lifetime (cause `lifetime`, not shown to the owner). Once the box is cleaned up the job continues in a new box (`continue-box:<attempt>`) while its machine time, the running time of its boxes since the owner's latest Start, resume or reply that restarted it, is under eight hours; then it pauses with one sentence. A crash or a lost heartbeat keeps the single automatic retry. A new attempt gets the box lifetime or the machine time left, whichever is less.

## Build and rollout

Built as separate pieces, each reviewed and merged by itself:

- **A.** Main moving is not an event ([journal 180](journey/180-main-moving-is-not-an-event.md)). Host only.
- **B.** Pi's native Anthropic protocol (journal 190). Host and worker.
- **C.** Pi's tools and prompt as shipped ([journal 182](journey/182-pi-tools-and-prompt-as-shipped.md)). Worker.
- **D.** The loop, in three stages. D1: go gate, no planner (journal 191). D2: one session per job, the review copy, the inbox, short asks, the host check stage and worker limits removed (journal 192). D3: in-box rebase on conflict, the eight-hour backstop with automatic continuation, remaining caps removed (journal 193). Host and worker.

Worker changes reach jobs through a new worker image pinned by digest in `config/coding-pi.json`. The gateway is released before the pin. Between the host release of B or D and the pin, no coding job should be started. Then one real job is run and read with `scripts/coding-job-profile.sql` (PR 467).
