# 35 — Lightsail host and private operational logs

Work date(s): 2026-09-26. Written/revised: 2026-09-26.
Status: released. Production has run on the Lightsail VM since 26 September 2026 at 10:40:55 UTC, with sanitized logs in CloudWatch and a scoped reader. Owner Telegram acceptance and some console follow-ups remain; see the ledger below.

## User-visible problem and preceding iteration

Cloud coding agents could not see production. The [cloud harness](29-cloud-agent-harness.md) gave them a bounded `production-diagnostics` workflow, but that workflow requires a private repository. Once the repository became public on 24 September, it could no longer run, and public Actions logs are the wrong place for production data anyway. Local debugging relied on root SSH from one Mac. The gateway wrote almost nothing to stdout, and Node's default crash output would have printed raw error messages.

The owner chose to move the existing Compose deployment to one AWS Lightsail VM in Singapore and send sanitized logs to CloudWatch, where local and cloud agents can query them with scoped read-only credentials. ECS/RDS ([issue #25](https://github.com/akhilvuputuri/chief-agent/issues/25)) is not pursued.

## Evidence

- Measured on 26 September, read-only preflight at 17:28 SGT. Production ran `bca55960446fff7c84fe9250a689f04aad7756aa`, identical to `main`. Postgres was 17.11 with 66 tables (51 `public`, 15 `reset_archive_20260907`). The installed `compose.yaml`, Caddyfile, `Dockerfile` and release handler matched `main` by SHA-256.
- Measured with sysstat over 18–26 September on the 4 GB DigitalOcean VM. Daily peak memory in use was 357–529 MB (10-minute samples). The gateway used 66 MB and Postgres 76 MB. CPU averaged about 3%, with a 10-minute peak of 15%. On that basis the owner chose the 2 GB / 2 vCPU / 60 GB Lightsail plan ($12/month, checked against the pricing page the same day) instead of the planned 4 GB plan. Image builds are not captured by 10-minute samples and must be measured on the new host.
- Tested: the process-guard replacement of Node's crash output and the sanitizer. Hostile-payload tests show that the private values tried (message text, email, OAuth URL, bearer and OAuth tokens, file path, SQL) do not appear in any projected line. One test run failed because the provider field accepted a four-word string. The shape was narrowed to at most three short words.

## Diagnosis and alternatives

- **Hooking the events table:** mirroring every event would copy prompts, research inputs and rendered answers. Instead, each projection is an explicit per-type field list, and every value must also pass a shape check. Generic redaction was rejected because free text cannot be reliably cleaned.
- **Tool outcomes:** these come from the call journal, which covers every dispatched call, rather than from `tool.*` events, which fire only for some operations. That avoids duplicate lines.
- **Release identity:** the running app did not know its commit. The image accepts a `RELEASE_SHA` build argument; the release handler installed on the new host is planned to pass it, and until then `release` is null.
- **Compose:** the application release guard refuses `compose.yaml` changes. The journald logging driver is therefore planned as host-level Docker configuration on Lightsail, which keeps ordinary releases to DigitalOcean working until cutover.

## Implementation and review

See [operational logs](../operational-logs.md). PR [#94](https://github.com/akhilvuputuri/chief-agent/pull/94).

An independent Opus 5.5 review of `91dd0a7` requested changes. Blocking findings:

- The model could put up to 80 characters of its own text into `operation` by calling a tool that does not exist, because the call is journaled before the tool name is checked.
- No line was written when a tool started or when restart recovery ran, so an uncertain write left no trace in the logs.

Smaller findings:

- A progress delivery failure was logged twice.
- A delivery-failure line could follow a successful send.
- Extracting error fields could throw inside catch blocks.
- Startup refusals and library recovery counts were lost.
- An unknown cost was omitted instead of `null`.
- The tests did not cover one-word tokens.

Fixes: only host-defined operation names are logged (otherwise `unknown`), `callId` is the journal row ID, and there are `tool.started` and `runtime.recovered` lines. The duplicate projection is removed. `telegram.delivery_error` carries a `phase`, error extraction cannot throw, startup refusals have fixed codes, and unknown cost is `null`. Regression tests were added for each.

### Release of the log projection — 26 September

PR #94 was merged as `9af92ee1c16b28b4a6f10d7029dffed4be2152e7` after an independent Opus 5.5 approval of head `1e71e8e`. The automatic release deployed it to the DigitalOcean host. The exact-commit receipt reported startup health, and the server `RELEASE` matched. The gateway's stdout then contained `gateway.started`, `runtime.recovered` and `library.recovered` lines. `release` is null on that host because its installed handler does not pass the build argument.

### Host staging — 26 September (measured)

- **Host install:** `deploy/lightsail/install-host.sh` ran on the new VM. It installed Docker 29.1.3, Compose 2.40.3 (the same versions as the old host), Caddy 2.6.2 and CloudWatch agent `1.300073.0b1828`. The agent's signing-key fingerprint matched the AWS-documented value, and the package signature verified.
- **Caddy routes:** Caddy obtained a Let's Encrypt certificate for `companion.52-77-47-24.sslip.io`. `/about` returned 200, `/healthz` and `/.env` returned 404, and HTTP redirected with 308.
- **Log delivery:** a host-health line reached `/chief/prod/host` and was read back with `npm run logs:cloudwatch -- host` under the local reader identity.
- **Identities:** three IAM users (publisher, local reader, cloud reader), each with one inline policy and no managed policies or groups.
- **Real denials:**
  - The reader could not `PutLogEvents` or query another group.
  - The publisher could not `StartQuery`, create a stream in another group, or change retention.
- **Policy simulator:** it agreed on the denials, but reported `PutLogEvents` and `CreateLogStream` as implicitly denied even for the publisher's own stream, although real publishing worked. The simulator is therefore not used as evidence for stream-level allows.
- **Release access:** the restricted CI key on the new host refused `id` and a malformed deploy. The installed handler's SHA-256 matched `scripts/cloud-release.py`.
- **Application staging:**
  - The exact `9af92ee` tree was copied. The `compose.yaml` hash matched the old host.
  - The private environment was copied host to host. Apart from `MINIAPP_ORIGIN`, its hash was identical, and it is root-only (0600).
  - The image was built with `RELEASE_SHA` in 64 seconds, with peak memory in use of 973 MB of 2 GB.
  - Only Postgres 17.11 is running. No gateway container exists.

### Host PR review — 26 September

An independent Opus 5.5 review of `d6c0b5c` requested changes:

- **Timestamps (medium):** CloudWatch `@timestamp` was the time the agent read a line, not the event time. Measured on the staging host, a host-health line with `ts` 10:03:42 was stored at 10:07:49.
- **Re-running the installer (medium):** it restarted Docker unconditionally, which would interrupt a live gateway.
- **CLI:** no per-request timeout, and it silently did nothing when the checkout path needs URL-escaping.
- **Signature check:** it did not require the pinned key to be the signer.
- **Error output:** it could include ARNs and account IDs.
- **Docs:** they overstated the cursor guarantee and omitted rotation and non-blocking caveats.

Fixes:

- The agent parses `ts`. After the change, a staging line with `ts` 10:23:44.157 was stored at 10:23:44.000.
- The installer restarts journald or Docker only on configuration change, and refuses a Docker change while containers run. A re-run on the staging host left Postgres's start time unchanged.
- The `VALIDSIG` signer is checked against the pinned fingerprint.
- CLI requests have timeouts plus a hard 75-second deadline.
- The CLI's entry-point guard now uses `pathToFileURL`, and a spaced path was tested.
- Error messages are redacted, with a test.
- The docs describe at-least-once delivery, possible duplicates, rotation and non-blocking drops.

A re-review of `7ea9996` found one more problem. The new signer check piped gpg into `grep -q` under `pipefail`, which could abort a genuine install when gpg took SIGPIPE. It now captures gpg's status before matching. The re-review also noted that the SDK request timeout only warned (it now throws), that re-runs could upgrade Docker (the bootstrap now runs only on first install), and that replay is limited by CloudWatch's 14-day age limit (documented). `c58a709` was approved and merged as #96 (`ebcc9dc`).

### Reboot finding — 26 September

A reboot test of the new host showed a gap in the logs. The gateway wrote `gateway.stopping` to the local journal at 10:47:48, but the exporter had stopped moments earlier, and after boot the line was never exported, although the saved cursor pointed before it. On systemd 255, `journalctl --follow --cursor-file` skipped the previous boot's entries, while the same command without `--follow` returned them. The exporter now polls without `--follow` every 5 seconds. It advances the saved cursor only after the lines are written, and exits after repeated failures so the stall is visible ([PR #98](https://github.com/akhilvuputuri/chief-agent/pull/98), reviewed by Opus 5.5). After the exporter was switched on the host, it resumed from the older saved cursor. That exported the missed line and re-sent 10 already-exported lines as duplicates, as the at-least-once contract allows.

## Verification and outcome

### Cutover — 26 September 2026 (measured)

1. **Rehearsal.** A live dump was restored into the staging database. All 66 tables had identical row counts and identical per-table content hashes (MD5 over rows ordered by their text form), and the schema hash matched. The rehearsal dump was then shredded.
2. **Quiesce.** Automatic releases were disabled for the window. DigitalOcean showed no running runs, queued or running inputs, active tasks, pending routine deliveries, processing reminders, or scheduled daily items or routines. Only the old gateway was stopped (10:40:10 UTC), and Postgres had no other connections.
3. **Dump and restore.** A final `pg_dump -Fc` with no exclusions (5,980,952 bytes) had the same SHA-256 on the old host, the operator Mac and Lightsail. `pg_restore --exit-on-error --no-owner --no-acl` went into a freshly recreated empty database and exited 0. Only the `companion` role and the `plpgsql` extension exist on either side.
4. **Before starting.** 66 of 66 tables, 25,675 of 25,675 rows, every per-table content hash and the schema hash were identical to the quiesced source.
5. **Gateway.** Only the gateway was started (`up -d --no-deps --no-build`). It was healthy at 10:40:55 UTC, about 45 seconds after the old one stopped. Startup recovery found nothing uncertain. The bot polls with no webhook, and the default menu button now points to the new origin.
6. **Release path.** `CHIEF_DEPLOY_HOST` was switched to the Lightsail IP and `COMPANION_KNOWN_HOSTS` to the verified Lightsail host keys, and the workflow was re-enabled.
   - The manual `release` run for `ebcc9dc` printed `{"deployed": …, "healthy": true}`, and the exact-commit receipt was recorded.
   - The next ordinary merge (#98, `5988e52`) released automatically, with a matching receipt.
   - Pruning left only `:latest` and `:rollback`.
7. **Reboot.** The host came back 11 seconds after the reboot command. The gateway was healthy 24 seconds after, and Postgres, the exporter, host health, Caddy, the backup timer, Docker, the agent and swap all recovered. This test found the exporter gap described above.

### Acceptance ledger

| Area                                | Before (DigitalOcean)                        | After (Lightsail)                                                                                                                                                                                                                                                                                                                                           | Limit                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime and release                 | `bca5596`, later `ebcc9dc`, healthy          | `ebcc9dc`, then `5988e52` via the normal release. Log lines carry the release SHA.                                                                                                                                                                                                                                                                          | Health checks startup, not conversation quality.                                                                                                                                                                              |
| Data                                | 66 tables, content hashes                    | Identical, including `reset_archive_20260907`                                                                                                                                                                                                                                                                                                               | Hashes prove equality at cutover, not correctness of earlier data.                                                                                                                                                            |
| Gmail (both accounts)               | Configured                                   | Token refresh and profile read return 200 with the expected mailbox for each account                                                                                                                                                                                                                                                                        | Read-only lookup; no message content inspected.                                                                                                                                                                               |
| Calendar                            | Configured                                   | Upcoming-events read returns 200. On 26 September at 19:53 SGT, an owner-approved draft was created in Google Calendar with a receipt (`calendar.approval_decided`, then `calendar.created`).                                                                                                                                                               | One live event.                                                                                                                                                                                                               |
| Sheets (daily and preparation)      | Token refresh fails with `invalid_grant`     | The same `invalid_grant`                                                                                                                                                                                                                                                                                                                                    | **Existing defect, not fixed here.** The same credential fails from the old host. Re-authorization is needed (`scripts/connect-sheets.mjs`).                                                                                  |
| Mini App                            | Old origin                                   | The owner reports that Canvases opens from the Telegram menu. `/miniapp/` returns 200. `/api/miniapp/canvases` returns 401 without init data and with forged init data. `/healthz` and `/.env` return 404.                                                                                                                                                  | No canvases are saved yet, so no `canvas.viewed` event exists. `GET /` returns an empty 200 on both hosts: the Caddyfile's `redir /miniapp/ 302` is parsed with `/miniapp/` as a path matcher, a defect that already existed. |
| Schedules and tasks                 | None scheduled, no active tasks              | Same data                                                                                                                                                                                                                                                                                                                                                   | No scheduled run due to observe.                                                                                                                                                                                              |
| Approvals, memory, skills, canvases | Present                                      | Byte-identical tables                                                                                                                                                                                                                                                                                                                                       | Behaviour covered by fixture tests; no live exercise.                                                                                                                                                                         |
| Backups                             | Nightly encrypted, last success 26 September | Encrypted backup ran successfully on the new host; timer scheduled                                                                                                                                                                                                                                                                                          | Off-host backup copies remain future work.                                                                                                                                                                                    |
| Telegram text, voice, media         | Working per earlier acceptance               | Owner conversation on 26 September, 19:51–20:16 SGT. 10 inputs, each received, routed, answered and delivered, with no delivery errors, failed turns or model failures. Text replies took about 3–4 s, a voice note about 10 s (transcribed 2 s after arrival), and an image about 21 s via the media specialist. Read from CloudWatch with the reader CLI. | Latency is from one short session. `context.over_budget` warnings appear on most runs, as they have on the old host every day since 20 September (issue #77).                                                                 |
| Logs to CloudWatch                  | None                                         | Gateway and host lines in both groups; `@timestamp` from `ts`; reader and publisher denials verified                                                                                                                                                                                                                                                        | At-least-once: duplicates possible; journald non-blocking mode can drop lines under pressure.                                                                                                                                 |

### Fresh-agent log reading test

A fresh Sonnet subagent received only a user-style report ("something failed while checking my calendar around 18:50 SGT"), a clean clone of the public repository, and the cloud reader credentials as environment secrets. It had no SSH, database or Mac-local context. A labelled synthetic `tool.finished` failure (`errorCode: SYNTHETIC_MIGRATION_TEST`) had been injected into the gateway's journal stream, so it travelled the real exporter and agent path.

Using only `AGENTS.md`, `docs/troubleshooting.md`, `docs/operational-logs.md` and `docs/lightsail.md`, the agent:

- found the failed `calendar_list` call with its run ID, release SHA and 30-second latency;
- found the gateway restarts in the preceding 10 minutes;
- summarized the last hour's activity;
- correctly concluded that CloudWatch cannot prove cause and that Postgres is authoritative;
- identified the line as likely synthetic.

It also found a real defect. The documented first query, `errors`, returned no rows because Logs Insights matched nothing for `level in ["error", "warn"]`, while `level = "error" or level = "warn"` works (reproduced by the operator). The query was changed, with a regression test.

### Release closure — 26 September 2026

[PR #99](https://github.com/akhilvuputuri/chief-agent/pull/99) was approved at `e667883` and merged as `9c7b67cfa19eec1e9d774b93986a922c41221eb5`. The automatic release deployed it to Lightsail, reported startup health and recorded an exact-commit receipt. The server `RELEASE` matched, and CloudWatch showed the release sequence `ebcc9dc` → `5988e52` → `9c7b67c`. The immutable [v0.3.27](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.27) tag resolves to that commit.

### Owner acceptance and a configuration change — 26 September 2026

The owner's live conversation passed the Telegram, voice, image, Calendar approval and Mini App checks above. The owner then reported getting voice-note replies alongside text and asked for voice to be one-way only. Voice replies are sent only when an input was a voice note and `VOICE_REPLIES=true`. The server environment had `true` on both hosts, so this was existing configuration that the migration preserved, not a regression. At the owner's request the operator set `VOICE_REPLIES=false` in the production `.env` (a root-only backup of the previous file was kept) and recreated only the gateway after confirming no active work. The same line was changed in the stopped DigitalOcean host's `.env`, so a rollback keeps the choice. Voice notes are still transcribed.

The log reader's `event`, `run` and `errors` queries now also show delivery, routing and approval fields such as `kind`, `lane`, `inputId`, `approvalId` and `approved`. They were already in the log lines but not displayed.

## Follow-up and next iteration

- **Owner:** in the Claude cloud environment's private settings, add the `chief-log-reader-cloud` variables (from the private operations directory). Until then, the fresh-agent test above was run locally with the same credentials, not inside claude.ai.
- **Owner:** update the Google OAuth branding URLs to the new origin if the consent screen needs them. BotFather's Mini App domain is optional because `web_app` buttons work without it.
- **Owner:** re-authorize Sheets (existing `invalid_grant` defect).
- **Owner:** decide when to retire the stopped DigitalOcean VM (about $24/month while it exists). Retirement should also revoke its operator and CI key entries. The final dump stays root-only on that host until then.
- **Future:** off-host backup copies, removing `copytruncate` from log rotation, and fixing the Caddy root redirect (`redir * /miniapp/ 302` or equivalent, validated before reload).
