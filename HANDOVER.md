# Personal-agent handover

Scheduled independent agent routines shipped in v0.3.15 for issue #56 (PRs #58/#59, migration 017, deployed `c1f8e7088676d4ee3d041993d5e08412e4c73a70`). Read [the extension contract and migration runbook](docs/scheduled-routines.md) before adding domain schedules; existing reminders remain separate.

Released [v0.3.10](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.10): [PR #44](https://github.com/akhilvuputuri/companion-agent/pull/44) merged persistent preparation evidence chains at `672021f2afcea620224fd9f7ce7ccfdc53b9ba89`, whose tree matches Astra-approved `b01a9226c37ea73fa0cb3140fdfb43e11fc08772`. Required checks passed. The reviewed operator rollout succeeded on 14 September 2026: exact deployed SHA verified, startup healthy and migration 15 installed. Separate read-only verification found all three existing preparation tasks retained with empty evidence chains and no active runs. The [standard release workflow](https://github.com/akhilvuputuri/companion-agent/actions/runs/34773911229) passed, and the immutable v0.3.10 tag resolves to the verified deployed SHA. See the [contract](docs/preparation.md), [rollout](docs/preparation-rollout.md) and [review history](docs/journey/21-preparation-chain.md). This change does not authorize backfilling links, reanalyzing roles or resuming paused tasks.

Previous published milestone, verified before the preparation rollout on 14 September 2026: [v0.3.9](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.9), deployed SHA `9c6335be09582432d9bf7c4a475c90f9b5e9272a`. The [release workflow](https://github.com/akhilvuputuri/companion-agent/actions/runs/34764417365) and [subsequent diagnostics](https://github.com/akhilvuputuri/companion-agent/actions/runs/34769892493) succeeded at that SHA. The [engineering journal](docs/journey/README.md) connects the release history, incidents and outstanding evidence. The observable-memory and evaluation checkpoints are not deployed; real Telegram checkpoint-steering acceptance remains separate from startup and mocked checks.

Checkpoint steering foundation, released in v0.3.9 ([PR #42](https://github.com/akhilvuputuri/companion-agent/pull/42)). Ordinary input waits for an in-flight model/tool result, then joins the same unbound run; task-bound work pauses for handoff. Read [the steering guide](docs/checkpoint-steering.md) for ordered photo/PDF/voice preparation, pending/sent delivery projection, cancellation/reset boundaries and migration014. The completed one-time rollout used baseline v0.3.8 (`d0e33365c7cec7b7cb1eb64c22de7c09d5d9a314`); ordinary later code releases use the installed schema. Verify current server RELEASE and [published deployment evidence](https://github.com/akhilvuputuri/companion-agent/releases) when starting later work.

The [rolling-conversation guide](docs/rolling-conversation.md) remains the v0.3.8 foundation and records its earlier interrupt-and-replace behavior. Earlier handover snapshots below are historical. Do not reset data, cancel active user work or run paid evaluations for this rollout.

Start with [current work](docs/current-work.md) and [portable development](docs/portable-development.md). The unfinished observable-memory code is now on GitHub at `checkpoint/observable-memory` (`2a85839`), not just on the original Mac. It is not deployed. Read its checkpoint before resuming. GitHub main is integrated source; successful release SHA is deployed source. See [versions and release notes](docs/releases.md).

Historical operating snapshot, recorded 9 September 2026. Read [cloud development and deployment](docs/cloud-development.md) and [agent instructions](AGENTS.md) for current operating procedures. The owned TypeScript runtime is deployed on the existing DigitalOcean server. PR #7 introduced the cutover (`f1664bb`); consult server `RELEASE` for subsequent revisions. At that check the gateway and Postgres were healthy, and the Hermes container had been removed without deleting its volume.

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

Initial task allocation: 15 minutes active execution, 40 model calls, 100 tool calls. `/continue` adds capacity without resetting completed steps. `/cancel` (or `/workcancel`) aborts the foreground model request; `/cancel <id>` selects a background job. It and prevents later dispatch. Already-started tools can finish and remain recorded.

Migration `006_runtime.sql` archives old histories, seeds text-only context and pauses active tasks once. Do not automatically resume the 22-role request or erase its steps. Restart recovery conservatively pauses work and marks started writes uncertain. Uncertain writes require inspection before further writes. See [recovery](docs/reliable-execution.md).

## Verification and next work

Run `npm run check`, `npm run build`, `npm run format:check`. `npm run smoke:runtime` makes bounded paid Sol calls against a synthetic PGlite database, never the production user's records. Check deployment status in `docs/verification.md` and server `RELEASE`.

Improve from actual daily conversations: context selection, memory retrieval, deduplication, tracing and voice responsiveness. Realtime voice, parallel specialist teams, sandbox execution and runtime self-deployment remain later milestones. The authenticated read-only Mini App and persistent canvases shipped in v0.3.5; see [journal 14](docs/journey/14-persistent-canvases.md) for verification and remaining live acceptance checks.

The previous detailed Hermes handover is retained under `docs/history/hermes-handover.md` as historical context. Its architecture and model defaults are obsolete. Do not deploy the historical bridge as a prerequisite.

## Live cutover results

Historical cutover result (superseded by the selective reset below): all 22 roles remained, and task `aaf59b66-dc61-4c1c-8afa-bdc50d8ff850` was paused at revision 3 with 26 done and 21 pending steps. That task is now archived, not active. Live Sol, Telegram bot authentication, read-only Gmail/Calendar, both three-tab Sheet mirrors and an ElevenLabs speech/transcription round trip passed. No automatic resumption was performed. At cutover a fresh user-sent Telegram voice note remained a hands-on acceptance check. The later [foundation/voice account](docs/journey/19-foundation-and-voice.md) records user-reported Telegram voice acceptance separately from the recorded server round trip; it does not establish latency or quality benchmarks.

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

Telegram photos, image files and PDF documents are accepted; PR #22 is deployed at application `eb501b3c4fdf0bf1e1b0743c2b3772c0101225b3` with a passing health check. Images are read by the isolated media specialist (issue #27 phase 2, PR #33, v0.3.2 deployed at `10a2716`): the coordinator sees a note with a per-turn attachment ID and calls `media_delegate`; only the child model input carries `image_url` parts, and persisted history, checkpoints, traces and memory sources keep no bytes. Extractions are stored as owner-scoped sources; see [media processing](docs/media-specialist.md). PDF text is extracted in-process with `unpdf`, stored in the existing `research_sources` table and read with the new read-only `source_read(id,offset?)` tool, which also works for earlier `web_read` sources. No migration or Compose change was required. Real-photo and real-PDF behavior were still live acceptance checks at the attachments release. Subsequent first use routed a photo through the media child and exposed a pre-model PDF failure; [journal 07](docs/journey/07-attachments.md) records that incident, the v0.3.4 fix and its remaining verification limits. Scanned PDFs are reported as unreadable rather than OCRed. See [journey 07](docs/journey/07-attachments.md).

## Historical operating snapshot — 9 September 2026

At that snapshot the last manually deployed application fix was `0ef13bc` (empty model response recovery). Nine exact LinkedIn saved postings were imported on 8 September, making 31 roles, all saved/unapplied; the preparation Sheet was synced. Existing assessments were retained. See [model response recovery](docs/model-response-recovery.md). Earlier 22-role counts above are historical.

Cloud development uses the connected GitHub environment. Main changes now have a release workflow and a manual bounded diagnostics workflow; see [cloud development](docs/cloud-development.md) for setup verification and limits. Deployment authority belongs to GitHub Actions, not the personal-assistant runtime: this is distinct from the deferred runtime self-deployment capability. Model, speech and Google credentials remain on the server. Automated releases refuse database/Compose changes and active runtime work. Cloud tasks must verify release results before claiming the bot is live.

## Job-alignment specialist

See [job alignment](docs/job-alignment.md) for flexible saved-role scopes, versioned background/skill snapshots, assessment validation, report retrieval and recovery. The coordinator handles pending batches and authorized downstream updates; the specialist remains read-only. Preserve current scope IDs when continuing work. PR #30 shipped [v0.3.0](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.0) at `1c625cbe9dd56292347970f257513cfc7dcd9ada`; the [journal closure](docs/journey/09-job-alignment.md) links independent review and deployment/health evidence.

## Mini App hosting decision — 13 September 2026

Use the existing DigitalOcean server and a free sslip.io hostname; AWS migration stays separate. The [HTTPS guide](docs/miniapp-deployment.md) covers the Caddy host-service configuration, reviewed operator install and verification. The initial [v0.3.3](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.3) HTTPS milestone served a holding response and passed the recorded TLS/route checks. Canvas authentication, storage, frontend and tools subsequently shipped in v0.3.5; [journal 13](docs/journey/13-miniapp-https.md) preserves the hosting evidence.

## Persistent canvases — released 13 September 2026

PR #36 shipped [v0.3.5](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.5) at `677683a043e9f16d4a4bd4dc680a78b87ae9b639`, implementing the authenticated read-only Mini App, versioned model-authored canvases, role browsing and trace links. See [canvases](docs/canvases.md) and the [reviewed rollout](docs/miniapp-deployment.md). Additive migration011 and Compose/host ingress changes were installed through the reviewed operator procedure; exact release and health verification passed. No credentials move to the frontend. Real signed Telegram launch and model-generated production-canvas acceptance remain separate; see [journal 14](docs/journey/14-persistent-canvases.md).

## Portable plugins — released v0.3.6, issue #37

PR #38 shipped [v0.3.6](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.6) at `20564401c5130f79e2f90a8c802c32298c6c502e`. It packages general research and adds declarative import/export, a host registry, generic delegation, lazy skills and durable definition pins. See [plugin guide](docs/plugins.md). No migration/Compose change. Job alignment/media and external vendor-format adapters remain separate; the product issue stays open. The [journal closure](docs/journey/15-portable-plugins.md) records exact-head approval, passing checks and verified release. Wider vendor compatibility remains future work.

## Authoritative message storage — released v0.3.7

PR #39 shipped [v0.3.7](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.7) at `099e7478ff5d33bb240740406f822e3a01e7a580`. It normalizes repeated message payloads, appends checkpoint deltas and adds bounded history loading plus owner-scoped conversation search/read. See [storage architecture and rollout](docs/authoritative-storage.md). Migration012 and Compose were installed through the reviewed operator procedure; old-image rollback still requires legacy rehydration. No data reset or automatic trace purge; memory/wiki work remains subsequent. The [journal closure](docs/journey/16-authoritative-storage.md) records review/release evidence and measured storage reduction. Rolling context and independent jobs then shipped in v0.3.8, followed by v0.3.9 steering above; none completes the deferred observable-memory checkpoint.
