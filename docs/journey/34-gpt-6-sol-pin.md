# 34 — Pinning GPT-6 Sol as the main model

Work date: 2026-09-23. Written: 2026-09-23.
Status: proposed. The policy pin is on a review branch; it is not merged or deployed, and no request has yet run on GPT-6 Sol in production.

## User-visible problem and preceding iteration

The owner asked to upgrade the main Chief model to GPT-6 Sol. [Journal 32](32-repo-controlled-model.md) released the bundled model policy in v0.3.23 with `main: null`, so production still used the environment-derived `openai/gpt-5.6-sol`. That entry left the first real pin to a separate reviewed change; this is that change.

## Evidence

- **Observed in source:** `config/model-policy.json` was `main: null`; `resolveMainModel` gives a non-null pin precedence over `AGENT_MODEL` at gateway startup. The existing policy tests already use `openai/gpt-6-sol` as their example pin.
- **Reported by public listings, 23 September:** web search results for the OpenRouter catalogue list `openai/gpt-6-sol` at $2/M input and $10/M output (cache read $0.20/M), with a 1,050,000-token context window. Those prices equal, and do not exceed, the configured provider ceilings.
- **Not verified:** the cloud session's network policy blocked `openrouter.ai`, so the endpoint list, per-provider prices and support for `tools` plus `reasoning` under `require_parameters` were not read from the API. An endpoint priced above the ceilings or lacking a required parameter is filtered out; if none remains, requests fail with the explicit no-eligible-provider error rather than falling back.

## Diagnosis and alternatives

Following the [deployment runbook](../deployment.md#changing-the-production-model-through-a-release), only the policy file changes. TypeScript defaults, `.env.example`, Compose and the server `.env` stay at 5.6: they no longer control the effective model once the pin is set, and a Compose edit would block the ordinary release. Price ceilings, medium reasoning, allocations and `SEARCH_MODEL` are unchanged. Every `CustomAgent` run without a plugin model override moves to GPT-6 Sol: foreground conversations, background jobs and routines, the public-research specialist and its job-alignment profile (`plugins/registry.json` sets no `model`), and the media specialist (production Compose does not pass `MEDIA_MODEL`). Only the `SEARCH_MODEL` search helper and speech providers stay separate.

## Implementation and review

- `config/model-policy.json`: `main` set to `openai/gpt-6-sol`.
- Independent review, 23 September: a Claude Opus 5.5 reviewer subagent (GPT-6 Astra was unavailable in this session) requested changes on `60c7370`. It found no code defects and two low-severity disclosure gaps: research and other specialist runs also move to the new model, and the smoke/eval scripts stay pinned to 5.6. Both are addressed above; re-review of the updated head is pending.
- Merge and release are pending.

## Verification and outcome

Pending. Required after release: the exact release receipt, then a small owner-initiated Telegram request whose `model.started`/`model.completed` records name `openai/gpt-6-sol` and report an eligible provider. Startup health alone does not prove OpenRouter accepted the model. `npm run smoke:runtime` (`scripts/smoke-custom.ts`) builds the adapter with its 5.6 default, and `evals/run.ts` labels runs as 5.6; neither reads the policy, so neither is evidence for this switch. If that check fails, revert the pin by PR and release normally; do not override it through the server `.env`.

## Follow-up and next iteration

Answer quality, latency and cost on GPT-6 Sol are unmeasured. Once the pin is verified, update the current model statements in README, HANDOVER and current work.
