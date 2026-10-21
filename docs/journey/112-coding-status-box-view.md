# 112 — What does coding_status say about the box an attempt runs in?

Work date: 2026-10-21. Written: 2026-10-21.
Status: tested. The implementation and its tests are done and pass locally; independent review, CI and the release receipt are pending.

## User-visible problem and preceding iteration

Since phase 4a of [boxed sub-agents](91-boxed-subagents.md), every coding attempt runs as one task inside its own EC2 box. The owner can still ask `coding_status` about a job, and gets its state, plan, questions, PR, cleanup and the worker's counters — but nothing about the box that is doing the work. A job that sits in `provisioning` looks the same whether its box is still booting, is busy on a long step, or is being torn down after the attempt ended. The only way to tell was to run it down through the box layer by hand.

The owner asked for a short box view in `coding_status`: the box's state, when it launched, when it last reported, and why it ended.

The earlier cancelled job for this goal had no PR. Its planning note warned that `boxes.state` stores more values than the seven the owner asked for, and that an owner-facing view must map every one of them.

## Evidence

All read from the current source on 21 October 2026, then exercised through the tests below.

- **The stored vocabulary is wider than the asked-for one.** `db/032_boxes.sql` allows eleven `boxes.state` values: `requested`, `launching`, `booting`, `ready`, `busy`, `stopping`, `stopped`, `starting`, `terminating`, `terminated`, `held`. The owner asked for seven: requested, booting, ready, busy, terminating, terminated, held. No mapping existed anywhere in the code; the seven words appear only in the request.
- **The timestamps exist and mean what the request needs.** `launch_started_at` is set when the launch begins (`BoxController.admit` with `state: "launching"`). `seen_at` is written on every hello, poll and event batch, and a box that stops reporting is the one `BoxController` treats as lost. `box_events.created_at` is the fallback for a box that has rows before its first contact.
- **The end reason is the box's `reason`, and it is only meaningful once verified gone.** `BoxController.close` moves a box to `terminating` and then to `terminated` after the provider confirms; the coding sandbox closes a box with `Coding attempt ended`, and idle endings state `Idle time-to-live reached` or `Stopped retention reached`.
- **`coding_status` never read the box at all.** The detail branch selected `checkpoint,attempt_id` from `coding_jobs`; `sandbox_id` was not in the query, so no box lookup was possible from the tool. The id is cleared on requeue, resume and retry, so a stored `sandbox_id` always names the current or latest attempt.

## Diagnosis and alternatives

The gap was a missing read, not a missing record. `boxes` and `box_events` already hold the state, launch time, last report and reason; the tool simply never asked.

- **Report the stored state verbatim.** Simplest, and rejected: five of the eleven values (`launching`, `starting`, `stopping`, `stopped`, and `held` versus `terminated`) describe the box layer's mechanics, and the owner asked for a short lifecycle vocabulary. Handing the owner the raw state also makes any future CHECK value a new word in the tool output.
- **Derive the view from `box_events` alone.** The event stream carries the same transitions, but it would mean re-deriving state and liveness from a log the controller already summarises, and it costs more queries for less certainty. The `boxes` row is the authority; `box_events` is used only as a fallback report time.
- **Reuse `BoxController.view`.** It is private and returns only `{id, profile, subject, state, reason}`; it has no launch or report time, and it is a box-layer object rather than an owner view.
- **Map, completely, in one place.** `launching → requested` (launch in progress; after an uncertain launch an instance may already exist), `starting → booting` (a stopped box started again, same wait for a hello), `stopping` and `stopped → terminating` (still there, no longer serving the attempt), `terminated → terminated`, `held → held`. An unrecognised stored state is reported as `held`, because that claims neither that the box runs nor that it is gone.
- **`stopped → terminating` is a judgement, recorded for review.** A stopped box is retained warm and is started again when work is delegated, so `ready` is arguable. It serves nothing while stopped, and saying `ready` would suggest the owner could expect immediate progress. If review prefers `ready`, it is one line in the map, one row of the documented table and the matching test expectation. Coding boxes have no stopped retention (`retentionHours` 0 in `config/boxes.json`), so they never reach `stopped` today; the mapping matters only for other profiles.

## Implementation and review

- [`boxView()` in `src/coding/box-sandbox.ts`](../../src/coding/box-sandbox.ts) is the read: one owner-scoped `SELECT` of `state`, `reason`, `launch_started_at`, `seen_at` and `max(box_events.created_at)` from `boxes`, matched as `b.id::text` so a malformed id cannot fail the call. It returns `undefined` for any id that is not a `box:` id and for a `box:` id with no row. It writes nothing, takes no lock and makes no provider call. `BOX_VIEW_STATES` is exported beside the `box:` prefix the file already owns, so a test can assert the view never leaves the seven.
- [`status()` in `src/coding/controller.ts`](../../src/coding/controller.ts) adds `sandbox_id` to its existing detail query (not to the returned object, not to the list query) and spreads `box` into the detail only when the view exists. A job on an older `chief-coding:` sandbox therefore returns exactly the keys it returned before, and the list call is untouched.
- The `coding_status` description in [`src/runtime.ts`](../../src/runtime.ts) tells the model the field exists, what it says and that older sandboxes have none.
- Documentation: [phase 4c of the boxes guide](../boxes.md#phase-4c-owner-view-and-steering) carries the full mapping table and the rule that the view is a lifecycle phase, never a claim that a box still exists.

No migration and no new column; `src/coding/schema.ts` is unchanged, since only the output shape grew.

## Verification and outcome

- **Tested:** `tests/coding-box-sandbox.test.ts` runs a real `CodingController.status` over the existing PGlite fixture, with a stub provider whose every method throws, so a status call that touched the sandbox would fail. Fifteen tests pass in the file, six of them new:
  - a live box reads `ready` with a launch time and a report time not earlier than it and no end reason, says `busy` after a `box.state` event, and `terminating` while the box is being closed;
  - verified termination states its reason, and a terminated box with an empty reason states none;
  - an older `chief-coding:` job has no `box` key at all, and neither does the list call, a malformed `box:` id, or a `box:` id with no row;
  - all eleven stored states map into the seven, checked against the live CHECK constraint read from `pg_constraint`, so a state added to a future migration without a mapping fails the test; an unknown value drops the constraint and reads `held`;
  - the view is owner-scoped, and a held box reads `held` without an end reason even though its row carries a hold reason.
- **Not yet verified:** a production `coding_status` call against a real boxed job, and whether `coding_status` output stays within the model's useful context when a job has both a box view and a long runtime block.
- **Limitation, stated not verified:** whether the production `coding` profile sets `retentionHours > 0` with a provider that can stop, which decides whether `stopped` (and so the `terminating` mapping) is reachable today. The mapping is complete either way.

## Follow-up and next iteration

The steering half of phase 4c — relaying an owner answer into a running task — is not built. After release, the owner can ask about any boxed job and see its phase; the next useful check is one real paused or terminated job read back through `coding_status` in production.

## Coding-harness learning record (when applicable)

Recorded in [coding-agent lessons](coding-agent-lessons.md#coding-attempts-move-into-ec2-boxes--20-october-2026): a stored state vocabulary must be mapped totally before it is shown, an owner view must never assert that a resource still exists once it is gone, and a missing row must degrade to no view rather than fail the call.

**Review (Claude Opus 5.5, 21 October): changes requested, then fixed by the operator on the PR branch.**

- **Blocking.** Journal 111 had meanwhile been taken on main (US AQI), so this entry is now 112, with its index row, DevOps chain and links.
- **Non-blocking, adopted:**
  - The box lookup checks the id is a UUID and compares it as one, so it uses the primary key instead of scanning `boxes`.
  - The tool text says the box view needs an exact id.
  - The `launching` wording now reads "launch in progress".
  - A misleading test comment is corrected and an unused call removed.
