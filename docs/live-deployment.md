# Live deployment

The existing DigitalOcean Singapore server runs Companion Agent at `/opt/hermes-companion`. That deployment path, Docker project and volume names intentionally retain their original names to preserve storage identity. They do not imply an upstream runtime dependency.

Only the Node gateway and Postgres are long-running services. A one-shot migration job applies schema changes. Credentials live in a private environment file; services publish only to loopback. The server's `RELEASE` records its deployed revision.

The selective reset on 7 September 2026 preserved 22 listings, six explicit memories and connections. Historical conversations, task state and generated research are in private schema `reset_archive_20260907`. Do not rerun the reset or automatically resume the archived task. A new two-role check completed and synced six findings and three exercises.

See [deployment procedure](deployment.md), [verification](verification.md) and [handover](../HANDOVER.md). Historical prototype records are under `history/` and are not setup instructions.
