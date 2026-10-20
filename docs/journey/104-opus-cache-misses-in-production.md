# 104 — Why did Opus miss its cache on some production calls?

Work date(s): 2026-10-20. Written/revised: 2026-10-20.
Status: in review. Anthropic requests gain two more cache markers, on the opening system message and on the owner's current message. Each turn's context also records the size of every runtime-state key. Production effect not yet measured.

## User-visible problem and preceding iteration

[Journal 100](100-opus-main-model-and-caching.md) switched the main model to Opus 5.5 and added cache markers that synthetic tool loops showed working. This entry reads the first production turns on Opus.

## Evidence

- **Measured, production, 20 October 2026, 05:06–10:30 UTC.** The private events table was read with a read-only query; aggregates only. There were 16 Opus calls in 5 foreground turns, costing $2.16 in total.

  | Turn | Calls | Calls that read the cache | Note                               |
  | ---- | ----- | ------------------------- | ---------------------------------- |
  | 1    | 3     | 2 (19.2k tokens each)     |                                    |
  | 2    | 6     | 1 (26.6k)                 | jobs tools loaded after call 1     |
  | 3    | 3     | 0                         | effort low on call 1, medium after |
  | 4    | 2     | 1 (21.4k)                 |                                    |
  | 5    | 2     | 1 (18.9k)                 |                                    |
  - Calls that read the cache cost $0.05–0.09.
  - Calls that missed wrote the whole prompt again, 25–42k tokens, at the 1.25× write price, and cost $0.13–0.23.
  - All 5 turns reported `context.over_budget` with reason `fixed`, at 50–60k characters.
  - Runtime state was 13–17k characters of that.

- **Measured, synthetic probes, 20 October 2026,** about $0.80 in total.
  - Many parallel tool results between the owner's message and the latest message did not cause misses when the history only grew.
  - A change of reasoning effort between calls did not invalidate the cache.
  - Removing the previous assistant message's reasoning, as Chief does once that message is no longer the latest, cut reads back to the last entry before it.
- **Code-confirmed.**
  - `src/context.ts` sends older in-turn assistant messages without their reasoning.
  - A mid-turn `tools_load` changes the tool list, which leads the cached prefix.

## Diagnosis and alternatives

This is a hypothesis consistent with every row above.

- The only cache entries were the ones each call wrote after its latest message.
- After a tool load, no entry existed yet for the new tool list that later calls could fall back on.
- Each later call then removed the previous message's reasoning, which broke the match with the entry the previous call had just written. So it missed completely.
- The one call that read the cache followed a step with almost no reasoning.

Alternatives:

- **Keep reasoning on older in-turn messages.** The whole turn would then stay cacheable, but this changes context size and behaviour for every model. Deferred until production shows how much it would save.
- **Stop mid-turn tool loads.** Not possible; the model needs them.

The chosen change gives every call an entry that does not change during the turn: the owner's message. It also gives one that does not change across turns: the opening system message. That makes four Anthropic breakpoints, the maximum.

## Implementation and review

- `src/model.ts` `cacheHints`: for `anthropic/` models it now also marks:
  - the owner's latest user message;
  - the opening system message.
- `src/custom-agent.ts`: `context.selected` records `runtimeParts`, the character size of each runtime-state key, in the private events table. Values are never recorded. This shows which part of the 13–17k state to trim next.
- `tests/model-cache-hints.test.ts` covers the markers in a tool loop and the size-only record.

Independent review: pending.

## Verification and outcome

Pending:

- review, CI and the release;
- the weekly review's comparison of cached tokens and cost per call against the turns above.

Expected: later calls in a turn read at least the owner-level prefix, about 19–27k tokens, even after a tool load. This is a hypothesis until measured.

## Follow-up and next iteration

- Trim the runtime state using `runtimeParts`.
- Measure keeping in-turn reasoning for Anthropic models.
- The fixed envelope is still over the 48k soft budget whenever coding, work and jobs tools are all loaded.
