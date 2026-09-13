# Token efficiency and usage visibility

There is **no new dollar cap**. The user explicitly declined the proposed $1 allocation. `/continue` retains its existing time/model/tool behavior; no monetary allocation is added. Existing model and provider-routing settings are unchanged.

## Measured problem

The latest 22-role run used 16 Sol calls, 326,051 input tokens, 7,193 output tokens (394 reasoning tokens), zero cache hits and $0.8870335 reported main-model cost. Input accounted for $0.8151035. It attempted 57 searches using only 37 distinct strings, then exhausted 100 tools before a final answer. Search inference/plugin usage was discarded by the old adapter, so that total excluded part of the bill.

## Changes

- Keep instructions and explicit memories in a stable opening message. Put changing time, checkpoints, inventories and usage summaries in a separate message after selected history. Pass an opaque runtime run ID as OpenRouter `session_id` for provider stickiness within a turn. Continuations get new run IDs; cross-turn cache reuse is not guaranteed.
- Reduce the total context character allowance from 100,000 to 48,000, including instructions, schemas, memories and current state. Preserve complete tool/result groups, the current request and compact inventories. Full observations remain retrievable. Medium reasoning and the 8,000-output-token capacity remain unchanged: input dominated the observed bill.
- Reuse normalized identical successful searches within the same owner and attached task/run for one hour. Cached observations do not extend original expiry. New unrelated tasks search fresh; semantic variants are not deduplicated. Source data remains untrusted.
- Record main-model and search-helper usage, including reported dollar cost, token counts and cache details. Begin a persisted accounting record before dispatch, then settle with reported usage. Missing/failed-request cost remains unknown with a separate estimate. It is never presented as an actual charge or as zero-cost success.
- Tell the agent to reuse research, read promising original pages before searching again, correct failed source quotes and prioritize useful synthesis over marginal repeated discovery.

## Accounting schema and estimates

Additive migration 008 creates `provider_charges`, linked to owner-scoped runtime runs. `actual_usd` is nullable. `estimated_usd` is an accounting hint for requests whose cost is unavailable, not a reservation against a budget. `usage` retains provider metadata. The current task's reported cost, unknown-cost count and estimate total are supplied to the model separately. This never blocks a request based on dollars.

Main-model estimates use input UTF-8 bytes plus an overhead allowance, configured prices with a 1.25 cache-write multiplier, and maximum output capacity. They deliberately overestimate typical use. Unknown search requests use a $0.10 policy estimate; optional Tavily calls use $0.05 because dollar usage is unavailable. These are not invoice amounts or guaranteed billing bounds. Successful OpenRouter requests use the returned `usage.cost`; no guessed plugin fee is added separately.

Speech runs outside the task loop and is not included here. Neither are infrastructure, other applications sharing the key or historical requests before migration. This ledger is not a complete provider bill. Existing base-price routing filters do not cap cache-write premiums or total task spending.

## Verification and operation

Focused tests cover stable opening prompts, intact tool observations, owner/task isolation, search reuse without network calls, persisted usage across task runs, unknown-versus-reported cost, and accepting an estimate above $1 without imposing a cap. Provider request tests verify the session ID while retaining Sol, medium reasoning and the existing routing filters.

Apply migration 008 before restarting the app. It does not apply the deferred migration-007 scope/finding candidate, reset user data or resume paused work. Keep the additive table on rollback. Full paid evals remain deferred. Actual cache-hit rates and savings still require observation during normal use; no percentage savings claim is made from deterministic tests.

References used during analysis:

- [OpenRouter caching and cache-write pricing](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- [OpenRouter search/plugin pricing](https://openrouter.ai/docs/guides/features/plugins/web-search)

## Release

PR #16 passed CI and merged. Application revision `a31813bd167e3916c1914966a386a4a480f54320` is deployed on the existing server. Health passed; the usage table exists, all 22 jobs remain, and the existing task remains paused. Verified that no `budget_dollars` column exists. No paid test request or full analysis was triggered. Cache-hit rate and cost improvement will be measured from subsequent ordinary usage.

## Context allowance follow-up — 13 September 2026

The 48,000-character allowance is unchanged, but it now bounds prior history rather than acting as a turn precondition. Tool schemas and runtime state have grown to roughly 30,000 characters before any message, so a user turn carrying a document excerpt can push the fixed part close to or over the allowance. On 12 September (18:46 UTC) such a turn failed 36 ms after its first model allocation with no provider diagnostics and the user saw a generic execution error. The guard throwing is the most plausible cause given the timing signature and local measurement of the same file; the live state size was inferred, not captured, because the failure predates the traces added here.

Behavior now: the current user message and this turn's newest tool group (the assistant call and its results) form a floor that is always sent, so the model never loses the results it just requested. Prior history and older in-turn tool groups share the unchanged 48,000-character allowance newest-first, exactly as before, so the per-request ceiling for ordinary long turns is unchanged. Only when the fixed part plus that floor already exceed the allowance does a request exceed it; that case records a `context.over_budget` event with the measured fixed and floor sizes, and the trailing state line tells the model that only the current message and its newest results are included. When reading event frequency, note that the event can also fire mid-turn when the newest tool group itself is large (for example an 8,000-character projected observation on top of a 36,000-character fixed part); `reservedSize` distinguishes that from an oversized fixed part, which is the compaction trigger. A fixed part plus floor beyond a 120,000-character hard limit is refused, and that refusal records its sizes in `model.failed` instead of failing silently. Non-provider failures in the model step also record a bounded error identity. The inline PDF excerpt stays at 6,000 characters; reducing it, or compacting tool descriptions, are the next levers if `context.over_budget` events appear regularly.
