# Run on an always-on cloud VM

Use the same Compose stack on a Linux VM with persistent disk. Choose resources based on a measured build and a small load test; Hermes uses an external model, so a GPU is not required. A cloud account and deployment target have not been provisioned by this repository.

1. Install Docker Engine and the Compose plugin on the VM; limit SSH access to your administrator identity.
2. Transfer or clone this repository. Put `.env` on the VM through your secret-management process; restrict permissions with `chmod 600 .env`.
3. Configure the variables in the README. Do not expose Postgres, Node or Hermes to the internet. Outbound HTTPS must reach Telegram and the enabled providers.
4. Run `docker compose up --build -d`. Check container health and send `/start` from the allowed Telegram account.
5. Test a text conversation, role save/list/update, voice note, deletion denial, then an approved deletion of a disposable test role.
6. Restart the stack and verify preferences and saved roles remain accessible.

The restart policy keeps services running after failures and host restarts once Docker starts. Named volumes are the persistence boundary. Avoid ephemeral VM disks and scale-to-zero workers for long polling.

## Backups and upgrades

```sh
# This file contains sensitive user information. Store it encrypted and off-host.
docker compose exec -T postgres pg_dump -U companion -d companion -Fc > companion.dump
```

Back up the Hermes volume with a filesystem snapshot while the worker is stopped. Rehearse restoration into a separate database before relying on backups. Keep schema and application versions together. The initial SQL is repeatable but is not an incremental migration framework; add numbered migrations before the first schema evolution.

For an app upgrade, run checks, build the new image, back up state, and restart. For a Hermes upgrade, deliberately change the pinned commit and run the real-runtime smoke test in addition to unit tests. The custom registry and constructor are upstream integration points and may change.

## Diagnosing problems

| Symptom                     | Check                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------- |
| No bot reply                | Bot token, numeric allowlist, private chat, no competing poller, no existing webhook  |
| Text works; voice fails     | Speech key/access, 3-minute / 10 MB input limits, provider status                     |
| Research unavailable        | Tavily key; public HTTPS page; no login-only site                                     |
| Agent unavailable           | Hermes health, model access, exact tool allowlist, history size                       |
| Request failed after a save | List roles first; prior tool effects may already be committed                         |
| Approval rejected           | Correct owner, exact UUID, within 15 minutes, not already consumed                    |
| Turn stuck after restart    | Inspect inbound status and jobs; failed/processing IDs are not replayed automatically |

`/healthz` reports liveness only. Check the database and perform a small synthetic conversation for an operational readiness test. Do not put raw exception objects into logs: provider errors and Telegram download URLs can carry secrets.

## Inspect metadata safely

```sql
SELECT run_id, type, data, created_at
FROM events ORDER BY id DESC LIMIT 50;

SELECT update_id, status, created_at
FROM inbound_updates WHERE status <> 'completed'
ORDER BY created_at DESC;
```

Future work: managed Postgres with TLS, a durable queue and reply outbox, workload identity/secrets integration, metrics and alerts, backup retention, and per-user spending limits. Do not run multiple gateway replicas against the same Telegram token in this version.
