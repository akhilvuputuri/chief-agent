# 118 — Why did the CloudWatch logs not show token sums, finish reasons or older-history size?

Work date(s): 2026-10-23. Written/revised: 2026-10-23.
Status: in review. Independent review: approve with nits on the first head; approve on the fixed head (2f018c6). `model.completed` now records why the model stopped (`finishReason`) and cache-write tokens; model providers are logged as fixed slugs, so Opus calls carry a provider again; `model.failed` carries the model; `context.selected` records the older history admitted and its remaining size parts; the `models` CloudWatch query reports token sums again, and new `finishes` and `context` queries exist. Not released; nothing here is measured from the new fields yet.

## User-visible problem and preceding iteration

Private production reviews in October 2026 tried to answer four operational questions from the sanitized CloudWatch logs ([operational logs](../operational-logs.md)) and could not:

- Was a reply cut off at the output limit? `model.completed` did not record the finish reason; only `model.failed` carried it, in `state`.
- How many input, cached and output tokens did each model use? The `models` query returned call counts, latency and reported cost, but no token columns, although `src/ops-log.ts` projects `inputTokens`, `cachedTokens` and `outputTokens`.
- Which provider served Opus, and which model failed? Opus lines had no `provider`, and `model.failed` lines had no `model`, so failures could not be grouped by model.
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
- **Measured, private `events` table, 23 October 2026.** A read-only query (`SELECT DISTINCT`-style grouping of the provider label by model over `model.completed`, last 14 days; no other payload fields read) found five labels (seven label–model pairs): "Google" (Gemini 3.8 Flash 80 calls, Gemini 4 Argon 61), "Claude Platform on AWS" (Opus 5.5, 46), "Azure" (GPT-6.1 Sol, 29), "Google AI Studio" (Flash 17, Argon 4) and "OpenAI" (GPT-6.1 Sol, 2). The 9 `model.failed` events in the same window had no provider in their diagnostics.
- **Diagnosed.** "Claude Platform on AWS" has four words, and the `provider` shape allows at most three, so every Opus line dropped it (the 46 lines with `dropped: 1` above). Journal 108 had already reported OpenRouter routing Opus there.

## Diagnosis and alternatives

The missing token sums were a query bug, not a projection bug. In the `models` query's `stats` clause, three aggregates reused the name of the field they summed (`sum(inputTokens) as inputTokens`). Logs Insights then omitted those columns without an error. `avg(latencyMs) as avgMs` and `sum(costUsd) as reportedUsd` used different names and appeared. Renaming the aliases fixes it; a test now rejects any saved `stats` alias that reuses a field the clause aggregates or groups by.

For the finish reason, the allowlist already used `state` for it on `model.failed`. A dedicated `finishReason` name field was added instead, so one query can group completed and failed calls together (`stats ... by event, model, finishReason`), and `model.failed` keeps `state` for existing queries. The provider's value is mapped in the projection to a fixed set (`stop`, `tool_calls`, `length`, `content_filter`, `error`, otherwise `other`), so only host-defined names reach the log, not provider text. The private trace keeps the provider's value (bounded to 60 characters, as the error diagnostics already did).

For older history, `context()` now returns `historySize` (serialized characters of the admitted older messages, measured like the other parts) and `historyMessages`. The trace also records `historyAllowance`, which shows when a turn latched older history to 0. All three are projected as counts (`historyChars`, `historyMessages`, `historyAllowanceChars`).

Other `context.selected` fields that were already in the private trace are now projected: the three parts of `protectedHistoryChars` (`exchangeChars`, `workingChars`, `reservedChars`), `reasoningChars`, `reasoningDropped`, `compactedCount` and `wireCompacted`. All are sizes, counts or booleans computed by the host. `runtimeParts` (sizes per runtime-context key) stays private: its key names are dynamic and would need a new shape.

The provider shape was deliberately not widened. Allowing four words let one of the existing private fixtures (a token followed by three words) pass the shape, which the shape tests exist to prevent. Instead the projection maps known display names to fixed slugs. Seen in production: "Claude Platform on AWS" → `claude-aws`, "Google" → `google`, "Google AI Studio" → `google-ai-studio`, "OpenAI" → `openai`, "Azure" → `azure`. Not yet seen, listed as anticipated routes for Anthropic and Gemini models: "Anthropic" → `anthropic`, "Amazon Bedrock" → `bedrock`, "Google Vertex" → `vertex`. Every unlisted label is logged as `other`, so the provider field carries only host-defined names, as the [operational-log contract](../operational-logs.md#safety-contract) requires of fields fed from third-party text. The raw label stays in the private trace. An earlier revision of this change kept unlisted labels that fit the three-word shape; review asked for the strict form. Logged provider values therefore change from display names to slugs for these providers after release: queries that compare provider values across the release boundary need both forms.

`model.failed` now traces the requested model (`model.model`) and projects it with the same `model` shape as `model.completed`, so failures carry a model. The two differ in meaning: `model` on `model.completed` is the model OpenRouter reports as serving the call, while on `model.failed` it is the requested model. So both events also carry `requestedModel` (the same shape; on `model.completed` from the trace's new `requestedModel`), and `stats count(*) by event, requestedModel` gives a failure rate per requested model; the saved `models` and `finishes` queries group by the served `model`, so a failure and a completion of the same request can land in different rows when OpenRouter reports a different slug. Lines from before the release have no `requestedModel`. `state` on `model.failed` now goes through the same fixed finish-reason names; no saved query or code groups by its raw value (checked: `scripts/cloudwatch-logs.mjs`, `src/coding/diagnostics.ts`).

## Implementation and review

- [src/model.ts](../../src/model.ts): `Generation.finishReason`, returned on success.
- [src/custom-agent.ts](../../src/custom-agent.ts): `model.completed` records `finishReason`; `model.completed` and `model.failed` record `requestedModel`; `context.selected` records `historyAllowance`, `historySize` and `historyMessages`.
- [src/context.ts](../../src/context.ts): `historySize` and `historyMessages` on the selection.
- [src/ops-log.ts](../../src/ops-log.ts): new fields `finishReason` (name), `cacheWriteTokens` and the context counts and booleans; `finishName` maps finish reasons to fixed names; `providerName` maps known provider labels to slugs and everything else to `other`; `requestedModel` field; projections for `model.completed`, `model.failed` and `context.selected` extended.
- [scripts/cloudwatch-logs.mjs](../../scripts/cloudwatch-logs.mjs): `models` uses distinct aliases and adds cache-write and reasoning token sums; new `finishes` and `context` queries; the shared field list adds the finish reason, token counts and `historyChars`.
- Tests:
  - [tests/ops-log.test.ts](../../tests/ops-log.test.ts): finish reason and cache-write tokens on `model.completed`; finish reasons only as fixed names (unknown and hostile values become `other`); the new `context.selected` fields; hostile payloads for the new source keys; the four-word Opus label maps to `claude-aws`, and unlisted labels (including ones that fit the three-word shape) and hostile labels become `other`; `model.completed` carries served and requested models; `model.failed` carries a valid model as both and still drops one that fails the model shape.
  - [tests/context-continuity.test.ts](../../tests/context-continuity.test.ts): `historyMessages` and `historySize` equal the count and serialized length of the older messages actually sent, including after the allowance latches to 0.
  - [tests/openrouter-stream.test.ts](../../tests/openrouter-stream.test.ts): a complete stream returns `stop` or `tool_calls` as the generation's finish reason.
  - [tests/custom-runtime.test.ts](../../tests/custom-runtime.test.ts): the adapter returns the finish reason on success; a retried `model.failed` trace records the model.
  - [tests/effort.test.ts](../../tests/effort.test.ts): a real turn records the finish reason privately and on its log line, and the history sizes in `context.selected`.
  - [scripts/cloudwatch-logs.test.mjs](../../scripts/cloudwatch-logs.test.mjs): no alias in any `stats` clause of a query shadows a field that clause aggregates or groups by (the old `models` query fails it, and a fixture checks a second clause); `models`, `finishes` and `context` query shapes.

Independent review of the earlier head returned approve with nits:

- miscounts in this entry;
- the provider-map comment claimed every label had been seen;
- unlisted provider labels were still logged as provider text;
- the requested and served models were undocumented;
- three tests were weak (an inexact history-size check, an alias check that read only the first `stats` clause, no streamed finish reason).

All were fixed in the next commit, and `state` on `model.failed` was mapped to fixed names too. Re-review of the fixed head approved with nits: the saved queries still group by served model (documented above), and `requestedModel` was added to the shared query field list.

## Verification and outcome

- **Tested.** `npx tsc --noEmit -p .`; `ops-log`, `context-continuity`, `custom-runtime`, `effort`, `openrouter-stream`, `tool-domains`, `context-budget`, `model-cache-hints`, `cache-key`, `steering-loop`, `agents`, `research` and `coding-events` test files; after the provider and failed-model change, `ops-log` (18), `custom-runtime` (29), `effort` (11) and the `coding-automation` diagnostics tests (3); after review fixes, `ops-log`, `context-continuity`, `custom-runtime`, `openrouter-stream` and the script tests; `node --test scripts/cloudwatch-logs.test.mjs`. The full suite was not run in this change.
- **Measured.** The renamed `models` query and the new `finishes` and `context` queries ran without error against production logs from 19–21 October. Those lines predate the new fields, so `finishReason`, `cacheWriteTokens` and the history counts were absent from the results.
- **Pending after release.**
  - `npm run logs:cloudwatch -- finishes --since 24h` shows `finishReason` on `model.completed` lines;
  - `models` shows `cacheWriteTokensSum` for Opus;
  - `context` shows `historyChars` and `historyAllowanceChars`;
  - `models` shows `claude-aws` as the Opus provider, and `model.failed` rows carry a model.

## Follow-up and next iteration

- The provider map is fixed. A new provider logs as `other` until its label is added; the private trace shows which label it was.
- `finishReason` on successful calls makes `length` measurable. If it appears, compare it with the 8,000-token output allowance in `src/model.ts`.
- `runtimeParts` stays private; projecting it would need a fixed key list.
