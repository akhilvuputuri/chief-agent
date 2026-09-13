# 18 — Accepting corrections without discarding active reasoning

Work date: 2026-09-13. Written: 2026-09-13.
Status: candidate v0.3.9, implementation and focused mocked checks complete; integration/review/release pending. Baseline v0.3.8: `d0e33365c7cec7b7cb1eb64c22de7c09d5d9a314`.

## User-visible problem

The rolling-conversation release made intake durable and separated foreground chat from background jobs, but ordinary follow-ups still aborted in-flight reasoning and started a replacement foreground run. A correction could discard usable reasoning, receive another allocation and compete with file preparation or delivery of an answer based on the previous input. Image handling needed special treatment because only the live process retained the bytes.

## Evidence

The v0.3.8 source establishes the interrupt-and-replace behavior. This change follows the approved checkpoint-steering design. New tests use controlled model/tool completions and synthetic source records to expose the timing boundaries; they contain no private production conversations. These are deterministic host-behavior checks. They are not a measured production latency, cost or conversational-quality comparison.

## Diagnosis and alternatives

The input inbox, execution checkpoint and outbound delivery need separate lifetimes. Stopping every model request as soon as another message arrives discards its eventual response. Letting an old batch dispatch after a correction can act on stale instructions. The chosen boundary lets the active model or dispatched tool finish and be recorded, then closes unstarted calls before incorporating ordered input. There is no debounce heuristic or concurrent foreground mutation loop.

An unbound run can safely keep its allocation and source observations while adopting new input. A run already bound to a durable task instead pauses that task and hands new input back to the foreground inbox. Neither path authorizes replaying a skipped write or automatically resuming paused work.

## Implementation

[The loop](../../src/custom-agent.ts) preserves full model responses and completed tool results, adds `NOT_DISPATCHED` observations for skipped calls and consumes new inputs at checkpoints. Input-to-message references stay owner/run scoped. Undelivered final replies remain in the run journal but leave the model/chat projection.

[The inbox](../../src/input-inbox.ts) separates immediate durable intake from readiness and ephemeral attachment availability. [Telegram](../../src/telegram.ts) permits two preparations per user, while execution and delivery have their own boundaries. Delivery revisions suppress stale text/speech before dispatch; pending conversation replies become visible to history only after delivery is recorded. Reset commits after the previous foreground commit rather than racing it.

[The read-only specialist runner](../../src/research.ts) yields cooperatively and returns exact partial source references. [Media delegation](../../src/media.ts) preserves these references and keeps current attachments usable by the parent after an interruption. Migration014 adds preparation, consumption/message-reference and delivery-state fields without replacing existing data. The [rollout guide](../checkpoint-steering.md) specifies baseline checks and additive rollback.

## Verification and outcome

During implementation, all 13 new [loop/child regression tests](../../tests/steering-loop.test.ts) and 38 existing runtime/research/media/delegation-accounting tests passed. TypeScript checking also passed after the added timing test, which verifies that attachment-preparation waits do not consume active execution time. These checks cover ordinary-input completion, ordered same-run adoption, write preservation, journal/authorization races, final suppression, cancellation, task handoff and partial source retention. The broader integrated change must still pass its full checks and exact-head independent review. Eight offline mocked operator-rollout scenarios passed, and all five new diagnostics queries ran against migrated synthetic PGlite data without returning private text or owner identifiers. No paid smoke test or paid evaluation was run.

The deployment script is prepared for the exact v0.3.8 baseline. It has not been installed or executed for this candidate, and no v0.3.9 release is claimed. A dispatched Telegram send cannot be recalled. A send that succeeds before its receipt is recorded can remain conservatively pending; the runtime does not automatically resend. Ephemeral attachment bytes cannot survive a process restart.

## Follow-up

Complete full integration checks, independent Astra review, CI and the reviewed operator migration014 rollout. Verify the exact deployed SHA, health and preserved data before publishing a patch release. Then record a bounded real Telegram acceptance check separately. Retain the deferred observable-memory and evaluation branches; this work does not complete or release them.
