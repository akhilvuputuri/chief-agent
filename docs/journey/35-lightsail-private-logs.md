# 35 — Lightsail host and private operational logs

Work date(s): 2026-09-26. Written/revised: 2026-09-26.
Status: in progress. Sanitized operational logging is implemented and tested on a review branch. The Lightsail VM is provisioned but not serving; the DigitalOcean host still runs production.

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

## Verification and outcome

Pending: independent review, CloudWatch delivery on the new host, the reader CLI, cutover and a matched acceptance ledger.

## Follow-up and next iteration

The remaining steps are the host installation procedure, the bounded CloudWatch reader for Claude cloud and local sessions, the cutover, and the new sslip.io origin with its Telegram and Google console changes.
