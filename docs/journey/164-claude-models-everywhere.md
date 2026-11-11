# 164 — Which of Chief's models can move to Claude?

Work date: 11 November 2026. Written: 11 November 2026.
Status: tested offline, and the request shape verified live for Sonnet 5.5 and Haiku 5.5; not merged. Revised the same day after the owner's second set of decisions (below). PR 442's rollout ran first.

## User-visible problem and preceding iteration

[Journal 161](161-enabling-direct-anthropic.md) prepared the switch to the direct Anthropic route for Opus 5.5: Chief's main model, the `standard` agent tier (which the learner uses) and every Pi coding role. The owner then said Chief now has $200 a month of Claude credits, more than the OpenRouter budget, and asked for a full scan of Chief so every model moves to Claude: Opus for Chief, coding and review, Sonnet where a cheaper model is used, Haiku where Gemini Flash is used. Jev stays on OpenRouter.

Later the same day the owner decided:

- The nightly judge uses Opus 5.5, for the quality of its judgement, not Sonnet 5.5.
- A fallback to OpenRouter must not be silent. Either fail and say so, or fall back and tell the owner.
- Docs are a dated log, not the source of truth: changes are added as dated notes, not rewritten.

## Evidence

- **Code scan (11 November 2026, branch base `f549fca`):** model choices live in `config/model-policy.json` (main, judge, agent tiers, direct-route map), `config/coding-pi.json` and `config/coding.json` (coding roles), `config/runtime.json` with Compose defaults (`AGENT_MODEL`, `SEARCH_MODEL`, `MEDIA_MODEL`), `config/decisions.json`, `config/tool-picker.json` and `config/reasoning-effort.json` (Jev), and constants in `src/mail-recall.ts` (embeddings) and `src/mail-recall-eval.ts` (an operator eval).
- **Before this change:** main Opus 5.5 (policy, which wins over `AGENT_MODEL`); `standard` tier Opus 5.5; `fast` tier and default agent tier `google/gemini-3.8-flash`; judge `openai/gpt-6.1-sol`; search helper `google/gemini-3.8-flash`; Pi coding Opus 5.5 after PR 442; the Python squad (`config/coding.json`) DeepSeek, used by no new job; embeddings `openai/text-embedding-3-small`; speech OpenAI Whisper and TTS; Jev for the pickers and shadow decisions.
- **Prices (OpenRouter catalogue, 11 November 2026, $ per million tokens):** Sonnet 5.5 $2 / $10, cache read $0.10, write $2.50; Haiku 5.5 $0.10 / $0.50, cache read $0.01, write $0.125. Anthropic lists Haiku 5.5 at those rates for prompts up to 100,000 tokens and $0.50 / $2.50 beyond.
- **Code:** `AnthropicDirect` accepted only `claude-opus-5-5`; any other native model threw "Unsupported Anthropic model".

## Diagnosis and alternatives

Changed:

- `config/model-policy.json`: the `fast` tier (also the default agent tier) becomes `anthropic/claude-haiku-5.5`; `judge` becomes `anthropic/claude-opus-5.5` (the first version chose Sonnet 5.5; the owner then chose Opus); Sonnet 5.5 and Haiku 5.5 join `providers.anthropic.models` with their list prices, both inside the $4 / $20 ceilings, so they go direct once the key is live and fall back to OpenRouter otherwise. Opus 5.5 stays the main model and the `standard` tier.
- `src/anthropic.ts`: the adapter accepts `claude-sonnet-5-5` and `claude-haiku-5-5` as well as Opus 5.5. Anthropic's documentation gives all three adaptive thinking, `output_config.effort` from low to max, no prefill, mid-conversation system messages, and preserved thinking with the history check, which is what the adapter's request relies on. The adapter never forces a tool choice; Haiku 5.5 would accept one but skip thinking.
- `src/mail-recall-eval.ts`: the operator eval writes its questions with Haiku 5.5, sends no temperature (Claude 5.5 models refuse any but the default) and accepts JSON inside a code fence.
- `src/model-router.ts`: a rate limit now cools only the model that hit it. With one mapped model the shared cooldown made no difference; with three, a 429 on a Haiku agent call would have sent Chief's Opus calls to OpenRouter, though Anthropic limits each model separately. Key, billing and beta-enrollment faults still apply to every model.

Left as they are:

- **Jev** (owner decision).
- **Embeddings and speech:** Anthropic offers neither.
- **The search helper (`SEARCH_MODEL`) and `AGENT_MODEL`:** production's Compose file passes both with its own defaults, which win over `config/runtime.json` ([configuration](../configuration.md#precedence-during-the-move)), so changing the file would not change production. `AGENT_MODEL` is unused while the policy names a main model. Moving the search helper to Haiku needs a Compose change and an operator rollout; recorded as a follow-up.
- **The Python squad (`config/coding.json`):** no new job uses it, and issue #443 removes it.
- **agentwatch's `answer_ok` judge:** a separate service with its own configuration.

The judge was a different model family on purpose, so it would not grade work written by the same family. It is now the same model as the main model and the learner, so that separation is gone; this is the owner's choice, and the judge's verdicts were never ground truth. Sonnet 5.5 stays mapped for direct use, though no role uses it today.

**Fallbacks are reported.** The owner did not want a silent switch to OpenRouter. Two ways were possible: fail the call (`"fallback": false`, already supported, so Chief would answer with an error), or keep the fallback and tell the owner. The second keeps Chief answering during a short outage or a rate limit, so it is the default:

- `FallbackAdapter` reports each direct failure that falls back (`onFallback`), with the model, the fault, the cooldown and the HTTP status; never provider text. Calls skipped during a cooldown are not reported again.
- `FallbackAlerts` (`src/model-router.ts`), wired in `src/main.ts` to the owner's Telegram, sends at most one message per fault and model an hour, saying what failed, that Chief is retrying through OpenRouter, when Chief tries Claude directly again, how many failed direct attempts it held back (calls skipped during a cooldown are not counted), and how to stop falling back. A failing send never changes the call.
- A gateway that starts meaning to go direct (`MODEL_PROVIDER=anthropic`, main model mapped) but cannot (no key, or a price above the ceilings) tells the owner once per start, since every Claude call would otherwise go to OpenRouter unannounced.
- `"fallback": false` under `providers.anthropic` makes every direct failure an error instead.

Rejected: a notice on every fallback (a rate limit or outage could send dozens), and a note in Chief's reply (the reply would change with the provider, and agents' replies do not reach the owner).

**Docs.** `AGENTS.md` now says docs are a dated log and the code and `config/` are the source of truth. This change follows it: the design docs get dated update notes instead of rewritten paragraphs.

Rejected: Sonnet for the `standard` tier. The owner asked for Opus wherever quality matters, and the learner uses that tier.

## Verification and outcome

- **Tested:** `tests/model-policy.test.ts` (Sonnet and Haiku map to their native IDs and prices; every Claude model the policy names is mapped; the judge is Opus 5.5), `tests/model-router.test.ts` (with the bundled policy and a key, the main, judge and every tier route direct, while Jev, embeddings and other vendors stay on OpenRouter; the adapter accepts every mapped native model), `tests/agents.test.ts` (the default tier is Haiku 5.5).
- **Measured (production gateway, 11 November 2026, after PR 442's rollout):** the adapter's request shape (adaptive thinking with `drop_block`, the thinking-binding beta, low effort, a cached system block) sent with the gateway's own key returned `end_turn` and `pong` for Sonnet 5.5 (1.3 s), Haiku 5.5 (0.9 s) and Opus 5.5 (1.2 s). So the account accepts the beta for all three.
- **Not verified:** a Sonnet 5.5 or Haiku 5.5 call through this adapter in production, since this change is not deployed. If the direct API ever rejects one, each call falls back to OpenRouter and the owner is told.
- **Tested:** `tests/model-router.test.ts`: a direct failure that falls back is reported once, a call skipped in the cooldown is not, a success is not, and a notifier that throws leaves the fallback answer intact; the alerts send one message per fault an hour, name the fault, model, HTTP status and retry time, count what they held back, and swallow a failing send.
- **Not verified:** Haiku 5.5 on agent work that Gemini 3.8 Flash did, and a Telegram fallback message from production.
- **Not verified:** refusals. Opus 5.5 and Haiku 5.5 run refusal classifiers the judge did not have on GPT-6.1 Sol, and a refusal on the direct route never falls back. A judge batch that is refused every night fails the run and is read again, holding that batch.
- **Independent review** (Claude Opus 5.5, two rounds) found nothing blocking. Fixed from the second: the alert said Chief had answered before the fallback ran, its throttle hid one model's fault behind another's, and a start without the direct route was silent. Accepted as known: a beta-enrollment refusal still cools every model. Fixed from the first: the shared rate-limit cooldown, the eval's temperature and JSON handling, and docs that still described the fast tier as Gemini and the judge as GPT-6.1 Sol on OpenRouter.
- **Known gap:** the adapter prices Haiku calls at the under-100,000-token rate, so a longer prompt's recorded cost is understated. Spending figures are accounting, never caps.

## Follow-up and next iteration

After PR 442's rollout and this release: check `model.routes` for `fastRoute` and `judgeRoute` `anthropic-direct`, the first direct Haiku calls and the Opus judge run (`model.completed` with `route: anthropic-direct`, no `model.provider_fallback`), the first night's judge run, and agent quality on the fast tier. Move the search helper with the next Compose change.
