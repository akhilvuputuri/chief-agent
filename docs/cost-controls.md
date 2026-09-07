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
