# Personal-agent handover

Updated 6 September 2026. The owned TypeScript runtime is deployed on the existing DigitalOcean server. PR #7 introduced the cutover (`f1664bb`); consult server `RELEASE` for subsequent revisions. The gateway and Postgres are healthy, and the Hermes container has been removed without deleting its volume.

## Intent and constraints

Build a useful general personal assistant and an AI engineering portfolio project. Telegram text and voice are the initial interface; job preparation is one domain. The user chose our own runtime and accepts iterative conversational bugs. Protect credentials, ownership and approvals. Keep Gmail and Calendar read-only. No extra paid infrastructure. No automatic shell execution, delegation or self-deployment.

## Locations

- Source: `/Users/akhilvuputuri/Dev/hermes-companion`
- Private operations directory: `/Users/akhilvuputuri/Dev/hermes-companion-ops`
- Repository: https://github.com/akhilvuputuri/companion-agent
- Existing DigitalOcean host: `188.166.246.143`, `/opt/hermes-companion`, $24/month, Singapore.
- SSH identity: private ops `hermes_do`, with pinned `known_hosts`.

Secrets live only in private environment/operations files and server configuration. Never print or commit their contents. Existing Telegram pairing and Google authorization should be reused. The user authorized merging passing changes and deploying on this server.

## Current target architecture

`telegram.ts` → `agent.ts` → `custom-agent.ts` → `model.ts` and the in-process owner-scoped dispatcher. `context.ts` builds context; `execution.ts` persists runs, calls and budgets. Postgres retains all state. Production Compose has gateway + Postgres and a one-shot migration service. No production Hermes service or HTTP tool callback.

- Main model: `openai/gpt-5.6-sol`, explicit medium reasoning, OpenRouter price-first, default ceilings $2/M input and $10/M output.
- Search helper: `google/gemini-3.8-flash`.
- Voice: ElevenLabs `scribe_v2`, `eleven_flash_v2_5`, existing stock River voice. The audio-provider boundary remains unchanged.
- Read-only Gmail/Calendar, preparation Sheet and daily Sheet integrations are retained.
- Skills: repository catalogue plus owner-approved immutable private versions, loaded on demand.
- Telegram output: model-written prose guided by phone delivery context; existing renderer only. `/status` is the separate deterministic ledger.

## Durable execution

Initial task allocation: 15 minutes active execution, 40 model calls, 100 tool calls. `/continue` adds capacity without resetting completed steps. `/workcancel` aborts an in-flight model request and prevents later dispatch. Already-started tools can finish and remain recorded.

Migration `006_runtime.sql` archives old histories, seeds text-only context and pauses active tasks once. Do not automatically resume the 22-role request or erase its steps. Restart recovery conservatively pauses work and marks started writes uncertain. Uncertain writes require inspection before further writes. See [recovery](docs/reliable-execution.md).

## Verification and next work

Run `npm run check`, `npm run build`, `npm run format:check`. `npm run smoke:runtime` makes bounded paid Sol calls against a synthetic PGlite database, never the production user's records. Check deployment status in `docs/verification.md` and server `RELEASE`.

Improve from actual daily conversations: context selection, memory retrieval, deduplication, tracing and voice responsiveness. Realtime voice, subagents, sandbox execution, self-deployment and a web client remain later milestones.

The previous detailed Hermes handover is retained under `docs/history/hermes-handover.md` as historical context. Its architecture and model defaults are obsolete. Do not deploy the historical bridge as a prerequisite.

## Live cutover results

Historical cutover result (superseded by the selective reset below): all 22 roles remained, and task `aaf59b66-dc61-4c1c-8afa-bdc50d8ff850` was paused at revision 3 with 26 done and 21 pending steps. That task is now archived, not active. Live Sol, Telegram bot authentication, read-only Gmail/Calendar, both three-tab Sheet mirrors and an ElevenLabs speech/transcription round trip passed. No automatic resumption was performed. A fresh user-sent Telegram voice note remains a useful hands-on acceptance check after the automated and provider checks.

## Repository rename and progress visibility

GitHub is now `akhilvuputuri/companion-agent`; the local Git remote points there. The existing local source directory and server `/opt/hermes-companion` remain unchanged, preserving Docker project/volume identity. Background tasks forward model-written progress through the same Telegram renderer as ordinary turns. A typing indicator shows active processing, and `/status` bypasses conversational queues.

## Selective fresh start — 7 September 2026

The chosen repository name is `companion-agent`. The local directory and server/Docker project paths remain unchanged. Old conversations, runtime calls, task checkpoints, research sources and generated preparation data were copied into Postgres schema `reset_archive_20260907` before being cleared from live tables. The archive is private and recoverable; do not run the reset again. All 22 listings, six explicit memories, credentials and connections were retained. There were no private skill versions to migrate. Old inbound update IDs remain to prevent Telegram replay. Pending old approvals, if any, were expired.

The progress and skill-schema fixes are included in this release. A two-role check is used to assess fresh behavior before another full batch; do not automatically recreate the old 47-step task.

Current skill loading uses `skill_read(key)` with no version argument. Reading an explicit private revision uses `skill_version_read(key,id)` with an owner-scoped UUID. This avoids placeholder IDs preventing repository defaults from loading.

The two-role acceptance task completed all five recorded steps: six preparation findings and three shared exercises were saved, and the preparation Sheet synced with counts 22 roles / 6 findings / 3 exercises. Across the initial pass and resumed pass it used 30 model calls and 60 tool calls; the deliberately smaller first allocation exposed and preserved a budget pause. The other 20 roles were not processed.

## Repository cleanup — 7 September 2026

Removed the obsolete `services/hermes` Python adapter, unused internal service-token setting and stale setup instructions. Current security, Google, scheduling, skill and operating-model docs describe the owned runtime. Git history and explicitly historical documents retain attribution. Existing server paths, backup unit names and database migration history remain unchanged to preserve operational identity.

## Deferred runtime evaluation candidate — 7 September 2026

Work on `feature/runtime-evaluations` is checkpointed, not deployed. The user requested deferral. See [checkpoint and resume checklist](docs/checkpoints/runtime-evaluations.md), [candidate architecture](docs/runtime-hardening.md) and [development process](docs/development-process.md). Do not treat the branch as a validated release or rerun paid evals automatically.
