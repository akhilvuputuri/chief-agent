# 36 — Bounding the fixed prompt (issue #77)

Work date(s): 2026-09-26. Written/revised: 2026-09-26.
Status: in progress. Stage 1 (measurement) was released on 26 September. Stage 2 (relevant tool loading) is on a review branch.

## User-visible problem and preceding iteration

[Journal 28](28-context-wire-compaction.md) raised the internal ceiling to 400,000 characters as temporary headroom. That stopped context-limit failures without bounding growth. On 26 September, while checking the Lightsail migration, the owner's live conversation showed `context.over_budget` warnings on most model calls. Stored events show the same warning every day since at least 20 September, so it predates the move. It means the fixed part of each request (instructions, owner state, tool schemas, the current message) alone exceeds the 48,000-character soft budget, which leaves no room for older history. Older conversation is therefore dropped from the prompt on nearly every call. The bot can still retrieve it with `conversation_search`.

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

Stage 1 was merged as `8a89231` and released to Lightsail with an exact-commit receipt. No owner messages arrived between that release and the start of stage 2, so there is no per-call production baseline yet. Stage 2 is compared against the offline inventory and the 26 September stored events.

Stage 2 is described in [context management](../context-management.md#stage-2--relevant-tool-loading). The first design returned a "call it again" error when the model called a tool from an unloaded domain. Seven existing test files failed, because their scripted models call such tools directly. Loading the domain and dispatching the call is equally safe, since arguments are validated and the dispatcher decides, and it avoids an extra model step, so that design replaced the first.

## Verification and outcome

Offline (26 September): tool schemas offered on a first message fell from 39,030 characters (71 tools) to 4,007–10,330 (12–25 tools) across six representative scenarios. Production measurements after release are pending: fixed size, omitted history, `tools_load` frequency, and provider cache and usage.

## Follow-up and next iteration

After stage 2 is released, measure fixed size, extra discovery steps and cache effects on real calls before claiming savings. Stages 3–4 (bounded working projection, token-aware admission) remain proposed.
