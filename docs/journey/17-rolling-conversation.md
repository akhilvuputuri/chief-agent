# Rolling chat continuity and independent task execution

## Failure observed

A calendar request began with a correctly extracted invitation lacking an exact time. After the user supplied a time, the next model call lost the prior exchange because fixed instructions, tool schemas and state exceeded the soft context allowance. History retrieval then returned an unrelated invitation. A later brief challenge inherited a stale research checkpoint, and a long serialized job delayed the user's correction.

The failure was not corruption of the stored image extraction. Tests had covered context size bounds but had allowed the entire preceding conversation to disappear. A history search across raw tool outputs could also rediscover its own earlier search result. Those interactions explain why adding memory retrieval alone would not resolve the incident.

## Design and implementation

We inspected the run/input/source relationships and reproduced context selection with realistic fixed overhead. We compared documented/source-visible Hermes and OpenClaw patterns: rolling sessions, protected recent context, bounded historical compaction, independent jobs and safe handling of new input. We adopted those principles without introducing a semantic router for every topic or copying either framework.

Implementation was divided into independently owned context, history and task-selection changes, with foreground/Telegram integration and migration assembled alongside them. Original stored history remains immutable. Context now protects the recent exchange and source references; archive compaction is deterministic excerpt selection. Search returns original conversational sources and neighborhoods. Foreground task binding is explicit; background jobs use their own context and controllers. New input can interrupt model reasoning without replaying an active write.

## Validation and limits

Regression tests reproduce the structural failure using synthetic events and mocked models. They verify that a paused research task cannot become an unrelated calendar request, that new messages are received during long work, and that writes, approvals and restart state retain their existing protections. Actual model interpretation may still be wrong; the new traces make those mistakes distinguishable from missing or misrouted context.

The first independent Astra review requested changes for three gaps: input arriving during journal awaits could still dispatch an old write; storage selection could remove the recent exchange before context selection saw it; mixed-case task commands could enter the cancellation branch. We added regression cases and fixed the actual dispatch boundary, storage projection/protection and command normalization. Interrupted foreground jobs now pause instead of silently continuing skipped work. Final independent approval, passing CI and an operator migration/health check remain required before release. See [the implementation and rollout guide](../rolling-conversation.md) for current behavior and recovery. The work does not add a semantic summarizer, automatic inbox replay, embeddings or a hidden thread per subject.

## References

- [Hermes Agent source](https://github.com/NousResearch/hermes-agent), inspected reference commit `9939e3375e294250eb373e34e002fcb95bfdf775`: gateway session control, context compression and session history retrieval.
- [OpenClaw main session](https://docs.openclaw.ai/concepts/main-session), [queue behavior](https://docs.openclaw.ai/concepts/queue), [compaction](https://docs.openclaw.ai/concepts/compaction), and [tasks](https://docs.openclaw.ai/automation/tasks).

These are implementation references, not claims about proprietary ChatGPT or Claude internals or guarantees that another assistant cannot exhibit similar failures.
