# Deployment

Use the existing Singapore DigitalOcean server. The source lives at `/opt/hermes-companion`; private root-readable `.env` supplies existing credentials. Production Compose runs only the Node gateway and Postgres, plus a one-shot schema job.

For the Hermes-to-custom cutover, stop the gateway before migration 006. Apply migrations, build the gateway, and start it after checks. Remove the obsolete Hermes container without removing its volume. Preserve existing schedule `next_run` timestamps and user data. Active work is paused by migration; do not reset or restart the 22-role task.

Set `AGENT_MODEL=openai/gpt-5.6-sol`, `AGENT_REASONING_EFFORT=medium`, price ceilings 2/10 and the desired execution allocations. `SEARCH_MODEL` remains the separate Gemini helper. `MEDIA_MODEL` optionally selects a separate vision/document model for the media specialist; leave it blank to use `AGENT_MODEL`. Existing speech and Google credentials remain unchanged. `HERMES_URL`, `HERMES_MODEL`, and `INTERNAL_API_TOKEN` are not needed by the custom production path.

Verify `/healthz`, Compose health, runtime traces, a small bounded model smoke and read-only integration checks. Tag the previous gateway image before cutover for rollback. Do not drop schemas or delete volumes. If rolling application code back, keep migrated work paused; the legacy runtime should not consume custom conversation histories without an explicit restore from the unchanged archive.

Run only one Telegram poller for the token. Keep Postgres and health ports bound to loopback. Never run an unfiltered command that prints rendered Compose secrets into logs.
