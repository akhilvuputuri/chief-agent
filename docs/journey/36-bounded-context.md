# 36 — Bounding the fixed prompt (issue #77)

Work date(s): 2026-09-26. Written/revised: 2026-09-26.
Status: in progress. Stage 1 (measurement) is on a review branch; stage 2 (relevant tool loading) is not implemented.

## User-visible problem and preceding iteration

[Journal 28](28-context-wire-compaction.md) raised the internal ceiling to 400,000 characters as temporary headroom. That stopped context-limit failures without bounding growth. On 26 September, while checking the Lightsail migration, the owner's live conversation showed `context.over_budget` warnings on most model calls. Stored events show the same warning every day since at least 20 September, so it predates the move. It means the fixed part of each request (instructions, owner state, tool schemas, the current message) already exceeds the 48,000-character allowance for older history. Older conversation is therefore dropped from the prompt on nearly every call. The bot can still retrieve it with `conversation_search`.

## Evidence

Measured on 26 September. Character counts, not provider tokens.

- **Offline inventory** (`npm run context:inventory`, repository definitions, every integration enabled): 70 tool schemas take 38,480 characters. Canvas is the largest domain (4 tools, 8,135), and the instructions are 13,463 characters.
- **Production** (operator read of stored events, 20 model attempts): the fixed envelope was 72,159–73,678 characters, and 19 of 20 selections omitted older history.
- **Tool use over 30 days** (93 runs, about 580 journaled calls): about 40 of the 70 offered tools were used, and canvas tools were never called.

Details and labelled hypotheses are in [context management](../context-management.md#stage-1-measurements--26-september-2026).

## Diagnosis and alternatives

The largest fixed contributor we can change is the tool inventory, which is sent in full on every call regardless of the task. The staged plan in [context management](../context-management.md) keeps a compact core plus explicit domain loading. Stage 1 adds per-call component sizes to `context.selected` and the sanitized log, so stage 2 can be compared on real calls rather than estimates.

## Implementation and review

Stage 1: [PR #103](https://github.com/akhilvuputuri/chief-agent/pull/103). An independent Opus 5.5 review approved `b285024` with low findings: a misleading `historyChars` name, production figures that mixed sources without labels, and this missing journal entry. Those were addressed before merge.

## Verification and outcome

Pending: merge and release of stage 1, then a per-call baseline from CloudWatch (`npm run logs:cloudwatch -- event --event context.selected`).

## Follow-up and next iteration

Stage 2 will add relevant tool loading: a core set, a `tools_load` discovery tool, and domains selected from the message, task state and approvals. The dispatcher stays the authority for permissions. Measure fixed size, extra discovery steps and cache effects before claiming savings.
