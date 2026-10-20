# 108 — Does keeping in-turn reasoning keep the whole Opus turn cached?

Work date(s): 2026-10-20. Written/revised: 2026-10-20.
Status: in review. For Anthropic models, earlier steps of the current turn keep their reasoning in the request instead of losing it. Not yet measured in production.

## User-visible problem and preceding iteration

[Journal 104](104-opus-cache-misses-in-production.md) added a stable cache entry at the owner's message. Chief removes reasoning from a step once it is no longer the latest, so later calls in a turn could read only up to that entry, not the turn's growing tool results. This was step 3 of the caching plan the owner approved.

## Evidence

- **Measured, synthetic tool loop, 20 October 2026,** about $0.30. Opus 5.5, high effort, the adapter's provider block and `cacheHints` from the built code, a 4-step lookup loop, the time line rebuilt on every call.

  | Earlier steps' reasoning    | Cached tokens, calls 1→4                          | Cache writes, calls 2→4 |
  | --------------------------- | ------------------------------------------------- | ----------------------- |
  | Removed (current behaviour) | 0 → 12,807 → 12,807 → 12,807                      | 165 → 279 → 384         |
  | Kept                        | 0 → 12,805 → 12,942 → 13,094 (→ 13,204 on call 5) | 175 → 190 → 148         |

  All calls returned 200 on the upstream account OpenRouter routed to (Claude Platform on AWS). As journal 100 notes, a 200 shows that account did not block it, not that every account would accept it.

  Not exercised:
  - an absorbed owner follow-up mid-turn;
  - a mix of steps with and without reasoning;
  - Bedrock or Vertex routing.

- **Code-confirmed.** `src/context.ts` removed reasoning from every earlier in-turn group, via `withoutReasoning`, before each call.

## Diagnosis and alternatives

With reasoning removed, each call's prefix diverges from the previous call at the previous step. Reads stop at the owner's entry, and every later tool result is written again at 1.25× the input price. Keeping the reasoning makes each call an exact extension of the last.

The saving grows with the turn's tool results. In production these run to 2–15k tokens. That puts it at roughly $0.01–0.06 per later call (estimate, $4/M × (1.25 − 0.1) on 2–15k tokens), before netting out the extra reasoning tokens.

The cost is the reasoning text itself (estimated at a few hundred tokens per step; the synthetic loop grew by about 110–150 cached tokens per call, including the call and its result). It is written once at 1.25× and then read at 0.1×. If kept reasoning would cross the 120k compaction threshold, it is dropped first, so real results are never cut to excerpts because of it.

Alternatives:

- Keep reasoning for every model. Other providers cache automatically and were not measured, so this stays Anthropic-only.
- Mark a breakpoint after each step. That would exceed Anthropic's 4-breakpoint limit.

## Implementation and review

- `src/context.ts`: when `request.keepTurnReasoning` is set, earlier in-turn groups keep `reasoning_details`. Wire compaction still rewrites groups when it must. Earlier conversation history still never carries reasoning.
- `src/context.ts`: when the turn would cross the compaction threshold, or its serialized size would, it is rebuilt without kept reasoning before any group is compacted. That costs one cache shift, and the old behaviour applies from then on.
- `src/custom-agent.ts`: sets `keepTurnReasoning` for `anthropic/` models, using the resolved model of each run (a Flash child under Opus gets false). `context.selected` records `reasoningSize`, the characters of kept reasoning.
- Tests:
  - `tests/context-continuity.test.ts` checks the projection;
  - `tests/tool-domains.test.ts` checks that Opus gets both earlier steps' reasoning back and GPT gets only the latest.

Independent review (Opus 5.5, commit `4248e96`) requested changes:

- **Medium.** Kept reasoning counted toward the 120k compaction threshold, so long turns could have cut real tool results to excerpts earlier. Fixed: reasoning is dropped first. A test fails without the fix.
- **Low.**
  - The API-acceptance claim was overstated.
  - Estimates were unlabelled.
  - A test comment was misleading.
  - There was no production measure of reasoning size.

All fixed.

The review also confirmed:

- no group mixes stripped and kept reasoning in one call;
- journals and checkpoints are unchanged;
- the model check uses each run's resolved model.

## Verification and outcome

Pending (the comparison is confounded when effort escalates mid-turn, which changes thinking settings; [journal 107](107-stable-tools-and-effort.md) limits that to failures and follow-ups):

- review, CI and the release;
- in production, cached tokens growing call by call within a turn, and writes per call staying small, compared with 20 October.

## Follow-up and next iteration

- Reuse across messages (step 4 of the caching plan) after a week of data.
- If `reasoningSize` shows reasoning often triggering the drop, revisit the compaction threshold.
