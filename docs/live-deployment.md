# Initial live deployment — 2026-09-06

DigitalOcean Droplet `hermes-companion-sgp1` (ID 598161491), Singapore, Ubuntu 24.04, 2 vCPU / 4 GB RAM / 80 GB SSD, $24/month before applicable taxes. No paid backups or managed database were added.

The application lives at `/opt/hermes-companion` on the server. Docker Compose runs the gateway, pinned Hermes sidecar and Postgres with persistent volumes and restart policies. The initial migration completed successfully. The gateway and Postgres publish only to loopback; Hermes has no published port. The host firewall allows SSH, with password authentication disabled. Application secrets are in a root-readable `.env` and excluded from source archives.

The deployment key is stored separately on the operator's Mac, outside this source repository. Keep it and the pinned SSH known-hosts file backed up securely. Do not give this key to the agent or put it in a development sandbox.

## Verified

- Telegram account pairing completed through a matching private nonce message.
- All three services reported healthy.
- Gateway HTTP health check passed.
- Gemini 3.8 Flash via OpenRouter passed a function-call connectivity check.
- The deployed Hermes HTTP boundary completed a real Gemini turn successfully.

A user-driven Telegram conversational tool test remains the final acceptance check. Health checks alone do not prove task success.

## Current limits

Voice awaits a speech-provider credential. Hosted search awaits a search-provider credential. Astra orchestration, GLM development workers and an isolated self-development sandbox are not implemented yet. See `operating-model.md` for the intended boundary.

Persistent volumes are not backups. Before relying on this for irreplaceable data, configure encrypted off-server Postgres and Hermes-volume backups and test restoration. Migration to another host uses the same Compose setup plus database/volume restoration and provider secrets.

## Maintenance

From the application directory on the server: `docker compose ps` checks health, `docker compose logs --tail 50 gateway` reads metadata logs, and `docker compose stop gateway` stops Telegram polling. Never run two gateway instances with the same bot token. Avoid printing `docker compose config`, which expands secrets.
