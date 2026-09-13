# Rolling chat continuity and independent task execution

Work date: 2026-09-13. Revised: 2026-09-14.
Status: released v0.3.8; follow-up input handling subsequently refined by v0.3.9 checkpoint steering.

## Failure observed

A calendar request began with a correctly extracted invitation lacking an exact time. After the user supplied a time, the next model call lost the prior exchange because fixed instructions, tool schemas and state exceeded the soft context allowance. History retrieval then returned an unrelated invitation. A later brief challenge inherited a stale research checkpoint, and a long serialized job delayed the user's correction.

The failure was not corruption of the stored image extraction. Tests had covered context size bounds but had allowed the entire preceding conversation to disappear. A history search across raw tool outputs could also rediscover its own earlier search result. Those interactions explain why adding memory retrieval alone would not resolve the incident.

## Design and implementation

We inspected the run/input/source relationships and reproduced context selection with realistic fixed overhead. We compared documented/source-visible Hermes and OpenClaw patterns: rolling sessions, protected recent context, bounded historical compaction, independent jobs and safe handling of new input. We adopted those principles without introducing a semantic router for every topic or copying either framework.

Implementation was divided into independently owned context, history and task-selection changes, with foreground/Telegram integration and migration assembled alongside them. Original stored history remains immutable. Context now protects the recent exchange and source references; archive compaction is deterministic excerpt selection. Search returns original conversational sources and neighborhoods. Foreground task binding is explicit; background jobs use their own context and controllers. New input can interrupt model reasoning without replaying an active write.

## Validation and limits

Regression tests reproduce the structural failure using synthetic events and mocked models. They verify that a paused research task cannot become an unrelated calendar request, that new messages are received during long work, and that writes, approvals and restart state retain their existing protections. Actual model interpretation may still be wrong; the new traces make those mistakes distinguishable from missing or misrouted context.

The first independent Astra review of `40d4119951dddc70399aab7ba39d05efc9acc380` requested changes for three gaps: input arriving during journal awaits could still dispatch an old write; storage selection could remove the recent exchange before context selection saw it; mixed-case task commands could enter the cancellation branch. We added regression cases and fixed the actual dispatch boundary, storage projection/protection and command normalization. Interrupted foreground jobs now pause instead of silently continuing skipped work. Final independent approval, passing CI and an operator migration/health check were still required after those corrections; the closure below records completion. See [the implementation and rollout guide](../rolling-conversation.md) for current behavior and recovery. The work does not add a semantic summarizer, automatic inbox replay, embeddings or a hidden thread per subject.

## References

- [Hermes Agent source](https://github.com/NousResearch/hermes-agent), inspected reference commit `9939e3375e294250eb373e34e002fcb95bfdf775`: gateway session control, context compression and session history retrieval.
- [OpenClaw main session](https://docs.openclaw.ai/concepts/main-session), [queue behavior](https://docs.openclaw.ai/concepts/queue), [compaction](https://docs.openclaw.ai/concepts/compaction), and [tasks](https://docs.openclaw.ai/automation/tasks).

These are implementation references, not claims about proprietary ChatGPT or Claude internals or guarantees that another assistant cannot exhibit similar failures.

## Release closure — 14 September 2026

[v0.3.8](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.8) shipped [PR #40](https://github.com/akhilvuputuri/companion-agent/pull/40) at `d0e33365c7cec7b7cb1eb64c22de7c09d5d9a314`. The [release workflow](https://github.com/akhilvuputuri/companion-agent/actions/runs/34760645104) completed successfully for that exact SHA; published release evidence records deployment and health verification. The [PR approval record](https://github.com/akhilvuputuri/companion-agent/pull/40#issuecomment-5653627549) identifies corrected head `474860d5a6fe2ad40e8c4cad59c1fda481e5bd73`. The release records 43 independently rerun focused tests, 183 application tests plus two scope checks, typecheck/build/format and a real PostgreSQL read-only context smoke. The reviewed operator procedure applied migration013, preserving records and the paused job; [production diagnostics](https://github.com/akhilvuputuri/companion-agent/actions/runs/34760718078) also passed. These checks verify the structural context/routing protections, not model interpretation quality. The interrupt-and-replace policy for ordinary follow-ups then motivated [checkpoint steering](18-checkpoint-steering.md), which retained in-flight results before adopting newer input.
