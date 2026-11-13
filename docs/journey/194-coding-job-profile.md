# 194 — Where one coding job's time and money went, on the one-session loop

Work date(s): 2026-11-13. Written/revised: 2026-11-13.
Status: tooling only, tested against PGlite on branch `coding-revamp/profile-script` from `4ebfaef5`. Not run against production yet; independent review and merge are pending. No runtime change.

## User-visible problem and preceding iteration

The coding-loop specification ([coding-simple-loop.md](../coding-simple-loop.md), "Build and rollout") says the first real job on the rebuilt loop is to be read with `scripts/coding-job-profile.sql`. That script exists only on the unmerged branch `coding-job-profile` (journal 172, never merged), and it was written for the old loop: roles `leader`, `coder` and `reviewer`, OpenAI-shaped call records (`result->'message'->'tool_calls'`), the host's check stage and a fresh session for each repair. The loop has since been rebuilt ([journal 190](190-pi-native-anthropic-protocol.md): Pi's native Anthropic protocol; [191](191-go-gate-no-planner.md): the Start card and no planner; [192](192-one-session-per-job.md): one session per role, the inbox, short asks; stage D3, journal 193, in review: rebase in the box and the eight-hour backstop). Journal 190's follow-up named the script as needing a rewrite. This replaces the journal 172 draft; that draft's script, test and journal are superseded and need not be merged.

## Evidence

**Read in source (main at `4ebfaef5`, and stage D3's branch for its keys):**

- `coding_model_calls` (`src/coding/controller.ts`, `piMessages`): `role` is `coder` or `reviewer`; `input` is `{purpose?, requestedModel, shape, candidate?, request}` (the request body as sent, `candidate` only on reviewer calls); `result` is the Anthropic message (`content` blocks, `usage` with `cache_creation.ephemeral_1h_input_tokens` and `output_tokens_details.thinking_tokens` when Anthropic reports them); `created_at` is when the model slot was claimed. There is no completion time and no column linking a call to its usage record.
- `model_usage` events (`recordPiStream`), key `<attempt>:model:<uuid>`: `{role, purpose?, model, usage, provider, incomplete?}`, where `usage` is `anthropicUsage` (`src/anthropic.ts`): `prompt_tokens` (input plus cache read plus cache write), `cached_tokens`, `cache_write_tokens`, `completion_tokens`, `reasoning_tokens` only when thinking tokens are reported, `cost` (1-hour writes at twice the input price) and `thinking_dropped`. A billed call that did not finish has a usage record but no stored response. The 1-hour/5-minute split is not in the usage record.
- Events: `requirements:<rev>:start` (the Start card, which gets `decision: approved`; the Start itself is the `coding_revisions` row whose `request_key` is the card's event id), `inbox:reply:<key>` (owner or ask answer), `inbox:gh:<id>` (owner, CI or review, from `automation.ts`), `inbox:rebase:<main>:<rev>` (D3), `<attempt>:publish-approved` (`{hash}`), `<attempt>:finished` (`{summary, question, options?}`: no kind), `<attempt>:paused` (`{summary, cause?}`; D3 adds cause `lifetime`), `<attempt>:pr` (`{url, …}`), `checkpoint:<uuid>` (`{kind: checkpoint}` only), `machine-time:<attempt>`, `box-stuck:<attempt>`, `ci-wait:<rev>` (D3). Revisions: `auto-retry:<attempt>`, `continue-box:<attempt>` (D3), `rebase:<main>:<rev>`, `mr-feedback:<hash>`.
- An inbox item reaches a session as a user message whose first line is `[inbox:<event id> <label>; <boundary>]` (`inboxMessage` in `src/coding/pi-worker.ts`); the delivered ids are listed only in the job's current checkpoint (`piState.delivered`).
- Boxes: one per attempt, `request_key = 'coding:<attempt>'`, `subject = 'coding:<job>'`, machine time `running_ms` plus the live span from `running_since` (`src/coding/box-sandbox.ts`, D3's `machineMs`).

**Tested (synthetic, `tests/coding-job-profile.test.ts`):** a job built through the host's own code wherever it exists on main (coding_start and the owner's Start, the tick, every model call through `piMessages` with Anthropic streams, a follow-up through `coding_reply`, checkpoints, `approvePublication`, `finish` and the PR), with two coder runs, a review round asking for changes and one approving, a cache-warming call, a compaction call, three and two tool calls in one turn, an owner inbox item delivered at the coder's next call, a CI item, and a box-lifetime continuation into a second box. The continuation (stage D3, not on main), the box rows and the CI item with its feedback round are written with the statements and payloads those stages use. Every printed figure is asserted.

**Not measured:** a real job. The script has not been run against production.

## Diagnosis and alternatives

The new records are richer in some places (the exact response, the candidate on each reviewer call, the purpose of each call) and poorer in others (no per-call completion time, no link from a call to its usage record, a finish record without its kind). The script reads only what is recorded and says where a figure is inferred.

- **Runs from calls, not stage events.** A coder run or review round is a stretch of consecutive calls of one role in one box. The worker's progress events are owner-facing wording and are not needed.
- **Cost per run by time.** A usage record is written as its call's stream ends, so it is assigned to the latest run of its role in its box that started before it. Within a job only one call runs at a time.
- **Delivery by the session's own request.** The checkpoint events carry no delivered list, so "when delivered" is the first model call whose newest four messages carry the item's header; Pi delivers an item as the newest user message, and a request repeats the whole history, so searching only the tail keeps the scan cheap. Only a time and a role are printed.
- **Old-loop jobs** are refused in one line: a job whose runtime is not Pi, or that has a call without the request's `shape` (written since journal 192) or with another role. Mixing both shapes would need the old script's OpenAI paths and would print wrong numbers for a job recorded before journal 190.
- **Alternative: a TypeScript command.** Production reads go through psql in the Postgres container, as for the other diagnostics scripts, and a SQL file needs no deployed code. Not chosen.

## Implementation and review

[scripts/coding-job-profile.sql](../../scripts/coding-job-profile.sql) prints:

- **1. Summary:** state, stage, models, effort, when the owner tapped Start, wall time to the end (cancelled, or the PR merged, closed or deployed) or to now, the last activity, time waiting before Start and at asks and pauses, machine time from the job's boxes (all, and since the owner's latest Start or resume as the host's backstop counts it), boxes, attempts, coder runs, review rounds, findings and approvals, rebases, PR feedback rounds and the PR number.
- **1b, 1c:** each owner wait, and whether the owner or the host (automatic retry, box continuation, feedback round, rebase) resumed the job; each attempt: box state, start, wall and machine time, calls per role and why it ended (PR opened, publishing, eight-hour pause, box lifetime and whether it continued, crash and its retry, ask, no change, paused, running, cancelled).
- **2. Cost and tokens** by role and purpose (agent, compaction, cache_warm): calls, incomplete calls, uncached input, cache read, cache write, 1-hour writes, output, thinking tokens and their share of output, cost and dropped thinking blocks, with a total row that is the sum of the rows (`GROUPING SETS`).
- **3. The loop:** each coder run and review round in order, with its box, start, duration, agent, warm and compaction calls, unfinished calls, cost, its report (`done`, `ask`, `APPROVE`, `REQUEST_CHANGES`) and for a review round the candidate hash prefix; **3b** milestones (coding_start, Start, owner revisions, pauses with their cause, box continuations, automatic retries, rebases with the new base, publication committed with its hash, finish, PR opened, feedback rounds, eight-hour and stuck-box notices, CI-wait notices, cancellation); **3c** inbox items by source with creation time, whether held during publication, whether the checkpoint lists it as delivered, and when and by which role it was first seen.
- **4. Tool use** from the responses' `tool_use` blocks: turns with no, one, two, or three or more calls; calls by name (Pi's tools and `report`, otherwise `(other)`); `bash` by class (read, search, tests or build, git, edit by script, other) from the first program word against a fixed list; and the coder's agent calls and minutes before its first `edit` or `write`, with the largest request context per role.
- **5. Context** per agent call (input plus cache read plus cache write) per run and per role: first, median, largest and last, and the number of compactions; **5b** each compaction with the context it summarised and the next agent call's context.

Safety: `BEGIN READ ONLY`, `SET LOCAL statement_timeout = '60s'` and `lock_timeout = '2s'`, every statement filtered on the one job id, no dynamic SQL, `ROLLBACK` at the end. Printed values are numbers, durations, allowlisted names and validated hash prefixes.

Run it read-only against production with:

```
ssh HOST 'sudo docker exec -i hermes-companion-postgres-1 sh -c "psql -X -v job=<prefix> -U \$POSTGRES_USER -d \$POSTGRES_DB"' < scripts/coding-job-profile.sql
```

The test runs the script as psql would (conditionals, `\gset`, `\echo` and `\quit` followed), checks that a marker placed in the request, the system prompt, thinking, text and tool arguments of responses, the owner's message, the CI item, the objective and a revision message appears nowhere in the output, and checks that the script holds no writing or dynamic statement and that every statement on a job table names the job. A second test covers the one-line refusal for an old-loop job (OpenAI-shaped call, legacy runtime), a prefix that matches nothing, a quoted prefix and a missing one.

### Figures that are inferred or unavailable

- **Durations** of runs end at the later of the last call's claim and its usage record; a single call's own model time is not recorded.
- **Cost per run** is assigned by time (above), not by call id.
- **1-hour cache writes** come from stored responses, so a billed call that did not finish adds its writes to `cache_write` but not to `write_1h`. The 5-minute writes are `cache_write − write_1h` for completed calls; they are not printed separately.
- **Thinking share** is printed only where Anthropic reported thinking tokens; otherwise `-`.
- **Inbox delivery time** is when the item was first seen in a request, not a recorded delivery.
- **Why an attempt ended** is inferred, because a finish record has no kind: a question means an ask, a publication commit means a candidate, the host's fixed prefix "Nothing needed changing." means no change. Before stage D3 is deployed, a box that reaches its deadline shows as paused or a crash, not as a lifetime.
- **Owner waits** at an ask or pause end at the next revision; time a running job spends before an inbox message reaches the coder is not owner waiting.
- **bash classes** are coarse: `python3` (other than `-m pytest` and similar) counts as an edit by script, `cat`, `echo` or `printf` with a heredoc or a redirect to a file counts as an edit, and only the first word decides.

## Verification and outcome

Run locally on 13 November 2026, offline (no paid model call): `kite ci`, `kite run build:pi`, `kite exec tsx -- --test tests/coding-job-profile.test.ts` (3 of 3), `kite run check` with the Python venv active and `kite run format:check`; results are in the builder's report.

## Deployment status

Not deployed and not run against production. The script needs no release; it can be run as soon as it is merged.

## Follow-up and next iteration

- Run it on the first real job of the rebuilt loop and record the comparison with job `9600af57` ([journal 179](179-first-full-coding-job-review.md)).
- `coding_model_calls` has no index on `job_id` (as journal 172 noted), so every section scans the table, bounded by the statement timeout.
- A call id in the usage record and a completion time on the call would make per-call durations and per-run costs exact; a kind in the finish record would remove the inference in 1c. Each is a host change, not made here.

## Update, 13 November 2026: on main with stage D3

Rebased onto main at `6bf095e5`, where stage D3 ([journal 193](193-rebase-backstop-limits.md)) is merged.

- **The test uses the host's code for what was written by hand before.** The box reaching its lifetime is the worker's stop after the clock passes the save margin and `finish` recording the cause `lifetime`; the continuation is the tick's `continueAfterLifetime` (`continue-box:<attempt>`). The PR's automation is a real `CodingAutomation` built as the controller builds it, started by the controller's own publication: an hour waiting for CI gives the `ci-wait:` notice, two conflicts with main give `rebase:` rounds and `inbox:rebase:` items (one rebased cleanly and reviewed directly, one with conflicts the coder resolved), and a CI failure with a reviewer comment gives one `mr-feedback:` round with `inbox:gh:` items. A second test runs four short jobs through the backstop's paths: the eight-hour hold (`machine-time:<attempt>`), a crash with its automatic retry (`auto-retry:<attempt>`), an ask and `no_change`. The test still writes the box rows (the fixture has no boxes controller), the worker's checkpoints and model requests, and the PR readings.
- **The script reports recorded causes.** An attempt's end is read from what the host records: `lifetime` and whether it was continued (or its box did not shut down), the eight-hour hold, a crash and its retry, an ask, the PR, and `no_change` from the job's result for the current attempt. Only an earlier attempt's `no_change` is still read from the worker's summary, because the finish record has no kind. The summary adds machine time left of the eight hours, eight-hour pauses and conflicting rebases; a new section 3d lists each rebase as clean (the coder never received the item, and the next review round read it) or conflicting (the coder received it), with the review round that followed. Inbox items are listed in the host's own order (`seq`).
- **Checked against D3's records:** D3 adds no call id to usage records, no completion time to calls, no 1-hour split to usage records and no kind to finish records, so run durations, per-run cost, `write_1h`, thinking share, inbox first-seen times and an earlier attempt's `no_change` stay approximate. The script now prints that list in one block before the figures. Owner waits, machine time and the recorded end causes are exact.

Verification: `tests/coding-job-profile.test.ts` 4 of 4; the full commands are in the builder's report.
