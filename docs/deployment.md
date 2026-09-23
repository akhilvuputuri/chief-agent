# Deployment

Use the existing Singapore DigitalOcean server. The source lives at `/opt/hermes-companion`; private root-readable `.env` supplies existing credentials. Production Compose runs only the Node gateway and Postgres, plus a one-shot schema job.

The Hermes-to-custom migration was a historical cutover; do not rerun its reset or migration procedure to change a model. Current releases follow [cloud development](cloud-development.md), with reviewed operator procedures for Compose and database changes.

The current checked-in defaults are `AGENT_MODEL=openai/gpt-5.6-sol`, medium reasoning and provider price ceilings of $2/M input and $10/M output. `SEARCH_MODEL` is the separate Gemini research helper. Existing speech and Google credentials remain unchanged. `HERMES_URL`, `HERMES_MODEL`, and `INTERNAL_API_TOKEN` are not used by the custom production path.

## Changing the production model

The live gateway receives `AGENT_MODEL` from `compose.yaml`. Compose takes the value from `/opt/hermes-companion/.env` when present, or injects its own `openai/gpt-5.6-sol` fallback. That injected value takes precedence over the defaults in `src/config.ts` and `src/model.ts`. Consequently, changing only a TypeScript default or `.env.example` does **not** switch the running bot. There is no Telegram model-switch command; the value is selected when the gateway container is created.

For a model available through the existing OpenRouter key, an authorized operator can make a configuration-only switch without a code release:

1. Check the exact OpenRouter model ID, support for tools/reasoning, and eligible provider prices against the configured input/output ceilings. The gateway requests medium reasoning and price-first routing; it fails explicitly if no provider meets the filters. Keep the previous model ID for rollback.
2. Wait until no foreground or background work is active or queued. On the server, edit the private `.env` to set one `AGENT_MODEL=<verified-id>` line. Never print the whole file or rendered Compose configuration into logs.
3. From `/opt/hermes-companion`, recreate **only** the gateway with `docker compose up -d --no-deps --force-recreate gateway`. A plain container restart does not reread changed environment variables. Postgres data and the release SHA are unchanged.
4. Check gateway health, then make a small owner-initiated Telegram request. Confirm its recorded `model.started`/`model.completed` model ID and provider outcome before calling the switch successful. Startup health alone is insufficient. If it fails, restore the previous `.env` value and recreate the gateway again.

The automatic GitHub release deliberately refuses Compose and database changes, and cloud coding tasks do not receive the private server `.env` or the operator SSH identity. A code PR can update documented defaults for future installs, but the operator step above is what changes this installation. Keep the actual runtime model out of the release SHA alone: a later `.env` switch does not create a new code release. Record the dated model switch and smoke result in the operations journal without recording credentials or private prompts.

`SEARCH_MODEL` is a separate research helper. The media specialist falls back to the main model when `MEDIA_MODEL` is empty; although `.env.example` offers `MEDIA_MODEL`, the current production Compose file does not pass it into the gateway, so setting it only in the server `.env` has no effect. A separate media model requires a reviewed Compose change and operator rollout.

For application releases, verify `/healthz`, Compose health, runtime traces and a small bounded model smoke. Do not drop schemas or delete volumes. The automatic release tags the previous gateway image for application rollback; database rollback is separate and not automatic.

Run only one Telegram poller for the token. Keep Postgres and health ports bound to loopback. Never run an unfiltered command that prints rendered Compose secrets into logs.
