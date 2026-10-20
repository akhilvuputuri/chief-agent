# 104 — Why did Opus miss its cache on some production calls?

Work date(s): 2026-10-20. Written/revised: 2026-10-20.
Status: in review. Anthropic requests gain two more cache markers, on the opening system message and on the owner's current message. Each turn's context also records the size of every runtime-state key. Production effect not yet measured.

## User-visible problem and preceding iteration

[Journal 100](100-opus-main-model-and-caching.md) switched the main model to Opus 5.5 and added cache markers that synthetic tool loops showed working. This entry reads the first production turns on Opus.

## Evidence

- **Measured, production, 20 October 2026, 05:06–10:30 UTC.** The private events table was read with a read-only query; aggregates only. There were 16 Opus calls in 5 foreground turns, costing $2.16 in total, all served by Claude Platform on AWS.

  | Turn | Calls | Calls that read the cache | Note                                                                          |
  | ---- | ----- | ------------------------- | ----------------------------------------------------------------------------- |
  | 1    | 3     | 2 (19.2k tokens each)     |                                                                               |
  | 2    | 6     | 1 (26.6k)                 | jobs tools loaded after call 1                                                |
  | 3    | 3     | 0                         | effort low on call 1, medium after; older-history count changed before call 3 |
  | 4    | 2     | 1 (21.4k)                 |                                                                               |
  | 5    | 2     | 1 (18.9k)                 |                                                                               |
  - Calls that read the cache cost $0.05–0.09.
  - Calls that missed wrote the whole prompt again, 25–42k tokens, at the 1.25× write price, and cost $0.13–0.23.
  - 5 of the 11 misses were the first call of a turn, which no in-turn change can help.
  - All 5 turns reported `context.over_budget` with reason `fixed`, at 50–60k characters; runtime state was 13–17k characters of that.

- **Measured, synthetic probes, 20 October 2026,** about $0.80 in total.
  - Many parallel tool results between the owner's message and the latest message did not cause misses when the history only grew.
  - Removing the previous assistant message's reasoning, as Chief does once that message is no longer the latest, cut reads back to the last entry before it.
  - In one probe without a system-message marker, changing effort from low to medium did not stop the owner-level entry from being read. Anthropic documents that effort or thinking changes invalidate cached messages, so this result is narrow and may not hold for production prompts.
- **Code-confirmed.**
  - `src/context.ts` sends older in-turn assistant messages without their reasoning.
  - A mid-turn `tools_load` changes the tool list, which leads the cached prefix.
  - The older-history allowance depended on the fixed envelope and this turn's protected size, both of which grow during a turn. So older history, which precedes the owner's message, could shrink between calls, as it did in turn 3.

## Diagnosis and alternatives

The following are hypotheses, consistent with most rows above.

- **Turn 2.** After a tool load, no cache entry existed for the new tool list except the one each call wrote after its latest message. The next call removed that message's reasoning, so the entry no longer matched.
- **Turn 3.** Two causes are candidates: the effort change from low to medium, and older history shifting before call 3. The probe does not settle which.
- **First-call misses.** These remain unless tools, instructions and memories are identical to a turn within the 5-minute cache lifetime.

Alternatives:

- **Keep reasoning on older in-turn messages.** The whole turn would then stay cacheable, but this changes context size and behaviour for every model. Deferred until production shows how much it would save.
- **Stop mid-turn tool loads.** Not possible; the model needs them.
- **Pin the reasoning effort for a turn.** That would trade away the escalation from [journal 90](90-jev-reasoning-effort.md). Deferred until production shows effort changes cause misses.

The chosen change has three parts:

- every call gets a cache entry that does not change during the turn, at the owner's message;
- older history is set by the turn's first call and kept until it no longer fits the compaction headroom. Then it is dropped once and stays out for the rest of the turn. That makes at most one shift of the prefix before the owner's entry, instead of a shrink on every call;
- the opening system message gets an entry that can be reused across turns.

The markers make four Anthropic breakpoints, the maximum.

## Implementation and review

- `src/model.ts` `cacheHints`: for `anthropic/` models it now also marks:
  - the owner's latest user message;
  - the opening system message.
- `src/context.ts` and `src/custom-agent.ts`: the turn's first call sets the older-history allowance (`historyAllowance`), and later calls reuse it. When the headroom no longer covers it, the allowance latches at 0 for the rest of the turn.
- `src/custom-agent.ts`: `context.selected` records `runtimeParts`, the character size of each runtime-state key, in the private events table. Values are never recorded. This shows which part of the 13–17k state to trim next.
- `tests/model-cache-hints.test.ts` covers the markers in a tool loop and the size-only record.

Independent review (Opus 5.5, commit `26312b3`) requested changes:

- **Medium.** Older history could still shift within a turn, as turn 3's omitted count showed. A first fix froze the allowance. Delta review (`94a498b`) found it was a no-op whenever the fixed envelope was over 48k, which held in every measured turn: history still shrank and returned as headroom changed. The allowance now latches at 0 once it no longer fits. A test with an 82k fixed envelope shows older history kept, then dropped once, where recomputing per call shrank it and brought it back.
- **Medium.** The effort claim conflicted with Anthropic's documentation and with turn 3. Reworded as above.
- **Medium.** Docs stated the hypothesis as fact. Corrected.
- **Low.**
  - A code comment named the wrong mechanism.
  - Provider routing was unchecked; all 16 calls used one provider.

A fuzz of 200,000 random message lists never exceeded 4 breakpoints, and Pi coding requests cannot add markers of their own.

## Verification and outcome

Pending:

- review, CI and the release;
- the weekly review's comparison of cached tokens and cost per call against the turns above.

Expected, as a hypothesis until measured:

- later calls in a turn read at least the owner-level prefix, about 19–27k tokens, even after a tool load;
- first-call misses continue except for back-to-back turns with the same tools;
- turns whose effort changes may still miss.

## Follow-up and next iteration

- Trim the runtime state using `runtimeParts`.
- Measure keeping in-turn reasoning for Anthropic models.
- The fixed envelope is still over the 48k soft budget whenever coding, work and jobs tools are all loaded.
