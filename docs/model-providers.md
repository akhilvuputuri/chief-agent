# Model providers

Chief has two model pathways: OpenRouter, which every call used until November 2026, and the Anthropic Messages API called directly with a Claude Console key. Both stay supported. Which one serves a call is decided per model when the gateway starts, from reviewed configuration and the presence of a key. See [journal 160](journey/160-direct-anthropic-provider.md) for why and what is still unverified.

**State (11 November 2026):** built on branch `claude/gifted-mccarthy-gond93`, tested with mocked requests and verified live against the real API with a temporary key on 11 November 2026 ([live verification](#live-verification-11-november-2026)). Not released and not enabled: production has no `ANTHROPIC_API_KEY`, and Compose does not pass one to the gateway yet, so every call still goes through OpenRouter. The live runs used a stand-in for OpenRouter and no Docker sandbox, so the real OpenRouter fallback and the production role mix remain unverified.

## How a model is routed

Every model the gateway builds goes through `ModelRouter.modelFor(slug)` in [`src/model-router.ts`](../src/model-router.ts): the main model, the media model, agents and research specialists, the nightly learner and judge, and the coding controller's model factory. The coding factory is the whole coding pathway: Pi and the Python squad sandboxes never hold a provider key and send every model call to the host proxy, which uses that factory.

A slug goes **direct** only when all of these hold:

1. `MODEL_PROVIDER` is `anthropic`. The code default and `config/runtime.json` are both `anthropic`, so this is inert until a key arrives.
2. `ANTHROPIC_API_KEY` is set in the gateway's environment. A Console key that is not scoped to a workspace also needs `ANTHROPIC_WORKSPACE_ID` (below); without it every direct call is rejected and falls back.
3. The slug is listed in `config/model-policy.json` under `providers.anthropic.models`.
4. Its listed input and output prices are within the effective price ceilings (`priceCeilings` in the same file, $4/$20 today).

Otherwise the slug uses the OpenRouter adapter exactly as before, with the same `max_price` ceilings. Today only `anthropic/claude-opus-5.5` is mapped. With a key it would serve the main model, the `standard` agent tier (which the learner uses) and the coding reviewer (`reviewerModel` in `config/coding.json` and `config/coding-pi.json`). The `fast` tier (Gemini), the judge (GPT-6.1 Sol) and the DeepSeek coders stay on OpenRouter.

These always stay on OpenRouter, whatever the setting: other vendors' models, web search and the search helper, embeddings (recall and mail recall), the Jev pickers and shadow decisions, the coding model catalogue check, and agentwatch's judges. `OPENROUTER_API_KEY` therefore remains required.

The adapter keeps the OpenRouter slug as the model name, so journals, settings, coding jobs and logs see the same `model` either way. Conversations can move between pathways and models: thinking blocks produced on the direct route are stored in `reasoning_details` under their own tag (`anthropic.thinking`, format `anthropic-direct-v1`), replayed only on the direct route, and removed before every OpenRouter request, whatever the model's vendor (a conversation can continue on Gemini or GPT after a model switch). A request with no such entries reaches OpenRouter unchanged: the same message array and objects.

## The direct adapter

`AnthropicDirect` in [`src/anthropic.ts`](../src/anthropic.ts) uses the official `@anthropic-ai/sdk` against `https://api.anthropic.com`, always streamed, with SDK retries off (callers own retries, as with OpenRouter) and SDK logging and telemetry off. The SDK also reads `ANTHROPIC_CUSTOM_HEADERS` (one `Name: value` per line) from the process environment and adds those headers to every request; the gateway does not set it, and Compose does not pass it.

- **Request:** Chief's OpenAI-style messages become an Anthropic request: leading system messages become `system` blocks, tool results become `tool_result` blocks (an empty or whitespace-only result is sent without `content`, which the API allows), a mid-conversation system message that the API would reject becomes a `<system-reminder>` in a user turn, and consecutive same-role turns merge. It sends adaptive thinking, `output_config.effort` from Chief's per-message effort, `prefix_mismatch_behavior: "drop_block"` (beta `thinking-binding-controls-2026-08-01`, the only beta sent) and three explicit cache marks: the first leading system block, the owner's current message and the last block before the per-call state message (the last block when there is no state message). Chief opens every request with two system messages, the stable instructions and memories and then a per-turn summary ([context](../src/context.ts)); only the first is marked, so its cache entry survives a changed summary. Unlike `cacheHints` on OpenRouter, no top-level automatic mark is sent: it would land on the trailing state message, which changes every call, and pay a cache write on it each time (reported from live measurement by another session; not repeated here).
- **Tool-call ids:** the API accepts only `tool_use` ids matching `^[a-zA-Z0-9_-]+$` (measured: HTTP 400 for `functions.memory_set:0` and `call_abc|fc_68f0`, ids other providers return through OpenRouter that stay in history for about 20 turns). Such an id is mapped deterministically, the same way in `tool_use.id` and `tool_result.tool_use_id`, to its sanitized form plus a 16-character hash (at most 57 characters). Valid ids, including every id this API returns, are sent unchanged, and the ids returned to Chief are always the API's own.
- **Workspace:** with `ANTHROPIC_WORKSPACE_ID` set (`wrkspc_` followed by letters and digits, checked at startup), every request carries the `anthropic-workspace-id` header. A key that is not scoped to a workspace needs it; a workspace-scoped key does not. It is an identifier, not a secret, but lives in the private environment beside the key, not in `config/runtime.json` ([configuration](configuration.md)).
- **No server-side refusal fallback:** the request never sets `fallbacks` or the `server-side-fallback-2026-07-01` beta. That opt-in can serve a refused call on Opus 5 or Opus 4.8 at $5/$25 per million tokens, above the owner-approved $4/$20 ceilings, keeps routing later turns there, and this adapter would price those tokens at Opus 5.5's rates. `fallback` blocks stored by earlier test data in `reasoning_details` are ignored and never replayed.
- **Response:** an OpenRouter-shaped generation. Finish reasons map to OpenRouter's values (`refusal` to `content_filter`). Usage reports input as uncached + cache reads + cache writes, with `cached_tokens`, `cache_write_tokens`, `reasoning_tokens`, a `cost` computed from the policy's prices, `route: "anthropic-direct"` and `thinking_dropped` (how many earlier thinking blocks the API dropped).
- **Rejected thinking replay:** if a request that replayed stored thinking gets an HTTP 400 before any output (a corrupted block, or a key that now belongs to an account the blocks are not bound to), the adapter retries once on the direct route without the thinking blocks, keeping text and tool calls. The decision is structural (the status, the error being classified `rejected`, and whether thinking was replayed), never the provider's message; the beta-enrollment 400 is not retried. A successful retry marks usage `replay_dropped: true` (logged as `replayDropped`); a failed one carries `replayDropped` in its diagnostics and surfaces as `rejected`, so the router falls back.
- **Progress:** with streaming progress on (coding calls), every received chunk reports progress, including the `ping` events the API sends during a long thinking phase, which the SDK itself drops. Without that, the coding controller's 90-second idle timer could abort a call that is only thinking. A failing progress report on that path is ignored; progress on model output is reported as before. Pings never count as model output, so fallback safety is unchanged. (OpenRouter's stream reader, by contrast, does not count its SSE keepalive comments as progress.)
- **Refusal:** `stop_reason: "refusal"` fails the call as non-transient `refusal`, discarding partial output. It is not a provider fault, so it never falls back to OpenRouter.
- **Failed but billed:** a refusal, an incomplete (`length`) response under `requireComplete`, an empty response or a response without a stop reason fails after a complete response was received and billed. Its error diagnostics carry the normalized `usage` (tokens, cost, `route`), its spending charge is settled as for a success, `model.failed` log lines and failed spans carry its tokens and cost, and a coding job records it as a `model_usage` event marked `incomplete: true`.
- **Truncated tool call:** when a response stops at its output allowance (`max_tokens`) inside a tool call, the SDK's tolerant partial-JSON parse yields valid-looking but truncated input (measured: `{"key":"poem"}` with the long `value` silently dropped), which Chief's ordinary loop would run. The adapter instead returns that last call's raw streamed input text, as OpenRouter does; it fails `JSON.parse`, so the loop reports a tool error to the model and never runs it (text that happens to parse loses its last character). Earlier, complete calls in the same response keep their parsed input. Coding calls (`requireComplete`) reject a `length` response outright, as before.
- **Wire size:** complete-response (coding) calls bound the stream at the larger of 1.6 MB and 1 KB per allowed output token, as OpenRouter's stream reader does; beyond that the call fails as non-transient `malformed`.
- **Thinking continuity:** the API binds each thinking block to the exact request prefix it was generated after, and drops a replayed block whose prefix differs (`drop_block`, reported as `thinking_dropped`). Chief ends every request with a per-call state message ([context](../src/context.ts)) and rebuilds it on the next call, so the state message that preceded a block was gone on the next call: measured 11 November, 73 of 73 replayed in-turn blocks were dropped with `prefix_binding_mismatch`. The adapter now remembers, per returned thinking block, the exact state message its request ended with, and when that block is replayed it puts that state message back where it was, as a mid-conversation system message between the preceding user turn (the tool results, or the owner's message on a turn's first call) and the assistant turn, so the prefix is rebuilt byte for byte. A state message still in place is not duplicated; the memory is per process (keyed by a hash of the block's signature, at most 2,000 entries and 8 million characters, least recently used first, never logged), so after a restart blocks are dropped as before; a replay retried without thinking re-inserts nothing; and requests without a trailing state message (the coding loop, the learner) remember nothing. Measured result in [live verification](#live-verification-11-november-2026): no drops, with cache reads unchanged or better. A tool list that changes within a turn (a child's final call offers only its report tool) still drops every block on that call, because the tools are part of the prefix.

## Fallback and cooldowns

With `fallback: true` in the policy (the committed value), a direct failure classified **before any output** retries once on OpenRouter for the same slug. A failure after output has started, any other error, or a call the caller has aborted surfaces as the direct error, and the caller's normal retry rules apply. If `OPENROUTER_API_KEY` were empty there would be nothing to fall back to.

| Fault         | Classified from                                                                                      | Cooldown                                             | Applies to      |
| ------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------- |
| `auth`        | HTTP 401, `authentication_error`                                                                     | 600 s                                                | every model     |
| `permission`  | HTTP 403, `permission_error`                                                                         | 600 s                                                | that model only |
| `billing`     | HTTP 402, `billing_error`, `enforced_spend_limit_reached`                                            | 600 s                                                | every model     |
| `rate_limit`  | HTTP 429, `rate_limit_error`                                                                         | `retry-after`, clamped to 5–120 s (30 s without one) | every model     |
| `unavailable` | HTTP 5xx, `api_error`, `overloaded_error`, `timeout_error`, a transport failure with nothing emitted | none: each failing call falls back on its own        | that call       |
| `not_found`   | HTTP 404, `not_found_error`                                                                          | 600 s                                                | that model only |
| `rejected`    | HTTP 400, `invalid_request_error`                                                                    | none: each failing call falls back on its own        | that call       |
| `rejected`    | HTTP 400 with error code `organization_not_enrolled_in_beta` (it would fail every call)              | 600 s                                                | every model     |

A 413 (`request_too_large`) is deliberately unclassified: OpenRouter would send the same oversized request to the same model's limits, so it surfaces as the direct error. A beta value the account is not enabled for can also return a plain 400 without that error code; it is then an ordinary `rejected` fault, falling back on every call without a cooldown, and the `model.provider_fallback` lines show it. During a cooldown the direct pathway is skipped and calls go straight to OpenRouter. Cooldowns are per gateway process and reset on restart. A fallback generation's usage carries `fallback_from: "anthropic-direct"`, `fallback_reason` and, when a cooldown caused it, `fallback_cooldown: true`.

## Observability

- **Startup:** `model.routes` (info) logs `modelProvider`, `anthropicKey` (presence only, never the key) and the route of each role: `mainRoute`, `standardRoute`, `fastRoute`, `judgeRoute`, `mediaRoute`.
- **Failures:** direct `model.failed` lines carry `route`, `errorType` and `errorCode`, and, for a complete response refused after it was billed, `inputTokens`, `outputTokens`, `cachedTokens`, `cacheWriteTokens`, `reasoningTokens` and `costUsd` (numbers only). An aborted direct call logs the abort reason only, with no route: the adapter rethrows the caller's `signal.reason` unchanged, so the logging site cannot tell which pathway it was.
- **Fallback:** `model.provider_fallback` (warn) with `model`, `reason` (the fault), `cooldownS`, `httpStatus`, and the API's `errorType` (one of its fixed error types, such as `invalid_request_error`) and `errorCode` (a stable snake_case code such as `organization_not_enrolled_in_beta`) when present. Never provider message text. It is logged only when a direct attempt fails, not for calls skipped during a cooldown. Direct `model.failed` lines carry `errorType` and `errorCode` too.
- **Each call:** `model.completed` carries `route: "anthropic-direct"` on direct calls and `fallbackFrom: "anthropic-direct"` on a fallback; OpenRouter calls carry neither. Direct `model.failed` lines carry `route` too. `provider` is `anthropic` on the direct route. `thinking_dropped` and the fallback fields stay in the usage recorded in Postgres, not in the log line.
- **Traces:** `gen_ai.provider.name` is `anthropic` on direct spans (completed or failed) and `openrouter` otherwise, including fallbacks. A failed span carries token and cost attributes when its diagnostics carry usage (a refused, billed response).
- **Spending:** direct calls record their charge under `anthropic-main` (OpenRouter's is `openrouter-main`). See [cost controls](cost-controls.md#direct-anthropic-route).

```sh
AWS_PROFILE=chief-logs kite run logs:cloudwatch -- models --since 2h
AWS_PROFILE=chief-logs kite run logs:cloudwatch -- event --event model.provider_fallback --since 1d
```

The `models` query groups by provider, so direct calls appear under `anthropic`. The `event`, `run` and `errors` queries show `route`, `fallbackFrom`, `reason`, `cooldownS` and `errorType`; the `model.routes` fields still need a Logs Insights query that names them.

## Enabling it

Enabling needs two Compose lines in the gateway's environment, `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}` and then `ANTHROPIC_WORKSPACE_ID: ${ANTHROPIC_WORKSPACE_ID:-}`, plus the key (and, for an unscoped key, the workspace ID) in the private server `.env`. The automatic release refuses Compose changes, so this ships in its own PR through a reviewed operator procedure, modelled on the [Singapore keys rollout](singapore-open-data.md#key-rollout-procedure). It is deliberately not in the change that added the adapter.

### Key rollout procedure

`scripts/deploy-anthropic-key.py` is the one-time reviewed operator rollout, with offline tests in `scripts/test-deploy-anthropic-key.py`. Its `BASE` is deliberately unset: the PR that adds the Compose lines must set it to the live release SHA, read over SSH (`sudo cat /opt/hermes-companion/RELEASE`) just before that PR is reviewed, so the reviewer approves the exact baseline. The script refuses to run while `BASE` is unset, and the offline test fails once `compose.yaml` carries the lines and `BASE` is still unset. If another release lands first, set the new live SHA after review.

**What the script checks and does:**

1. **Before anything changes:**
   - `BASE` is set and the server's `RELEASE` matches it exactly;
   - the private `.env` sets `ANTHROPIC_API_KEY` to a non-empty value, using the last assignment as Compose does and counting `KEY=""` or a comment as empty, and `ANTHROPIC_WORKSPACE_ID`, which is optional, is either empty or well formed (`wrkspc_` followed by letters and digits, as the gateway requires). It checks presence and format only; no value is ever printed, logged or written;
   - the archive matches the exact requested commit and contains no unsafe entries (no `.env*` other than `.env.example`, `.git` or `RELEASE`);
   - `db/` is unchanged, the trusted release handler (`scripts/cloud-release.py`) is unchanged, and `compose.yaml` differs from the live file only by the two lines `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}` and `ANTHROPIC_WORKSPACE_ID: ${ANTHROPIC_WORKSPACE_ID:-}`, in that order, directly after the gateway's `OPENROUTER_API_KEY` line.
2. **Then:**
   - builds the candidate image first, and checks the baseline is healthy;
   - refuses, without cancelling anything, while a run, pending conversation input, active coding job or pending coding cleanup exists; rerun it when idle;
   - tags the previous image `:rollback`, stops the gateway, switches `compose.yaml` and the image, starts the gateway, checks health, then publishes the source and writes `RELEASE`.
3. **On failure:** restores the previous application, source and Compose file and checks health; if that fails too, it stops and asks for operator inspection. It neither cancels nor replays owner work, and leaves the database alone.

**Steps:**

1. Open the Compose PR: the two lines in `compose.yaml` and `BASE` set to the live release SHA. Run `python3 scripts/test-deploy-anthropic-key.py`. Get it independently reviewed.
2. Once the PR is approved and merged, add the key to `/opt/hermes-companion/.env` (root, mode 600) through the pinned Lightsail operator connection ([lightsail.md](lightsail.md)). Pipe the value from a local private file over SSH, so it never appears in a command line, a log or the chat. If the key is not scoped to a workspace, add `ANTHROPIC_WORKSPACE_ID=wrkspc_…` the same way.
3. Create the `git archive` of the exact merge commit, and transfer it and the reviewed script.
4. Run:

   ```sh
   sudo python3 /tmp/deploy-anthropic-key.py /tmp/anthropic-release.tar FULL_REVIEWED_MAIN_SHA
   ```

   On success it prints `{"deployed": "<sha>", "healthy": true, "anthropicKey": "configured"}`.

5. Verify the exact `RELEASE` and health. Then check that the key reached the gateway, printing only the word "present":

   ```sh
   sudo docker compose --project-directory /opt/hermes-companion -p hermes-companion exec -T gateway sh -c 'test -n "$ANTHROPIC_API_KEY" && echo present'
   ```

6. Dispatch the normal release for the same commit, which should be a no-op redeploy. That confirms later automatic releases accept the installed Compose file.
7. Run the [first live run](#first-live-run) checks.

**Until the script runs:** a merged `compose.yaml` change makes the automatic release refuse every later merge. Run it immediately after the merge.

**Rollback:** the script's own failure path restores the previous state. To turn the direct route off afterwards, see [switching back](#switching-back); the Compose lines can stay, since an empty key keeps every call on OpenRouter.

Never paste the key into a chat, a PR, a command line or a log. It belongs only in `/opt/hermes-companion/.env` on the host, as for every other secret ([configuration](configuration.md)).

### First live run

None of this has been verified on the enabled production gateway; the [live verification](#live-verification-11-november-2026) ran the same code locally against the real API. After enabling, confirm:

1. **Startup:** `model.routes` shows `anthropicKey: true` and `mainRoute`/`standardRoute: anthropic-direct`, and `fastRoute`/`judgeRoute: openrouter`.
2. **Auth and effective model:** a small owner turn logs `model.completed` with `route: anthropic-direct`, `provider: anthropic` and model `anthropic/claude-opus-5.5`, and no `model.provider_fallback`.
3. **Caching:** `cachedTokens` and `cacheWriteTokens` across the calls of one turn, compared with recent OpenRouter turns ([deployment](deployment.md#changing-the-production-model-through-a-release)).
4. **Thinking:** `thinking_dropped` in the recorded usage should be 0 on later calls of a turn; expect drops only on the first calls after a gateway restart and on a child's final, report-only call.
5. **Beta and workspace:** that the API accepts the thinking-binding beta on this account and, for an unscoped key, the workspace header. Either failing shows as `model.provider_fallback` with `reason: rejected` on every call (with `errorCode: organization_not_enrolled_in_beta` and a 600 s cooldown in the enrollment case).
6. **Coding:** one Pi coding job whose reviewer runs direct, through to a completed review.
7. **Rate limits:** a new Console account starts on a low tier. Watch for `rate_limit` fallbacks during busy turns and coding reviews.
8. **Fallback:** that a fault actually falls back, for example by observing the first naturally occurring one, and that `model.provider_fallback` and `fallbackFrom` appear as described.

## Switching back

- **Through a release (preferred):** set `"MODEL_PROVIDER": "openrouter"` in `config/runtime.json` in an ordinary reviewed PR. Compose does not pass `MODEL_PROVIDER`, so the file is authoritative and the next release applies it. A `MODEL_PROVIDER` line in the server `.env` has no effect for the same reason.
- **Without a release:** remove `ANTHROPIC_API_KEY` from the server `.env` and recreate the gateway through the operator connection.
- **One model only:** remove its entry from `providers.anthropic.models` in a reviewed PR.

Each leaves the OpenRouter pathway exactly as it was. Conversations that used the direct route continue on OpenRouter with the direct thinking blocks removed.

## Adding another Anthropic model

1. **Policy entry:** add the OpenRouter slug under `providers.anthropic.models` in `config/model-policy.json`, with the native `id` (`claude-…`) and the first-party list prices in $ per million tokens: `input`, `output`, `cacheRead`, `cacheWrite` (5-minute writes). Write the prices out from Anthropic's price list; they are not derived from the slug.
2. **Adapter profile:** add the native ID to `PROFILES` in `src/anthropic.ts`. The adapter refuses unlisted models, because models differ in thinking, effort and system-message support. The request always sends adaptive thinking, `output_config.effort` and the thinking-binding beta, so a model without those needs adapter changes, not just a profile line. Server-side refusal fallbacks stay off for every model (above).
3. **Ceilings:** a model priced above `priceCeilings` is valid but stays on OpenRouter. Do not raise the ceilings without an explicit owner request.
4. **Checks:** `tests/model-policy.test.ts` builds an adapter for every mapped entry and asserts its prices fit the ceilings, so a missing profile or an over-ceiling entry fails CI. Release through the normal reviewed path; this is an application release, with no Compose change once the key is live.

## Limitations

- Thinking survives between calls of a turn only within one gateway process (above), and Pi's OpenAI-completions client keeps only OpenAI-style reasoning entries (`reasoning.text`, `reasoning.summary`, `reasoning.encrypted`), so it drops the direct route's `anthropic.thinking` entries between tool turns. The Python squad copies `reasoning_details` back unchanged.
- Cooldowns are in memory and per process.
- An ordinary rejected request (400) has no cooldown, so a request shape the API always rejects costs one failed direct request on every call before its OpenRouter fallback; the warn lines make that visible.
- Per-call `cacheKey` and `sessionId` have no native equivalent and are not sent.
- The pre-call spending estimate of a direct call that then falls back stays unsettled, beside the OpenRouter charge that settles.
- Not measured: latency, cache hit rates and cost against OpenRouter on the same workload (no OpenRouter key was available for the live runs).

## Live verification (11 November 2026)

Measured on 11 November 2026 with a temporary Claude Console key, running the code locally (the adapter and Chief's real runtime on PGlite, and Pi coding jobs through the real coding controller). Not production. What was faked: there was no OpenRouter key, so the fallback target was a stand-in (an Opus call through a separate adapter instance returning an OpenRouter-shaped result); there was no Docker daemon, so the sandbox image and the native process guard were not used; Telegram, Gmail, calendar, parcels and the other integrations were fakes; the `fast` tier and the judge (OpenRouter models) were stand-ins.

- **Adapter scenarios:** text and streaming; a tool loop with parallel calls; images; caching (95% of input read from cache on a stable 10.5k-token prefix); abort; a bad key giving HTTP 401 and the `auth` fallback; routing through `ModelRouter`.
- **Chief's real loop:** all 158 tool schemas accepted in one live call of 111 KB (48.9k tokens); multi-turn conversations; agents on the `standard` tier; an approval card; a learner tick; an image through the media path; cancellation; a conversation moving direct, then to the fallback, then direct again, with history replayed each way. Across 68 calls, 76% of prompt tokens were read from cache.
- **Pi coding on head `da1eb07`,** with the job's roles on Opus 5.5 direct: plan, code and review jobs reached `pr_ready` with an APPROVE at about $0.25 each; a deliberately flawed candidate was rejected; a 690-second thinking call survived thanks to progress on the 30-second pings (before that fix the idle timeout fired at 90.5 s); a compaction call was accepted; injected 429 and 503 faults recovered; cancellation took 1.4 s; the worker's environment never contained the key; Opus 5 was refused by the price filter.
- **Account:** the rate-limit headers showed 4,000 requests, 2M input tokens and 400k output tokens per minute. An unscoped `sk-ant-usr-` key needed the `anthropic-workspace-id` header (HTTP 400 without, 200 with).
- **Fixes from these runs, verified live after the change:** a truncated tool call at a 120-token allowance came back as raw text that does not parse (`{"key": "poem"`), where the previous head returned `{"key":"poem"}`, which parses; a history with the ids `functions.memory_set:0` and `call_abc|fc_68f0` got HTTP 400 on the previous head and HTTP 200 with the mapped ids. Thinking continuity, on a Chief-shaped tool loop (two leading system messages, a state message rebuilt every call, parallel tool calls, 6 calls at high effort): the previous head dropped 10 of 10 and 8 of 8 replayed blocks; with the fix, 0 of 9, 0 of 9 and 0 of 2 were dropped, at 97% cache reads either way and $0.060–0.068 per loop against $0.077–0.134. On Chief's real runtime (the `tools` scenario: email and parcels agents in parallel, a calendar approval and a stocks agent, 21–22 direct calls), the previous head dropped 16 of 16 replayed blocks on its 22 direct calls; with the fix 0 of 6 (cold cache) and 0 of 7 (warm) were dropped, with 85.8% of prompt tokens read from cache against 84.7% and $0.38 against $0.45 for the direct calls. The cold run read nothing on each agent's first call because the 5-minute cache had expired, unrelated to the change; its later calls read 85.5%.
- **Still unverified:** the real OpenRouter fallback; live 429, 5xx, 402 and 403 responses (the coding faults above were injected); the beta-not-enrolled 400; and the production role mix and workload.

## Owner decisions pending

- **Output allowances.** Chief's default allowance of 8,000 output tokens includes thinking: in the live runs it failed 3 of 6 deliberately hard prompts at medium and high effort as an "empty response" (all tokens spent thinking). The coding coder's 128k allowance let one trivial call spend 91k output tokens ($1.82); the reviewer is capped at 16k. Changing either is an owner decision; nothing is changed here.
- **Two cache-cost behaviours in the runtime, found during the live run and deferred** (they predate the direct route and affect OpenRouter too): a host notice appended to the turn as a user message invalidates the cache from that point; and a child's final call, which offers only its report tool, changes the tool list and so misses the cache (and drops every thinking block) on that call.
