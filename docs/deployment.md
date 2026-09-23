# Deployment

Use the existing Singapore DigitalOcean server. The source lives at `/opt/hermes-companion`; private root-readable `.env` supplies existing credentials. Production Compose runs only the Node gateway and Postgres, plus a one-shot schema job.

The Hermes-to-custom migration was a historical cutover; do not rerun its reset or migration procedure to change a model. Current releases follow [cloud development](cloud-development.md), with reviewed operator procedures for Compose and database changes.

The current checked-in defaults are `AGENT_MODEL=openai/gpt-5.6-sol`, medium reasoning and provider price ceilings of $2/M input and $10/M output. `SEARCH_MODEL` is the separate Gemini research helper. Existing speech and Google credentials remain unchanged. `HERMES_URL`, `HERMES_MODEL`, and `INTERNAL_API_TOKEN` are not used by the custom production path.

## Changing the production model through a release

[`config/model-policy.json`](../config/model-policy.json) is the versioned, non-secret choice for the main OpenRouter model. It is bundled into the gateway image. The checked-in `main: null` deliberately preserves today's behavior: the gateway uses `AGENT_MODEL` injected by Compose from the private server `.env`, or Compose's 5.6 fallback. Once a reviewed PR sets `main` to an OpenRouter model ID, the bundled choice takes precedence over that injected value. Changing only a TypeScript default, `.env.example`, or the server `.env` then cannot override the bundled choice. No Compose or database change is needed to select a model through the repo.

For future model changes, a coding agent should:

1. Verify the exact OpenRouter model ID, tool/reasoning support and provider prices. The runtime requests medium reasoning, price-first routing and the existing $2/M input / $10/M output provider ceilings; it fails explicitly when no provider meets those filters. Do not loosen those ceilings silently.
2. Edit **only** `config/model-policy.json` to set `main` to that ID. `null` reverts to the existing `AGENT_MODEL` environment behavior. No API keys or account data belong in this file. Run the normal checks and open a PR for independent review.
3. Merge the reviewed PR. The ordinary main-branch checks and release rebuild the gateway image, wait for idle work, recreate the gateway, check startup health and preserve a rollback image. A PR branch or passing CI is not a production model change; verify the exact release receipt.
4. Make a small owner-initiated Telegram request and confirm its `model.started`/`model.completed` record names the new model and reports an eligible provider outcome. Startup health alone cannot prove OpenRouter accepted the model. If that check fails, revert the policy change by PR and follow the normal release path; do not change the server `.env` to override a pinned policy.

The release SHA plus the policy file at that SHA identifies the intended model. The first `null` policy is intentionally different: its effective model still depends on the private server environment, which can be checked only through authorized runtime evidence. The normal release pipeline refuses Compose/database changes, but a policy-file edit is an ordinary application release. Cloud coding tasks therefore need repository and release permissions, not server SSH, to make a reviewed model change. There is no Telegram model-switch command or hot reload. Record the exact deployed SHA, policy value and smoke result without private prompts or credentials.

`SEARCH_MODEL` is a separate research helper. The media specialist falls back to the main model when `MEDIA_MODEL` is empty; although `.env.example` offers `MEDIA_MODEL`, the current production Compose file does not pass it into the gateway, so setting it only in the server `.env` has no effect. A separate media model requires a reviewed Compose change and operator rollout.

For application releases, verify `/healthz`, Compose health, runtime traces and a small bounded model smoke. Do not drop schemas or delete volumes. The automatic release tags the previous gateway image for application rollback; database rollback is separate and not automatic.

Run only one Telegram poller for the token. Keep Postgres and health ports bound to loopback. Never run an unfiltered command that prints rendered Compose secrets into logs.
