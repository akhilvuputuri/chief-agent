# Model providers

Chief has two model pathways: OpenRouter, which every call used until November 2026, and the Anthropic Messages API called directly with a Claude Console key. Both stay supported. Which one serves a call is decided per model when the gateway starts, from reviewed configuration and the presence of a key. See [journal 160](journey/160-direct-anthropic-provider.md) for why and what is still unverified.

**State (11 November 2026):** built and tested with mocked requests on branch `claude/gifted-mccarthy-gond93`. Not released and not enabled: production has no `ANTHROPIC_API_KEY`, and Compose does not pass one to the gateway yet, so every call still goes through OpenRouter. No live Anthropic request has been made.

## How a model is routed

Every model the gateway builds goes through `ModelRouter.modelFor(slug)` in [`src/model-router.ts`](../src/model-router.ts): the main model, the media model, agents and research specialists, the nightly learner and judge, and the coding controller's model factory. The coding factory is the whole coding pathway: Pi and the Python squad sandboxes never hold a provider key and send every model call to the host proxy, which uses that factory.

A slug goes **direct** only when all of these hold:

1. `MODEL_PROVIDER` is `anthropic`. The code default and `config/runtime.json` are both `anthropic`, so this is inert until a key arrives.
2. `ANTHROPIC_API_KEY` is set in the gateway's environment.
3. The slug is listed in `config/model-policy.json` under `providers.anthropic.models`.
4. Its listed input and output prices are within the effective price ceilings (`priceCeilings` in the same file, $4/$20 today).

Otherwise the slug uses the OpenRouter adapter exactly as before, with the same `max_price` ceilings. Today only `anthropic/claude-opus-5.5` is mapped. With a key it would serve the main model, the `standard` agent tier (which the learner uses) and the coding reviewer (`reviewerModel` in `config/coding.json` and `config/coding-pi.json`). The `fast` tier (Gemini), the judge (GPT-6.1 Sol) and the DeepSeek coders stay on OpenRouter.

These always stay on OpenRouter, whatever the setting: other vendors' models, web search and the search helper, embeddings (recall and mail recall), the Jev pickers and shadow decisions, the coding model catalogue check, and agentwatch's judges. `OPENROUTER_API_KEY` therefore remains required.

The adapter keeps the OpenRouter slug as the model name, so journals, settings, coding jobs and logs see the same `model` either way. Conversations can move between pathways: thinking blocks produced on the direct route are stored in `reasoning_details` under their own tag (`anthropic.thinking`, format `anthropic-direct-v1`), replayed only on the direct route, and removed before any request to OpenRouter.

## The direct adapter

`AnthropicDirect` in [`src/anthropic.ts`](../src/anthropic.ts) uses the official `@anthropic-ai/sdk` against `https://api.anthropic.com`, always streamed, with SDK retries off (callers own retries, as with OpenRouter) and SDK logging and telemetry off.

- **Request:** Chief's OpenAI-style messages become an Anthropic request: leading system messages become `system`, tool results become `tool_result` blocks, a mid-conversation system message that the API would reject becomes a `<system-reminder>` in a user turn, and consecutive same-role turns merge. It sends adaptive thinking, `output_config.effort` from Chief's per-message effort, the four cache marks Chief already uses for Anthropic on OpenRouter (top-level, opening system prompt, owner's current message, last block before the per-call state message), and `prefix_mismatch_behavior: "drop_block"`. Server-side refusal fallbacks are opted in for models whose profile allows it (Opus 5.5 does).
- **Response:** an OpenRouter-shaped generation. Finish reasons map to OpenRouter's values (`refusal` to `content_filter`). Usage reports input as uncached + cache reads + cache writes, with `cached_tokens`, `cache_write_tokens`, `reasoning_tokens`, a `cost` computed from the policy's prices, `route: "anthropic-direct"`, `thinking_dropped` (how many earlier thinking blocks the API dropped) and, after a server-side fallback, `served_model`.
- **Refusal:** a refusal from the whole fallback chain fails the call as non-transient `refusal`, discarding partial output.
- **Thinking continuity (known limitation):** Chief rebuilds its message array on every call, so the API usually finds that earlier thinking no longer matches and drops it (`drop_block`) instead of answering 400. That costs cache and reasoning continuity, not errors. An append-only message shape is the real fix and is deferred.

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

During a cooldown the direct pathway is skipped and calls go straight to OpenRouter. Cooldowns are per gateway process and reset on restart. A fallback generation's usage carries `fallback_from: "anthropic-direct"`, `fallback_reason` and, when a cooldown caused it, `fallback_cooldown: true`.

## Observability

- **Startup:** `model.routes` (info) logs `modelProvider`, `anthropicKey` (presence only, never the key) and the route of each role: `mainRoute`, `standardRoute`, `fastRoute`, `judgeRoute`, `mediaRoute`.
- **Fallback:** `model.provider_fallback` (warn) with `model`, `reason` (the fault) and `cooldownS`. It is logged only when a direct attempt fails, not for calls skipped during a cooldown.
- **Each call:** `model.completed` carries `route: "anthropic-direct"` on direct calls and `fallbackFrom: "anthropic-direct"` on a fallback; OpenRouter calls carry neither. Direct `model.failed` lines carry `route` too. `provider` is `anthropic` on the direct route. `thinking_dropped`, `served_model` and the fallback fields stay in the usage recorded in Postgres, not in the log line.
- **Traces:** `gen_ai.provider.name` is `anthropic` on direct spans (completed or failed) and `openrouter` otherwise, including fallbacks.
- **Spending:** direct calls record their charge under `anthropic-main` (OpenRouter's is `openrouter-main`). See [cost controls](cost-controls.md#direct-anthropic-route).

```sh
AWS_PROFILE=chief-logs kite run logs:cloudwatch -- models --since 2h
AWS_PROFILE=chief-logs kite run logs:cloudwatch -- event --event model.provider_fallback --since 1d
```

The `models` query groups by provider, so direct calls appear under `anthropic`. The saved queries' field lists do not include the new fields (`route`, `fallbackFrom`, `reason`, `cooldownS` and the `model.routes` fields) yet, so read those with a Logs Insights query that names them.

## Enabling it

Enabling needs one Compose line, `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}` in the gateway's environment, plus the key in the private server `.env`. The automatic release refuses Compose changes, so this ships in its own PR through a reviewed operator procedure, modelled on the [Singapore keys rollout](singapore-open-data.md#key-rollout-procedure). It is deliberately not in the change that added the adapter.

### Key rollout procedure

`scripts/deploy-anthropic-key.py` is the one-time reviewed operator rollout, with offline tests in `scripts/test-deploy-anthropic-key.py`. Its `BASE` is deliberately unset: the PR that adds the Compose line must set it to the live release SHA, read over SSH (`sudo cat /opt/hermes-companion/RELEASE`) just before that PR is reviewed, so the reviewer approves the exact baseline. The script refuses to run while `BASE` is unset, and the offline test fails once `compose.yaml` carries the line and `BASE` is still unset. If another release lands first, set the new live SHA after review.

**What the script checks and does:**

1. **Before anything changes:**
   - `BASE` is set and the server's `RELEASE` matches it exactly;
   - the private `.env` sets `ANTHROPIC_API_KEY` to a non-empty value, using the last assignment as Compose does and counting `KEY=""` or a comment as empty. It checks presence only; the value is never printed, logged or written;
   - the archive matches the exact requested commit and contains no unsafe entries (no `.env*` other than `.env.example`, `.git` or `RELEASE`);
   - `db/` is unchanged, the trusted release handler (`scripts/cloud-release.py`) is unchanged, and `compose.yaml` differs from the live file only by `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}` directly after the gateway's `OPENROUTER_API_KEY` line.
2. **Then:**
   - builds the candidate image first, and checks the baseline is healthy;
   - refuses, without cancelling anything, while a run, pending conversation input, active coding job or pending coding cleanup exists; rerun it when idle;
   - tags the previous image `:rollback`, stops the gateway, switches `compose.yaml` and the image, starts the gateway, checks health, then publishes the source and writes `RELEASE`.
3. **On failure:** restores the previous application, source and Compose file and checks health; if that fails too, it stops and asks for operator inspection. It neither cancels nor replays owner work, and leaves the database alone.

**Steps:**

1. Open the Compose PR: the one line in `compose.yaml` and `BASE` set to the live release SHA. Run `python3 scripts/test-deploy-anthropic-key.py`. Get it independently reviewed.
2. Once the PR is approved and merged, add the key to `/opt/hermes-companion/.env` (root, mode 600) through the pinned Lightsail operator connection ([lightsail.md](lightsail.md)). Pipe the value from a local private file over SSH, so it never appears in a command line, a log or the chat.
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

**Rollback:** the script's own failure path restores the previous state. To turn the direct route off afterwards, see [switching back](#switching-back); the Compose line can stay, since an empty key keeps every call on OpenRouter.

Never paste the key into a chat, a PR, a command line or a log. It belongs only in `/opt/hermes-companion/.env` on the host, as for every other secret ([configuration](configuration.md)).

### First live run

Nothing below has been observed; all tests are mocked. After enabling, confirm:

1. **Startup:** `model.routes` shows `anthropicKey: true` and `mainRoute`/`standardRoute: anthropic-direct`, and `fastRoute`/`judgeRoute: openrouter`.
2. **Auth and effective model:** a small owner turn logs `model.completed` with `route: anthropic-direct`, `provider: anthropic` and model `anthropic/claude-opus-5.5`, and no `model.provider_fallback`.
3. **Caching:** `cachedTokens` and `cacheWriteTokens` across the calls of one turn, compared with recent OpenRouter turns ([deployment](deployment.md#changing-the-production-model-through-a-release)).
4. **Thinking:** how often `thinking_dropped` is non-zero in the recorded usage. Mostly non-zero is expected with today's message shape.
5. **Refusal fallback:** that the API accepts the server-side fallback beta and opt-in on this account (a 400 here would fail every direct call without falling back).
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
2. **Adapter profile:** add the native ID to `PROFILES` in `src/anthropic.ts`. The adapter refuses unlisted models, because models differ in thinking, effort, system-message and fallback support. The request always sends adaptive thinking, `output_config.effort` and the thinking-binding beta, so a model without those needs adapter changes, not just a profile line. Set `fallbacks: "default"` only if the model supports server-side refusal fallbacks.
3. **Ceilings:** a model priced above `priceCeilings` is valid but stays on OpenRouter. Do not raise the ceilings without an explicit owner request.
4. **Checks:** `tests/model-policy.test.ts` builds an adapter for every mapped entry and asserts its prices fit the ceilings, so a missing profile or an over-ceiling entry fails CI. Release through the normal reviewed path; this is an application release, with no Compose change once the key is live.

## Limitations

- Thinking is mostly dropped between calls (above), and Pi's OpenAI-completions client keeps only OpenAI-style reasoning entries (`reasoning.text`, `reasoning.summary`, `reasoning.encrypted`), so it drops the direct route's `anthropic.thinking` entries between tool turns. The Python squad copies `reasoning_details` back unchanged.
- Cooldowns are in memory and per process.
- Per-call `cacheKey` and `sessionId` have no native equivalent and are not sent.
- The pre-call spending estimate of a direct call that then falls back stays unsettled, beside the OpenRouter charge that settles.
- Not measured: latency, cache hit rates and cost against OpenRouter on the same workload.
