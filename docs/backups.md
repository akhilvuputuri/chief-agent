# Database backup and recovery

Enabled 2026-09-06. `hermes-backup.timer` runs around 03:15 UTC daily (11:15 Singapore), with up to five minutes jitter and catch-up after downtime. It calls `deploy/backup-database.sh` via a root systemd oneshot.

The script streams a consistent Postgres custom-format dump directly through OpenSSL CMS AES-256 encryption. Only the recipient certificate/public key is on the server (`/etc/hermes-backup-recipient.pem`). The private decryption key is on the operator Mac at `/Users/akhilvuputuri/Dev/hermes-companion-ops/backup-private.pem`, mode 0600. Preserve a secure independent copy of that private key: losing it makes the backups unreadable. Never commit it or give it to the daily/development agent.

Encrypted dumps and SHA-256 files are written under `/var/backups/hermes-companion` with private permissions, atomic completed-file publication, a lock to prevent overlap, and 14-day server retention. There is no plaintext dump on disk. Systemd failures are visible in `systemctl status hermes-backup.service` and its journal; proactive notifications are not configured yet.

A first encrypted copy is also saved on the operator Mac in `hermes-companion-ops/backups/`. Automatic off-server cloud upload remains unfinished; server-local backups do not protect against loss of the server.

## Restore validation

The initial encrypted dump was copied off-server, decrypted on the Mac, and streamed over SSH to a fresh Postgres 17 container with no network interfaces exposed. `pg_restore --no-owner --exit-on-error` passed. The restored DB contained one memory and one conversation, matching the live application at backup time. The temporary container and its temporary storage were removed. Production was not modified.

To repeat, use a fresh disposable Postgres container, decrypt with `openssl cms -decrypt -binary -inform DER -in BACKUP -inkey PRIVATE_KEY`, and pipe into `pg_restore` in that disposable environment. Never test by restoring over production. Verify application tables and then remove only the temporary test resources.

## Scope

This covers all Postgres application tables: users, conversations, jobs, memories, approvals, events and inbound updates. It does not back up `.env`, SSH credentials, source history or Hermes runtime-volume artifacts. Source is in private GitHub; credentials need separate secure recovery arrangements. Postgres is the authoritative user memory/job store.

Next step: choose an off-server object-storage destination, authorize any additional cost, upload encrypted completed backups with retention, and test restore from that destination. Add monitoring for failed/missing backups and recoverability, not just timer execution.
