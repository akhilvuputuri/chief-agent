# 160 — Can Chief call Anthropic directly, alongside OpenRouter, and switch between them?

Work date: 11 November 2026. Written: 11 November 2026.
Status: built and tested with mocked requests on branch `claude/gifted-mccarthy-gond93`; not reviewed, released or enabled. No live Anthropic request has been made, because no key exists yet. Enabling needs a separate Compose change through a reviewed operator procedure.

## User-visible problem and preceding iteration

Every model call has gone through OpenRouter since the owned runtime ([journal 01](01-owned-runtime.md)). Since [journal 100](100-opus-main-model-and-caching.md) the main model and the `standard` agent tier are Anthropic's Opus 5.5, and the coding reviewer is too, so most model spend reaches Anthropic through an intermediary. The owner asked for a second pathway: the Anthropic Messages API directly, with a Claude Console key, with OpenRouter still supported and a way to switch between them.

What the earlier work established and this change keeps: Anthropic caches only marked requests ([journal 100](100-opus-main-model-and-caching.md), [104](104-opus-cache-misses-in-production.md)), and the reviewed price ceilings in `config/model-policy.json` stay in force ([deployment](../deployment.md#changing-the-production-model-through-a-release)).

## Evidence

- **Tested (mocked, 11 November):** `tests/anthropic.test.ts` covers request translation (thinking, effort, betas, cache marks, system-message placement), usage and cost normalization, finish-reason mapping, refusals, server-side fallback boundaries, provider-fault classification only before output, streaming progress and abort, the spending ledger, and the reasoning-strip helper. `tests/model-router.test.ts` covers the four routing conditions, one-call fallback per fault, no fallback on other errors or aborts, cooldowns, and that direct reasoning never reaches OpenRouter. `tests/model-policy.test.ts` builds an adapter for every mapped policy entry and checks its prices against the ceilings. `tests/ops-log.test.ts`, `tests/otel.test.ts` and `tests/runtime-config.test.ts` cover the new log fields, the span provider name and the new setting. These suites passed locally on the working tree.
- **Not verified:** authentication, the effective model, cache behaviour, thinking replay, acceptance of the server-side fallback beta on a new account, rate limits, coding jobs and fallback firing against the real API. All requests in the tests are mocked.
- **Prices:** the adapter computes cost from the per-million prices written in the policy (Opus 5.5: $4 input, $20 output, $0.20 cache read, $5 cache write). These are reviewed configuration values, not provider-reported costs, unlike OpenRouter's `usage.cost`.

## Diagnosis and alternatives

- **Per-model router (chosen):** every gateway model construction calls `ModelRouter.modelFor(slug)`. A slug goes direct only with `MODEL_PROVIDER=anthropic`, a key, a policy entry and listed prices within the ceilings; anything else is the unchanged OpenRouter adapter. The direct adapter returns OpenRouter-shaped generations, so the agent loop, journals, coding proxy and accounting need no provider branches.
- **A global switch for all models (rejected):** search, embeddings, the Jev pickers, the coding catalogue and other vendors' models exist only on OpenRouter.
- **OpenRouter's own Anthropic provider pinning (not chosen):** it keeps the intermediary, which the request was to remove.
- **Fallback to OpenRouter:** a new key, exhausted credits or a low rate-limit tier should not stop the assistant. Falling back only before any output keeps a call from being answered twice; cooldowns keep a dead key from costing one failed request per call.
- **Thinking replay:** Chief rebuilds its message array on every call, so the API usually finds earlier thinking no longer matching. Requests send `prefix_mismatch_behavior: "drop_block"` so that becomes a dropped block instead of a 400. Hypothesis: this costs cache and reasoning continuity, not correctness. An append-only message shape would fix it and is deferred.

## Implementation and review

- [`src/anthropic.ts`](../../src/anthropic.ts): `AnthropicDirect` on the official SDK, streamed, SDK retries, logging and telemetry off. Thinking blocks are stored in `reasoning_details` under the `anthropic.thinking` tag and replayed only on the direct route. Server-side refusal fallbacks are opted in where the model's profile allows. Faults before output are classified as `auth`, `permission`, `billing`, `rate_limit`, `unavailable` or `not_found`; every direct failure's diagnostics carry `route: "anthropic-direct"`.
- [`src/model-router.ts`](../../src/model-router.ts): routing, the one-call OpenRouter fallback and per-process cooldowns (600 s for key, permission, billing and unknown-model faults, the `retry-after` hint within 5–120 s for rate limits, none for outages). Key, billing and rate-limit faults cool every model; permission and unknown-model faults only the failing one.
- `config/model-policy.json` gains `providers.anthropic` (fallback on, Opus 5.5 mapped); `config/runtime.json` and the code default set `MODEL_PROVIDER` to `anthropic`, which is inert without a key. `src/main.ts` routes the main, media, agent, learner, judge and coding-factory models through the router and logs `model.routes` at startup. `model.completed`/`model.failed` gain `route` and `fallbackFrom`, `model.provider_fallback` is new, spans name `anthropic` as the provider on the direct route, and direct charges are labelled `anthropic-main`.
- The Compose line that would pass `ANTHROPIC_API_KEY` to the gateway is deliberately not part of this change, because the release guard refuses Compose changes.

Operator guide: [model providers](../model-providers.md). Independent review: pending.

## Verification and outcome

Implemented and tested with mocks only. Nothing is measured: no latency, cache hit rate or cost comparison with OpenRouter exists. The first live run must verify authentication, the effective model, cached tokens, `thinking_dropped`, acceptance of the refusal-fallback beta, a Pi coding job with a direct reviewer, rate-limit behaviour on a new low-tier account and fallback firing ([checklist](../model-providers.md#first-live-run)).

### Release closure

Pending: independent review, merge and release of the adapter (inert in production), then the separate Compose PR and operator key rollout, then the first live run.

## Coding-harness learning record

Updated in [coding-agent lessons](coding-agent-lessons.md). The host proxy boundary is unchanged: sandboxes still hold no provider key and call the host, whose model factory now goes through the router. Once enabled, the coding reviewer (`anthropic/claude-opus-5.5`) would run direct; the DeepSeek coders stay on OpenRouter. Pi's OpenAI-completions client keeps only OpenAI-style reasoning entries, so it drops the direct route's thinking entries between tool turns; with `drop_block` that is expected to cost continuity, not fail requests (hypothesis). Nothing about review quality or cost on the direct route is measured.

## Follow-up and next iteration

- Review, merge and release the adapter; then the Compose PR and key rollout ([model providers](../model-providers.md#enabling-it)).
- First live run checklist, recorded here with dated evidence.
- Deferred: an append-only message shape so thinking survives between calls; persistent cooldowns; a same-workload cost and cache comparison against OpenRouter.
