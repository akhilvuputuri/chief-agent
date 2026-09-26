# Durable execution and recovery

The custom TypeScript runtime replaces the former three-pass bridge. Defaults are `AGENT_BUDGET_MS=900000`, `AGENT_BUDGET_MODEL_CALLS=40`, and `AGENT_BUDGET_TOOL_CALLS=100`. A task retains limits and consumption in Postgres; `/continue` adds another allocation, not a fresh task. Model retries and retried reads count. Provider cost is recorded when returned, but these are execution-count/time limits, not a dollar-based budget.

`runtime_runs` stores versioned message checkpoints, counters and stop reasons. `runtime_calls` stores tool identity, arguments and state before dispatch, then the actual outcome. `events` stores model/provider/latency/usage when available. Do not export private checkpoint contents or arguments to public telemetry.

Only transient model errors and recognized transient read failures retry, at most twice. Writes have a single dispatch. A write whose result could not be recorded is uncertain, and later writes are blocked until an operator inspects it. Restart recovery never replays an invocation. It pauses active tasks and marks started writes uncertain. Interrupted active time is charged conservatively, capped by the task allocation; downtime may therefore consume the remaining time allocation after a crash.

Cancellation bypasses Telegram's conversation queue, aborts the model request and checks again before subsequent tools. A tool already dispatched can complete and is recorded; cancellation cannot undo a completed external action. The Telegram runner accepts updates concurrently while per-user queues serialize ordinary turns.

Approvals remain exact saved actions with ownership, expiry and single-consumption checks. Required input/approval pauses dependent work; the model is instructed to complete independent runnable steps first. Approved actions can release an approval pause if budget remains. No tool can approve its own action.

## Cutover

Migration 006 is additive and applies its cutover once. It archives original Hermes conversation JSON unchanged, seeds text-only user/assistant history, and pauses active work with `runtime_cutover`. It preserves steps, evidence, receipts, memories, approvals, skills and schedule next-run timestamps. It does not resume the existing 22-role task.

## Inspecting uncertain writes

Inspect the owner's `runtime_calls` joined to `runtime_runs`, the matching `tool_receipts`, and the destination state. Determine whether the action occurred. Record the verified result and resolve that invocation explicitly; never clear an uncertainty flag merely to retry. Then the owner may grant more budget with `/continue`. Keep this operator-only until a review UI exists.

The current guard is owner-wide: one unresolved runtime write blocks unrelated runtime writes. Approval outcomes and runtime-call outcomes are separate records; fixing an approval does not reconcile an older uncertain `calendar_draft` call. Read tools must remain usable for inspection, including `watchlist_list`.

For an old `calendar_draft` invocation, the destination is the local `calendar_create` approval, not Google Calendar: drafting never creates an external event. An operator may record a definite failed draft only after checking the exact call's owner/run, confirming that its run is stopped, and finding neither a matching approval, a successful draft receipt, nor a `calendar.created` event in that run. Lock and conditionally update only that invocation, retain its original error/result, append dated reconciliation evidence and a `runtime.call_reconciled` event, and verify the affected row count. If any of those checks is inconclusive, preserve `uncertain`. Never apply this rule to `calendar_create` or another external write; never automatically reset uncertain calls during release.

## Evidence limitations

Completion guards require matched recorded evidence or successful receipts for the declared operation. Applicability labels and semantic coverage are still model judgments. A completed ledger is not independent factual certification. `/status` reports these records; ordinary Telegram answers remain model-written.
