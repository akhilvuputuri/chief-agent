# Personal-agent handover

Start with [current work](docs/current-work.md) and [portable development](docs/portable-development.md). The unfinished observable-memory code is now on GitHub at `checkpoint/observable-memory` (`2a85839`), not just on the original Mac. It is not deployed. Read its checkpoint before resuming. GitHub main is integrated source; successful release SHA is deployed source. See [versions and release notes](docs/releases.md).

Updated 9 September 2026. Read [cloud development and deployment](docs/cloud-development.md) and [agent instructions](AGENTS.md) for current operating procedures. The owned TypeScript runtime is deployed on the existing DigitalOcean server. PR #7 introduced the cutover (`f1664bb`); consult server `RELEASE` for subsequent revisions. The gateway and Postgres are healthy, and the Hermes container has been removed without deleting its volume.

## Intent and constraints

The application is a general personal assistant. Telegram text and voice are the initial interface; job preparation is one domain. Protect credentials, ownership and approvals. Keep Gmail read-only. Calendar timed-event creation requires explicit Telegram button approval; see [Calendar release procedure](docs/calendar-approval.md). No extra paid infrastructure. No automatic shell execution or self-deployment. Bounded research delegation is implemented; see [specialist handover](docs/research-specialist.md).

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
- Read-only Gmail, Calendar queries plus approval-gated event creation, preparation Sheet and daily Sheet integrations are retained.
- Skills: repository catalogue plus owner-approved immutable private versions, loaded on demand.
- Telegram output: model-written prose with optional sections/sources/record references; long answers use inline navigation. `/status` opens recorded steps/evidence/costs; `/roles`, `/items`, `/schedules`, `/drafts`, `/briefing` open read-only state views. See [Telegram views](docs/telegram-views.md).

## Durable execution

Initial task allocation: 15 minutes active execution, 40 model calls, 100 tool calls. `/continue` adds capacity without resetting completed steps. `/workcancel` aborts an in-flight model request and prevents later dispatch. Already-started tools can finish and remain recorded.

Migration `006_runtime.sql` archives old histories, seeds text-only context and pauses active tasks once. Do not automatically resume the 22-role request or erase its steps. Restart recovery conservatively pauses work and marks started writes uncertain. Uncertain writes require inspection before further writes. See [recovery](docs/reliable-execution.md).

## Verification and next work

Run `npm run check`, `npm run build`, `npm run format:check`. `npm run smoke:runtime` makes bounded paid Sol calls against a synthetic PGlite database, never the production user's records. Check deployment status in `docs/verification.md` and server `RELEASE`.

Improve from actual daily conversations: context selection, memory retrieval, deduplication, tracing and voice responsiveness. Realtime voice, parallel specialist teams, sandbox execution, self-deployment and a web client remain later milestones.

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

## Focused response release

PRs #14/#15 are merged and deployed at application revision `1a43301b6504da99a4f9c0af9dd56fa663e5fac7`. This release adds compact observations, owner-scoped observation retrieval, refreshed task/record context and natural Telegram output guidance. All 75 tests and CI passed. Health and preserved data counts passed. Read-only inspection confirms the original incident's 22 IDs can be supplied alongside its later filtered result. No paid eval or full production analysis was rerun after deferral. See [response improvements](docs/response-improvements.md). The broader migration-007 scope/finding candidate remains deferred on its separate branch.

## Token efficiency and usage visibility

The cost-efficiency follow-up is documented in [cost controls](docs/cost-controls.md). It adds stable prompt prefixes, same-task search reuse, lower context volume and additive usage migration 008. The user declined dollar caps: do not add one or change /continue to grant monetary budgets. The proposed cap was removed before deployment. Search/main-model usage is tracked; speech remains separate. Full eval work stays deferred.

Cost-efficiency release verified: PR #16, application `a31813bd167e3916c1914966a386a4a480f54320`. Health and migration 008 passed; 22 jobs preserved, paused work not resumed, and no dollar-cap schema present. 78 tests and CI passed. No paid eval was run.

## Attachments — 12 September 2026

Telegram photos, image files and PDF documents are accepted; PR #22 is deployed at application `eb501b3c4fdf0bf1e1b0743c2b3772c0101225b3` with a passing health check. Images are read by the isolated media specialist (issue #27 phase 2, PR #33, v0.3.2 deployed at `10a2716`): the coordinator sees a note with a per-turn attachment ID and calls `media_delegate`; only the child model input carries `image_url` parts, and persisted history, checkpoints, traces and memory sources keep no bytes. Extractions are stored as owner-scoped sources; see [media processing](docs/media-specialist.md). PDF text is extracted in-process with `unpdf`, stored in the existing `research_sources` table and read with the new read-only `source_read(id,offset?)` tool, which also works for earlier `web_read` sources. No migration or Compose change was required. Real-photo and real-PDF behavior with the production model has not been checked yet. Scanned PDFs are reported as unreadable rather than OCRed. See [journey 07](docs/journey/07-attachments.md).

## Current operating snapshot — 9 September 2026

The last manually deployed application fix is `0ef13bc` (empty model response recovery). Nine exact LinkedIn saved postings were imported on 8 September, making 31 roles, all saved/unapplied; the preparation Sheet was synced. Existing assessments were retained. See [model response recovery](docs/model-response-recovery.md). Earlier 22-role counts above are historical.

Cloud development uses the connected GitHub environment. Main changes now have a release workflow and a manual bounded diagnostics workflow; see [cloud development](docs/cloud-development.md) for setup verification and limits. Deployment authority belongs to GitHub Actions, not the personal-assistant runtime: this is distinct from the deferred runtime self-deployment capability. Model, speech and Google credentials remain on the server. Automated releases refuse database/Compose changes and active runtime work. Cloud tasks must verify release results before claiming the bot is live.

## Job-alignment specialist

See [job alignment](docs/job-alignment.md) for flexible saved-role scopes, versioned background/skill snapshots, assessment validation, report retrieval and recovery. The coordinator handles pending batches and authorized downstream updates; the specialist remains read-only. Preserve current scope IDs when continuing work. Check the merge request/release for deployment status.
