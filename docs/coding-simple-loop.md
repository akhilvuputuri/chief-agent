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
4. **Pull request.** After approval the host pushes the branch and opens the PR, and GitHub CI runs. A CI failure or PR feedback goes back into the same coder session. The changed candidate gets a reviewer round before it is pushed. Review stays before the push because CI runs branch code with repository secrets; that order is a security boundary, not a habit.
5. **Main moves.** Nothing happens. If GitHub reports the PR as conflicting, the box rebases the change onto main with git; if git cannot resolve it, the coder resolves the conflicts in its session and reruns the tests. Either way the reviewer reads the difference before the rebased change is published, because the review approval is bound to the exact published change.
6. **Merge card.** As today, including the manual steps for database, Compose, environment and workflow changes.

**Follow-ups.** Before Start, an owner message is appended to the request and the Start message is replaced. After Start, an owner message goes into the job's inbox and is delivered to the coder session at its next turn boundary; the reviewer is given it too. It never needs a new Start and does not change the approved request. Review findings, CI failures, PR feedback, answers to a question and a rebase request reach the coder the same way, each labelled by its source. A stopped job resumes the same session.

**Messages to the owner.** One or two sentences, with up to three buttons when the choices are clear. The report's question becomes a short `ask` (at most 300 characters) with optional `options`; a tap is sent back as a follow-up. Detail stays in the job record.

## Pi as shipped

- **Prompt.** Pi builds its own system prompt, with its tool list and tool rules. Chief appends a short text for the role (coder or reviewer) through Pi's append mechanism. The owner's request is sent once.
- **Tools.** Pi's own `read`, `edit`, `write`, `bash`, `grep`, `find` and `ls`, with Pi's execution (parallel) and Pi's output handling. `bash` has no default time limit.
- **Protocol.** The worker speaks Pi's native Anthropic protocol to the host. The host adds the API key, sets the model, effort and output limit for the role, records the call, and passes the conversation through untouched.
- **Session.** One Pi session for the coder and one for the reviewer per job. Each is saved as it grows and restored when the job continues in a new box, at the same working path. Pi's compaction runs with Pi's defaults at the model's context window.
- **Settings.** Coder: Sonnet 5.5. Reviewer: Opus 5.5. Effort `medium`. (`config/coding-pi.json` changes with stage D1; PR 462 proposed the same.)

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
| The worker owns git for the candidate and a rebase               | The candidate is the reviewed working tree on a known base                                                                              |

Builders add rows here only with a reason of this kind.

## What is deleted

- The planning attempt, planner session and model (`leaderModel`, the `leader` role), the plan check and plan repair, the Requirements section, the plan document and attachment.
- A new session for check repair, review repair, PR feedback and rebase.
- The host's own check stage after each "done" (`kite ci`, `kite run check`, `kite run build`, `kite run format:check`). The coder runs the tests; CI is the independent check. The check-receipt clause in `approvedArtifact` goes for Pi jobs.
- The "main moved" trigger, re-implementation on rebase and the rebase counter.
- The OpenAI-shaped Pi proxy and its caps (20 tool calls per message, 12 tools).
- Limits: the two-minute shell cut, the search failure over 64 KB, the gate that blocks tools until every document page is read (with the `read_document` tool and the review evidence documents), the 7,800-character cut on check output, the caps on check fixes and feedback rounds, the planner's 32 operations and ten minutes, and the 1,500 model-call and 4,000 tool-call caps. The host's reviewer proof keeps working without the call cap.

There is no switch back to the old flow. No job is open in production; a revert is the rollback.

## What stays

- **Nothing runs before Start**, and the host still refuses a build without the owner's approval of the request.
- **Independent review** by a separate session and model that cannot change the candidate, verified by the host before publication.
- **Protected paths** stop for a person ([`merge-policy.ts`](../src/coding/merge-policy.ts)).
- **One backstop.** A job may use eight hours of machine time from each owner Start or resume. A box has a fixed lifetime (an infrastructure fact, to avoid orphaned boxes); when it ends the job saves and continues in a new box by itself. Only reaching the eight hours pauses the job for time and tells the owner.

## Build and rollout

Built as separate pieces, each reviewed and merged by itself:

- **A.** Main moving is not an event ([journal 180](journey/180-main-moving-is-not-an-event.md)). Host only.
- **B.** Pi's native Anthropic protocol (journal 190). Host and worker.
- **C.** Pi's tools and prompt as shipped ([journal 182](journey/182-pi-tools-and-prompt-as-shipped.md)). Worker.
- **D.** The loop, in three stages. D1: go gate, no planner (journal 191). D2: one session per job, the review copy, the inbox, short asks, the host check stage and worker limits removed (journal 192). D3: in-box rebase on conflict, the eight-hour backstop with automatic continuation, remaining caps removed (journal 193). Host and worker.

Worker changes reach jobs through a new worker image pinned by digest in `config/coding-pi.json`. The gateway is released before the pin. Between the host release of B or D and the pin, no coding job should be started. Then one real job is run and read with `scripts/coding-job-profile.sql` (PR 467).
