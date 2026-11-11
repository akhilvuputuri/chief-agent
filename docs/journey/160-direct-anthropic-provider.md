# 160 — Can Chief call Anthropic directly, alongside OpenRouter, and switch between them?

Work date: 11 November 2026. Written: 11 November 2026.
Status: built and tested with mocked requests on branch `claude/gifted-mccarthy-gond93`; not reviewed, released or enabled. No live Anthropic request has been made, because no key exists yet. Enabling needs a separate Compose change through a reviewed operator procedure.

## User-visible problem and preceding iteration

Every model call has gone through OpenRouter since the owned runtime ([journal 01](01-owned-runtime.md)). Since [journal 100](100-opus-main-model-and-caching.md) the main model and the `standard` agent tier are Anthropic's Opus 5.5, and the coding reviewer is too, so most model spend reaches Anthropic through an intermediary. The owner asked for a second pathway: the Anthropic Messages API directly, with a Claude Console key, with OpenRouter still supported and a way to switch between them.

What the earlier work established and this change keeps: Anthropic caches only marked requests ([journal 100](100-opus-main-model-and-caching.md), [104](104-opus-cache-misses-in-production.md)), and the reviewed price ceilings in `config/model-policy.json` stay in force ([deployment](../deployment.md#changing-the-production-model-through-a-release)).

## Evidence

- **Tested (mocked, 11 November):** `tests/anthropic.test.ts` covers request translation (thinking, effort, the single beta, no `fallbacks`, cache marks on Chief's two-leading-system shape, system-message placement, empty tool results, the workspace header), usage and cost normalization, finish-reason mapping, refusals, ignored stored `fallback` blocks, provider-fault classification only before output (including `rejected` and the beta-enrollment code), the complete-response wire bound, streaming progress and abort, the spending ledger, and the reasoning-strip helper. `tests/model-router.test.ts` covers the four routing conditions, one-call fallback per fault, no fallback on refusals, other errors or aborts, cooldowns (none for an ordinary rejected request, 600 s for beta enrollment), and that direct reasoning never reaches OpenRouter for any vendor's model. `tests/model-policy.test.ts` builds an adapter for every mapped policy entry and checks its prices against the ceilings. `tests/ops-log.test.ts`, `tests/otel.test.ts` and `tests/runtime-config.test.ts` cover the new log fields, the span provider name and the new setting. These suites passed locally on the working tree.
- **Not verified:** authentication, the effective model, cache behaviour, thinking replay, acceptance of the thinking-binding beta on a new account, rate limits, coding jobs and fallback firing against the real API. All requests in the tests are mocked.
- **Reported (live probing by another session, not repeated here):** a Console key of the `sk-ant-usr-` kind can be unscoped; without an `anthropic-workspace-id: wrkspc_…` header it got HTTP 400 `invalid_request_error` saying the key is not scoped to a workspace, and HTTP 200 with it. A workspace-scoped key needs no header. This prompted `ANTHROPIC_WORKSPACE_ID`.
- **Prices:** the adapter computes cost from the per-million prices written in the policy (Opus 5.5: $4 input, $20 output, $0.20 cache read, $5 cache write). These are reviewed configuration values, not provider-reported costs, unlike OpenRouter's `usage.cost`.

## Diagnosis and alternatives

- **Per-model router (chosen):** every gateway model construction calls `ModelRouter.modelFor(slug)`. A slug goes direct only with `MODEL_PROVIDER=anthropic`, a key, a policy entry and listed prices within the ceilings; anything else is the unchanged OpenRouter adapter. The direct adapter returns OpenRouter-shaped generations, so the agent loop, journals, coding proxy and accounting need no provider branches.
- **A global switch for all models (rejected):** search, embeddings, the Jev pickers, the coding catalogue and other vendors' models exist only on OpenRouter.
- **OpenRouter's own Anthropic provider pinning (not chosen):** it keeps the intermediary, which the request was to remove.
- **Fallback to OpenRouter:** a new key, exhausted credits or a low rate-limit tier should not stop the assistant. Falling back only before any output keeps a call from being answered twice; cooldowns keep a dead key from costing one failed request per call. A 400 before any output is `rejected` and falls back that call only, so a rejected request shape (or a missing workspace header) cannot strand the assistant; the beta-enrollment 400 (`organization_not_enrolled_in_beta`) would fail every call, so it cools the direct pathway for 600 s. A 413 stays unclassified, because OpenRouter would forward the same oversized request to the same model.
- **Server-side refusal fallback (removed after review):** the first version opted in (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). Independent review found it can serve a refused call on Opus 5 or Opus 4.8 at $5/$25, above the owner-approved $4/$20 ceilings, with sticky routing for later turns, and the adapter would have priced it at Opus 5.5's rates. It was removed: a refusal is now the existing non-transient `refusal` failure, with no fallback anywhere.
- **Thinking replay:** Chief rebuilds its message array on every call, so the API usually finds earlier thinking no longer matching. Requests send `prefix_mismatch_behavior: "drop_block"` so that becomes a dropped block instead of a 400. Hypothesis: this costs cache and reasoning continuity, not correctness. An append-only message shape would fix it and is deferred.

## Implementation and review

- [`src/anthropic.ts`](../../src/anthropic.ts): `AnthropicDirect` on the official SDK, streamed, SDK retries, logging and telemetry off. Thinking blocks are stored in `reasoning_details` under the `anthropic.thinking` tag and replayed only on the direct route. Server-side refusal fallbacks are deliberately never requested. Faults before output are classified as `auth`, `permission`, `billing`, `rate_limit`, `unavailable`, `not_found` or `rejected`; every direct failure's diagnostics carry `route: "anthropic-direct"`, plus the API's `errorType` and `errorCode` enum values when present. The opening (stable) system block is the one cache-marked, as `cacheHints` does on OpenRouter. An optional `workspaceId` is sent as `anthropic-workspace-id`.
- [`src/model-router.ts`](../../src/model-router.ts): routing, the one-call OpenRouter fallback and per-process cooldowns (600 s for key, permission, billing, unknown-model and beta-enrollment faults, the `retry-after` hint within 5–120 s for rate limits, none for outages or other rejected requests). Key, billing, rate-limit and beta-enrollment faults cool every model; permission and unknown-model faults only the failing one. Every OpenRouter adapter strips direct-route reasoning, whatever the model's vendor, and passes requests without it unchanged.
- `config/model-policy.json` gains `providers.anthropic` (fallback on, Opus 5.5 mapped); `config/runtime.json` and the code default set `MODEL_PROVIDER` to `anthropic`, which is inert without a key. `src/main.ts` routes the main, media, agent, learner, judge and coding-factory models through the router and logs `model.routes` at startup. `model.completed`/`model.failed` gain `route` and `fallbackFrom`, `model.provider_fallback` is new (with `reason`, `cooldownS`, `httpStatus`, `errorType`, `errorCode`), the saved CloudWatch queries show those fields, spans name `anthropic` as the provider on the direct route, and direct charges are labelled `anthropic-main`.
- `ANTHROPIC_WORKSPACE_ID` (optional, `wrkspc_…`, default empty) is a private environment identifier beside the key, not a `config/runtime.json` setting, because that file refuses identifiers.
- The Compose lines that would pass `ANTHROPIC_API_KEY` and `ANTHROPIC_WORKSPACE_ID` to the gateway are deliberately not part of this change, because the release guard refuses Compose changes. `scripts/deploy-anthropic-key.py` permits exactly those two lines, in that order, after the gateway's `OPENROUTER_API_KEY`.

Operator guide: [model providers](../model-providers.md). Independent review: the first review requested changes (the refusal-fallback price exposure above, 400s stranding the assistant, the cache mark on the per-turn summary instead of the stable system message, stripping only for `anthropic/*` slugs); they are addressed in the working tree and await re-review.

## Verification and outcome

Implemented and tested with mocks only. Nothing is measured: no latency, cache hit rate or cost comparison with OpenRouter exists. The first live run must verify authentication (and the workspace header for an unscoped key), the effective model, cached tokens, `thinking_dropped`, acceptance of the thinking-binding beta, a Pi coding job with a direct reviewer, rate-limit behaviour on a new low-tier account and fallback firing ([checklist](../model-providers.md#first-live-run)).

### Release closure

Pending: independent review, merge and release of the adapter (inert in production), then the separate Compose PR and operator key rollout, then the first live run.

## Coding-harness learning record

Updated in [coding-agent lessons](coding-agent-lessons.md). The host proxy boundary is unchanged: sandboxes still hold no provider key and call the host, whose model factory now goes through the router. Once enabled, the coding reviewer (`anthropic/claude-opus-5.5`) would run direct; the DeepSeek coders stay on OpenRouter. Pi's OpenAI-completions client keeps only OpenAI-style reasoning entries, so it drops the direct route's thinking entries between tool turns; with `drop_block` that is expected to cost continuity, not fail requests (hypothesis). Nothing about review quality or cost on the direct route is measured.

## Follow-up and next iteration

- Review, merge and release the adapter; then the Compose PR and key rollout ([model providers](../model-providers.md#enabling-it)).
- First live run checklist, recorded here with dated evidence.
- Deferred: an append-only message shape so thinking survives between calls; persistent cooldowns; a same-workload cost and cache comparison against OpenRouter.
