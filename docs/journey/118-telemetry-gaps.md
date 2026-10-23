# 118 — Why did the CloudWatch logs not show token sums, finish reasons or older-history size?

Work date(s): 2026-10-23. Written/revised: 2026-10-23.
Status: in review. Independent review: pending. `model.completed` now records why the model stopped (`finishReason`) and cache-write tokens; `context.selected` records the older history admitted and its remaining size parts; the `models` CloudWatch query reports token sums again, and new `finishes` and `context` queries exist. Not released; nothing here is measured from the new fields yet.

## User-visible problem and preceding iteration

Private production reviews in October 2026 tried to answer three operational questions from the sanitized CloudWatch logs ([operational logs](../operational-logs.md)) and could not:

- Was a reply cut off at the output limit? `model.completed` did not record the finish reason; only `model.failed` carried it, in `state`.
- How many input, cached and output tokens did each model use? The `models` query returned call counts, latency and reported cost, but no token columns, although `src/ops-log.ts` projects `inputTokens`, `cachedTokens` and `outputTokens`.
- How much older history reached the prompt? [Journal 104](104-opus-cache-misses-in-production.md) and [journal 113](113-bigger-context-and-cached-state.md) changed how older history is admitted and latched, but `context.selected` recorded only the protected part (`protectedHistoryChars`), which excludes older history.

[Journal 108](108-keep-in-turn-reasoning.md) added `reasoningSize` and `reasoningDropped` to the private `context.selected` trace, but they were never projected, so its production measure of reasoning size could not be read from CloudWatch either.

## Evidence

- **Measured, CloudWatch, 23 October 2026.** Read-only Logs Insights queries on `/chief/prod/runtime` with the local log-reader profile. Aggregates only.
  - Over 9–23 October, every `model.completed` line carried `inputTokens`, `cachedTokens`, `outputTokens` and `costUsd` (for example 74 of 74 lines on 20 October, 32 of 32 on 21 October). The fields were present on the lines.
  - The saved `models` query, run unchanged on the 19–21 October window (96 model lines), returned `calls`, `avgMs` and `reportedUsd` only. The same query with the token aliases renamed (`sum(inputTokens) as inputTokensSum`, and so on) returned the sums on the same window, for example about 1.32M input, 0.51M cached and 19.5k output tokens for Opus 5.5 over 40 calls.
  - All 46 Opus 5.5 `model.completed` lines in the 14-day window had `dropped: 1` and no `provider`; Gemini and GPT lines had a provider on every line. So the `models` query cannot group Opus calls by provider.
  - The last 24 hours (22–23 October) held no model lines (heartbeats and portfolio syncs only), so no line from release `9fc5ecc` was available to inspect.
- **Code-confirmed.** `OpenRouter.generate` (`src/model.ts`) read `finish_reason` into its error diagnostics but did not return it on success, and `src/custom-agent.ts` traced `model.completed` without it. `src/context.ts` computed the admitted older history (`bounded`) but did not return its size.
- **Reported.** A probe on 20 October showed OpenRouter's usage carrying `prompt_tokens_details.cache_write_tokens` (journal 108's table of cache writes comes from it). It was not projected.
- **Hypothesis.** The Opus provider is dropped because its display name fails the `provider` shape (at most three words, each starting with a letter or digit). Journal 108 recorded OpenRouter routing Opus to "Claude Platform on AWS", four words, which fails it. The private `events` table would confirm the exact label; it was not read for this change.

## Diagnosis and alternatives

The missing token sums were a query bug, not a projection bug. In the `models` query's `stats` clause, three aggregates reused the name of the field they summed (`sum(inputTokens) as inputTokens`). Logs Insights then omitted those columns without an error. `avg(latencyMs) as avgMs` and `sum(costUsd) as reportedUsd` used different names and appeared. Renaming the aliases fixes it; a test now rejects any saved `stats` alias that reuses a field the clause aggregates or groups by.

For the finish reason, the allowlist already used `state` for it on `model.failed`. A dedicated `finishReason` name field was added instead, so one query can group completed and failed calls together (`stats ... by event, model, finishReason`), and `model.failed` keeps `state` for existing queries. The provider's value is mapped in the projection to a fixed set (`stop`, `tool_calls`, `length`, `content_filter`, `error`, otherwise `other`), so only host-defined names reach the log, not provider text. The private trace keeps the provider's value (bounded to 60 characters, as the error diagnostics already did).

For older history, `context()` now returns `historySize` (serialized characters of the admitted older messages, measured like the other parts) and `historyMessages`. The trace also records `historyAllowance`, which shows when a turn latched older history to 0. All three are projected as counts (`historyChars`, `historyMessages`, `historyAllowanceChars`).

Other `context.selected` fields that were already in the private trace are now projected: the three parts of `protectedHistoryChars` (`exchangeChars`, `workingChars`, `reservedChars`), `reasoningChars`, `reasoningDropped`, `compactedCount` and `wireCompacted`. All are sizes, counts or booleans computed by the host. `runtimeParts` (sizes per runtime-context key) stays private: its key names are dynamic and would need a new shape.

The provider shape was deliberately not widened. Allowing four words let one of the existing private fixtures (a token followed by three words) pass the shape, which the shape tests exist to prevent. A fixed mapping of known provider labels, or a provider identifier instead of the display name, would close the gap without widening the shape; both are left as follow-up.

## Implementation and review

- [src/model.ts](../../src/model.ts): `Generation.finishReason`, returned on success.
- [src/custom-agent.ts](../../src/custom-agent.ts): `model.completed` records `finishReason`; `context.selected` records `historyAllowance`, `historySize` and `historyMessages`.
- [src/context.ts](../../src/context.ts): `historySize` and `historyMessages` on the selection.
- [src/ops-log.ts](../../src/ops-log.ts): new fields `finishReason` (name), `cacheWriteTokens` and the context counts and booleans; `finishName` maps finish reasons to fixed names; projections for `model.completed`, `model.failed` and `context.selected` extended.
- [scripts/cloudwatch-logs.mjs](../../scripts/cloudwatch-logs.mjs): `models` uses distinct aliases and adds cache-write and reasoning token sums; new `finishes` and `context` queries; the shared field list adds the finish reason, token counts and `historyChars`.
- Tests:
  - [tests/ops-log.test.ts](../../tests/ops-log.test.ts): finish reason and cache-write tokens on `model.completed`; finish reasons only as fixed names (unknown and hostile values become `other`); the new `context.selected` fields; hostile payloads for the new source keys.
  - [tests/context-continuity.test.ts](../../tests/context-continuity.test.ts): `historyMessages` matches the older messages actually sent, including after the allowance latches to 0.
  - [tests/custom-runtime.test.ts](../../tests/custom-runtime.test.ts): the adapter returns the finish reason on success.
  - [tests/effort.test.ts](../../tests/effort.test.ts): a real turn records the finish reason privately and on its log line, and the history sizes in `context.selected`.
  - [scripts/cloudwatch-logs.test.mjs](../../scripts/cloudwatch-logs.test.mjs): no `stats` alias shadows a field it aggregates or groups by (the old `models` query fails it); `models`, `finishes` and `context` query shapes.

Independent review: pending.

## Verification and outcome

- **Tested.** `npx tsc --noEmit -p .`; `ops-log`, `context-continuity`, `custom-runtime`, `effort`, `openrouter-stream`, `tool-domains`, `context-budget`, `model-cache-hints`, `cache-key`, `steering-loop`, `agents`, `research` and `coding-events` test files; `node --test scripts/cloudwatch-logs.test.mjs`. The full suite was not run in this change.
- **Measured.** The renamed `models` query and the new `finishes` and `context` queries ran without error against production logs from 19–21 October. Those lines predate the new fields, so `finishReason`, `cacheWriteTokens` and the history counts were absent from the results.
- **Pending after release.**
  - `npm run logs:cloudwatch -- finishes --since 24h` shows `finishReason` on `model.completed` lines;
  - `models` shows `cacheWriteTokensSum` for Opus;
  - `context` shows `historyChars` and `historyAllowanceChars`.

## Follow-up and next iteration

- Opus calls carry no provider in CloudWatch (hypothesis above). Confirm the label from the private `events` table, then choose a fixed provider mapping or a provider identifier field.
- `finishReason` on successful calls makes `length` measurable. If it appears, compare it with the 8,000-token output allowance in `src/model.ts`.
- `runtimeParts` stays private; projecting it would need a fixed key list.
