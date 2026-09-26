# Lightsail production host and private logs

Production is moving from the DigitalOcean VM to one AWS Lightsail VM in Singapore. The Compose project, database, application path and image names are unchanged. [Journal 35](journey/35-lightsail-private-logs.md) records the decision, measurements and migration evidence. This page is the operating procedure. Private access material (keys, account ID, credential files, database dumps, baselines) stays outside Git in the operator's private directory.

## Host

| Item               | Value                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Instance           | `chief-prod`, `ap-southeast-1a`, Ubuntu 24.04 LTS x86-64, bundle `small_3_0` (2 GB RAM, 2 vCPU, 60 GB SSD, public IPv4)                                                                    |
| Address            | Static IP `chief-prod-ip` = `52.77.47.24`; origin `https://companion.52-77-47-24.sslip.io`                                                                                                 |
| Lightsail firewall | TCP 22, 80, 443 from IPv4 and IPv6. 3000 (gateway) and 5432 (Postgres) stay on loopback.                                                                                                   |
| Host firewall      | `ufw` allows OpenSSH, 80 and 443; `fail2ban` running; SSH keys only.                                                                                                                       |
| Operator login     | `ubuntu` with sudo, dedicated operator key. Host keys were verified against `aws lightsail get-instance-access-details` before pinning. Lightsail's browser SSH remains the recovery path. |
| Release login      | `root` with the restricted CI key only: `restrict,command="/usr/local/sbin/companion-cloud-release"`.                                                                                      |
| Application        | `/opt/hermes-companion`, Compose project `hermes-companion`, services `postgres`, `migrate` (one-shot), `gateway`.                                                                         |
| Swap               | 2 GB `/swapfile`. Peak memory in use measured on the old host was 357–529 MB (see journal).                                                                                                |

SSH is open to all addresses because GitHub-hosted release runners do not have fixed IPs.

## Logs

The gateway writes sanitized `chief.ops/1` JSON lines to stdout ([contract](operational-logs.md)). On this host:

1. Docker's default log driver is `journald` (`/etc/docker/daemon.json`), so container output lands in a persistent journal capped at 200 MB.
2. `chief-log-export.service` follows the journal for `CONTAINER_NAME=hermes-companion-gateway-1`. It keeps only lines starting with `{"schema":"chief.ops/1",` and appends them to `/var/log/chief/gateway.jsonl`. A cursor file resumes after exporter or host restarts, so a short outage delays lines rather than dropping them, within journal retention. Anything else the container prints stays in the local journal.
3. `chief-host-health.timer` appends a `chief.host/1` line every 5 minutes to `/var/log/chief/host-health.jsonl`. It records disk, memory, swap, load, gateway and Postgres state, backup timer result, exporter and Caddy state, and release. It holds metadata only.
4. The CloudWatch agent (pinned version, AWS signature verified) tails both files into log groups `/chief/prod/runtime` (30-day retention) and `/chief/prod/host` (14 days). Retention is set by the operator, not by the agent. `logrotate` keeps 7 days locally.

Postgres output is never shipped. There is no historical backfill: CloudWatch starts at the first line exported from this host. Logs are telemetry, not the action ledger. For what actually happened, Postgres `events`, `runtime_runs` and `runtime_calls` remain authoritative.

### Identities

| Identity                                                       | Where                                                                                 | Can                                                                                                  | Cannot                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `chief-log-publisher` (IAM user)                               | `/root/.aws/credentials` profile `AmazonCloudWatchAgent`, mode 0600, on the host only | `CreateLogStream`, `PutLogEvents` on the two groups' streams; `DescribeLogStreams` on them           | query, delete, change retention, IAM, anything else |
| `chief-log-reader-local`, `chief-log-reader-cloud` (IAM users) | the local operator profile, and the Claude cloud environment's private secrets        | `StartQuery` on the two groups; `GetQueryResults` (AWS supports no resource scoping for this action) | publish, other log groups, deploy, SSH, database    |

Policies are in [deploy/lightsail/iam](../deploy/lightsail/iam) with `ACCOUNT_ID` substituted at apply time. No identity has an AWS managed policy attached. To rotate a key, create a new access key for the user, install it, verify one query or publish, then delete the old key. To revoke access, delete the key or the user.

## Reading logs

```sh
npm ci
AWS_PROFILE=chief-logs npm run logs:cloudwatch -- errors --since 2h
npm run logs:cloudwatch -- run --run <runId> --since 6h
npm run logs:cloudwatch -- tools --since 24h
npm run logs:cloudwatch -- --help
```

In a Claude cloud task, set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for `chief-log-reader-cloud` as private environment secrets in the cloud environment settings, never in a prompt, issue or repository file. The CLI uses `ap-southeast-1` and only the two Chief groups. It defaults to one hour and allows at most 24 hours and 500 rows per query. It exits non-zero on access or query failure. Times are given as relative values (`30m`, `2h`) or ISO with an explicit zone. Output shows the window in UTC and Singapore time (UTC+8).

Queries scan data and are billed per GB scanned. The window limits are cost controls, not the security boundary. Never run the CLI in GitHub Actions: this repository is public and Actions logs are public.

To correlate a report: find the time in Singapore time, then run `errors` for a window around it, then `run --run <id>` for the run it names. A missing line is not proof of success. Check `heartbeat` or `host` for exporter or gateway gaps, and use authorized Postgres inspection for the authoritative record.

## Installing or rebuilding the host

Run as the operator from a reviewed source tree:

```sh
sudo CWAGENT_VERSION=1.300073.0b1828 deploy/lightsail/install-host.sh
```

The script installs Docker, Compose, Caddy and the ingress routes, journald limits, the Docker log driver, the exporter, host health, logrotate, the CloudWatch agent, and the backup units. It does not start the gateway or write application secrets. It then prints the installed package versions. Separately, the operator:

- installs the publisher credential file (mode 0600) and restarts the agent;
- copies `/etc/hermes-backup-recipient.pem` (public certificate) so the nightly encrypted backup is enabled;
- installs `scripts/cloud-release.py` as `/usr/local/sbin/companion-cloud-release` (root, 0755) and the CI public key in root's `authorized_keys` with the restriction above;
- places the source tree for the exact release in `/opt/hermes-companion` with `RELEASE`.

## Cutover from DigitalOcean

Only one gateway may run for the bot token. Both hosts must not poll or schedule at the same time.

1. **Stage.** The new host has the reviewed source, the private `.env` (copied host to host over pinned SSH without printing; only `MINIAPP_ORIGIN` edited), a built image tagged with `RELEASE_SHA`, and only Postgres started (`docker compose -p hermes-companion up -d postgres`) with an empty `companion` database. Do not run bare `docker compose up -d`: it would also start `migrate` and `gateway`.
2. **Quiesce.** Confirm no `runtime_runs` in `running` and no `conversation_inputs` in `queued`/`running`. Serialize with the release lock, and don't merge during the window. Stop only the old gateway: `docker compose -p hermes-companion stop gateway`. Postgres keeps running.
3. **Final source baseline.** Record table counts, schema hash and stable-ID manifests for the quiesced source.
4. **Dump and restore.** Run `pg_dump -Fc` of the whole database with no exclusions (it includes `reset_archive_20260907`). Stream it host to host, compare SHA-256 on both ends, then `pg_restore --exit-on-error --no-owner --no-acl` into the empty database. A restore error stops the cutover.
5. **Compare before starting.** Compare restored counts, schema hash and manifests against the final source baseline. Explain any difference before continuing.
6. **Start the gateway only:** `docker compose -p hermes-companion up -d --no-deps --no-build gateway`. Check loopback health, the Compose health state, one `gateway.started` line in CloudWatch, and that the old gateway is still stopped.
7. **Origin-dependent settings.** Set the bot's menu button to `<origin>/miniapp/`. The owner updates the Mini App domain in BotFather and the Google OAuth branding URLs (`/about`, `/privacy`, `/terms`) to the new origin. Existing Google refresh tokens do not depend on the host.
8. **Release path.** Update the repository variable `CHIEF_DEPLOY_HOST` to `52.77.47.24` and the secret `COMPANION_KNOWN_HOSTS` to the verified Lightsail host keys. Run the normal `release` workflow for current `main`, then check its exact-SHA receipt and `npm run release:status`.
9. **Acceptance.** Run the matched checks from the migration ledger: Telegram text and voice, a harmless attachment, Google read-only lookups, Sheets, approvals (fixtures, and a live event only with the owner's approval), memory/skills, canvases through Telegram authentication, schedules, the reader CLI from a fresh cloud task, and reboot recovery.

## Rollback

Before the new host has accepted any work: stop the Lightsail gateway, then start the old gateway on DigitalOcean (`docker compose -p hermes-companion start gateway`). Restore the menu button, `CHIEF_DEPLOY_HOST` and `COMPANION_KNOWN_HOSTS`. The old database is unchanged because it was only dumped.

After the new host has accepted work, the old database is stale. Quiesce the new gateway, dump and restore the new database back to the old host with the same comparison, and only then start the old gateway. Otherwise, fix forward. Never run both gateways while deciding. A database rollback does not undo external actions; keep records of completed and uncertain writes.

Keep the DigitalOcean VM stopped but available until the owner decides to retire it. A stopped droplet still costs money. Retirement also revokes the old operator and CI key entries.

## Troubleshooting

| Symptom                             | Check                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No lines in `/chief/prod/runtime`   | `systemctl status chief-log-export`, `tail /var/log/chief/gateway.jsonl`, `journalctl CONTAINER_NAME=hermes-companion-gateway-1 -n 5 -o cat`, agent log `/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log` (an `AccessDenied` there means the publisher policy, not the app) |
| Lines stop but the bot works        | Exporter or agent stopped: check the `host` query's `exporter` field, then restart `chief-log-export` or the agent. The cursor resumes where it stopped.                                                                                                                                      |
| Reader gets `AccessDeniedException` | Wrong group or region, expired or deleted key, or a query against a group outside the two Chief groups                                                                                                                                                                                        |
| Disk filling                        | `docker system df`. The release handler prunes old per-release images and keeps `:latest` and `:rollback`.                                                                                                                                                                                    |
| Release refused on the new host     | Same guards as before: active work, pending input, or a `compose.yaml`/`db` difference from the installed baseline. See [cloud development](cloud-development.md).                                                                                                                            |
