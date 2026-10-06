# Chief development

Read `docs/current-work.md`, `HANDOVER.md`, `docs/portable-development.md`, `docs/cloud-development.md`, and the relevant source before modifying behavior. For an incident, begin with `docs/troubleshooting.md`. Historical incident reports and deferred candidates describe earlier states; current code, exact release evidence and verified production diagnostics take precedence.

## Freshness before exploration or implementation

Before starting any new feature exploration, feasibility research, planning or implementation, run `git status --short --branch` and `git fetch origin`, then record `git rev-parse origin/main`. Use that freshly fetched `origin/main` as the source of truth for integrated capabilities, architecture and work status, even when no code changes are planned. Read its current instructions, handover, work index and relevant source with `git show origin/main:<path>` or in an isolated worktree based on that ref; the existing local branch, checkout documents and earlier chat summaries may be stale.

Repeat this check when resuming after an idle period or context handoff, switching to a different feature, learning that another task merged changes, or whenever you cannot establish that the last fetch is still current. Reconcile relevant upstream changes before making recommendations or declaring a capability missing. Explicitly distinguish integrated main, intentional branch-only work and the verified deployed release; main alone does not prove production state.

Fetching does not authorize resetting, cleaning, pulling into or overwriting a dirty/shared checkout. Preserve local work and use an isolated branch/worktree for new changes. If fetching fails, report that remote freshness is unverified, identify the last known SHA when available, and qualify conclusions rather than silently treating local files as current. See [portable development](docs/portable-development.md#refresh-before-each-task).

## Commands

Node 22. `npm ci`, `npm run check`, `npm run build`, `npm run format:check`. Tests use PGlite and mocked integrations; production credentials are unnecessary. Use Prettier on changed files. `npm run smoke:runtime` is paid and must not be run as a routine test. Paid evals remain deferred, except `npm run eval:picker` (about $0.04, run by hand after changing `config/tool-picker.json`; record results in the journal).

## Architecture

`src/telegram.ts` is the client; `agent.ts` manages conversations; `custom-agent.ts` runs the loop; `model.ts` calls OpenRouter. `context.ts`, `record-context.ts`, `execution.ts`, and `work.ts` handle context and durable work. Tools run through owner-scoped `tools.ts` and Zod `protocol.ts`. Read the domain module before changing a tool. `answer.ts` defines optional presentation data; `telegram-views.ts` owns read-only callback state/delivery and `telegram-view-render.ts` reads saved records. Views must never invoke the model or authorize an action. `alignment.ts` manages frozen job-alignment scopes and reports; `agents.ts` runs `agent_run`: Chief coordinates and typed plugin agents (the bundled `plugins/core` domain agents and any enabled package) do domain work, see docs/agents.md; `research.ts` runs isolated read-only specialists; `media.ts` delegates image and document reading to that runner; `attachments.ts` handles Telegram file intake. No production Hermes dependency.

`canvases.ts`/`canvas-schema.ts` own versioned canvas storage and tools. `miniapp.ts`/`miniapp-auth.ts` expose authenticated read-only APIs; `miniapp-ui.ts` is browser code compiled by npm test/build, with static files in web/. Validate owner scope on every read and Telegram initData server-side. Preserve immutable revisions, request-key idempotency and base-revision conflicts. See docs/canvases.md and the reviewed additive deployment procedure in docs/miniapp-deployment.md. Do not add public writes or model-generated executable UI.

Transport routing lives in `delivery-routing.ts` and `telegram-topics.ts`; `telegram-feeds.ts` records sent source identities and supplies bounded reference context. One owner conversation/memory is shared across topics, with thread-aware FIFO boundaries and delivery fences. Task origin and destination are host authority; model answers cannot set them. `feed_read` and `conversation_read(inputId)` are owner-scoped reads. `HistoryStore` atomically binds original input IDs to stored user-message UUIDs; preserve that binding when changing history projection or supersession. Routine and ordinary work outboxes retain uncertain sends for inspection. See [topic contracts and migration 022](docs/telegram-topics.md).

## Product and safety constraints

- General personal assistant; job preparation is one domain.
- Preserve exact user-selected target records throughout research. Do not invent postings, user experience, evidence or completion claims.
- Telegram phone delivery context guides model-written prose. Do not impose fixed templates or replace answers with ledger summaries.
- Gmail remains read-only. Calendar queries and button-approved creation of primary-calendar events (timed or all-day, any length) are supported; preserve the explicit Telegram confirmation boundary. Do not add email sending, invitations or applications.
- Library (NLB/OverDrive): the agent never downloads, returns, renews or fulfils a book, never solves CAPTCHAs or enters a card PIN, and every account write must go behind a Telegram approval card; the only permitted unattended request is the identity re-mint. `src/library-routes.ts` is the complete route inventory and the boundary test must keep passing.
- Preserve owner scoping, tool validation, approvals, private skill versioning, cancellation and uncertain-write handling.
- Do not add dollar caps. Keep existing model/provider price filters and time/model/tool allocations unless asked to change them.
- No data reset, automatic resumption of paused tasks, paid infrastructure, runtime shell access, self-deployment, subagents or deferred eval migration without a specific request.
- No secrets in source, examples, logs, artifacts or PRs. Production runs on one AWS Lightsail VM in Singapore; its `.env` stays on that host. See [Lightsail host and private logs](docs/lightsail.md).
- Change the main OpenRouter model through `config/model-policy.json` and the normal reviewed PR/release path; do not ask the owner to edit production `.env` for an ordinary model switch. Keep provider price ceilings intact and verify the effective model from a post-release run. See [model selection](docs/deployment.md#changing-the-production-model-through-a-release).

## Cloud work and release

Follow [the shared cloud-agent workflow](docs/cloud-agent-workflow.md) and [independent review contract](REVIEW.md). Check actual session capabilities early; classify deployment prerequisites before coding. After merging, use `npm run release:status -- FULL_MERGE_SHA` and watch the exact release. A sleeping agent's promise to watch later is not completion.

Cloud/local capability parity is a standing owner priority. Cloud tasks should progressively gain the ability to inspect useful private traces, reproduce incidents, implement and evaluate fixes, and ship verified releases without the Mac. Treat current access gaps as engineering work to close where practical, not permanent product restrictions. Prefer shared tooling usable from both environments, scoped authenticated access and explicit release controls; do not copy unrestricted production credentials into cloud tasks. When proposing work, identify relevant remaining gaps and opportunities to close them.

The user permits merging passing ordinary changes and deploying them. Keep changes reviewable in a PR, wait for checks, and merge when the requested task is complete. Never merge the deferred `feature/runtime-evaluations` branch incidentally. If GitHub mutation credentials are unavailable, open the PR through the cloud task UI and clearly report that it needs merging.

A push/merge to `main` triggers `checks`, then `release`. A pushed feature branch is NOT live. Watch the release result and report deployed SHA, health, tests and limitations. Production releases refuse active runtime work and database/Compose changes. Follow `docs/cloud-development.md` for these cases; never bypass the restriction or claim deployment succeeded from CI alone.

Run `npm run doctor:cloud` early when a task needs GitHub or production access; report missing capabilities rather than discovering them only after implementation.

For runtime failures, first read the sanitized production logs with `npm run logs:cloudwatch` using the private log-reader identity from your environment (see [docs/lightsail.md](docs/lightsail.md#reading-logs)). Never run it in GitHub Actions, because this repository is public. The `production-diagnostics` workflow is guarded to private repositories and does not run while the repository is public. Never invent production findings when access is unavailable. Local browser sessions and SSH credentials are not inherited by cloud tasks.

## Required independent review loop

For each implemented feature or runtime behavior change:

1. Complete the implementation and relevant tests, push a reviewable branch, and open a pull/merge request.
2. Spawn an independent reviewer subagent using the most capable model family available in the current environment (currently GPT-6 Astra when available). Explicitly select that model when the tooling allows it. Give the reviewer the requirements, MR URL, base and exact head SHA, repository instructions and relevant checks. The reviewer must inspect the actual diff and may run tests; it must not implement the change it is reviewing.
3. Require an explicit APPROVE or REQUEST CHANGES verdict with concrete findings and validation limits. Record the model, reviewed SHA and outcome on the MR. CI success alone is not reviewer approval.
4. If changes are required, fix them, rerun affected checks, push, and ask the independent reviewer to review the updated head. Repeat until approval. Do not bypass unresolved findings or treat a review of an older revision as approval of changed code.
5. Merge only when the current head has independent approval and required checks pass. Then follow the normal release workflow and verify the exact deployed SHA and health. Related foundation fixes must be incorporated and reviewed before releasing a dependent feature.

For the owned fixed Python coding squad, the owner-authorized automatic workflow accepts the configured, owner-selected reviewer as its independent review. This exception requires separate coder/reviewer contexts, read-only review tools, complete approved requirements, actual passing sandbox checks, a matching encrypted host reviewer-call journal and exact reviewed-artifact/published Git-tree identity. The approval is bound to the published head; any changed candidate receives fresh squad review. Trusted exact-head CI and Devin plus readable MR feedback remain separate gates. There is no additional final model review for an unchanged artifact. Protected infrastructure, credential, permission and runtime-control paths require explicit review/operations and cannot auto-merge. This exception does not change the most-capable independent reviewer requirement for development outside that owned runtime. See [coding automation](docs/coding-automation.md).

The reviewer should remain independent of implementation. Findings can be discussed with evidence; approval must reflect the final code rather than a promise to fix it later. If subagent tools or a suitable reviewer model are unavailable, report the limitation and leave the MR ready for independent review; do not silently self-approve. This workflow does not authorize merging unrelated checkpoints, changing production permissions, or running paid model evaluations.

## Development journal

All future versioned releases increment only the patch component (including new features), unless the owner explicitly changes this policy. Preserve existing immutable tags. See docs/releases.md.

For every meaningful application change, integration, incident, architectural decision or experiment, add or update `docs/journey` in the same work using [its template](docs/journey/TEMPLATE.md). Small related changes can be dated follow-ups. Explain the preceding iteration, the new observation/requirement, the change and remaining limitations; link related entries so the record shows how decisions evolved. Keep the chronological index and relevant topic paths in [the journal README](docs/journey/README.md) current; preserve existing filenames and order the index by work dates, not entry numbers.

Label user/operator reports, synthetic tests, measured observations, hypotheses and deferred work explicitly. Measurements need dates/windows, units, sample sizes/denominators, workload/model/configuration and missing-accounting limits where relevant. Do not infer API savings from storage measurements, semantic quality from passing tests, or production acceptance from startup health. Link architecture/runbooks rather than duplicating procedures. Never copy private conversations, production traces, user records, credentials or personal motivations into the journal.

Close the journal entry when review and deployment status changes: append dated evidence for the PR, approved head, exact deployed SHA, successful release and health/diagnostics, plus the published version/tag when present. Record separate operator migration/install verification when required. Update stale candidate status after verification while preserving dated failures and review/fix/re-review history. Merge, CI success or a prepared package version alone does not establish release. If work is deferred or release verification is unavailable, record the exact boundary and next step instead.

## Portable checkout and concurrent development

- GitHub main is the integrated source of truth; the latest successful release SHA identifies production. Fetch origin and inspect status before work. Preserve other people's uncommitted changes; use an isolated branch/worktree for unrelated tasks. Never reset or clean a shared checkout to make it convenient.
- Current work and checkpoint branches are indexed in docs/current-work.md. Claim a bounded task in a GitHub issue/PR when collaboration requires it; use draft PRs for work in progress. A checkpoint is not a tested release. Push resumable work with exact remaining checks instead of leaving the only copy on one laptop.
- Mocked tests need no .env or external account. Optional local integration credentials belong in an ignored .env with owner-only permissions. Never copy production tokens or the deployment key into a development checkout. Use a distinct test bot to avoid competing production polling.
- Commit with the human developer's own git identity, as configured on their machine. Coding agents never author commits as themselves and add no `Co-Authored-By` trailers. In a cloud session, check `git config user.name` and `user.email` before the first commit, and ask the developer if they are unset or show an agent.
- Each new machine needs its own authorized GitHub login. Run doctor:cloud to inspect capabilities; repository read access alone does not prove merge or Actions permission. Use the shared GitHub deployment path from local and cloud tasks alike.
- Before merging, incorporate relevant main changes, rerun affected checks and verify the PR's current head. Serialize releases and retry a skipped/stale or busy release through the documented workflow; do not cancel user runtime work.
- Update docs/current-work.md, the relevant handover and docs/journey when status changes. Put release notes and immutable semantic-version tags on verified shipped milestones per docs/releases.md. Tags do not trigger deployment and must never be moved to disguise a failed release.

## Documentation scope

Keep repository documentation specific to application behavior, architecture, technical decisions, incidents, tests and operations. Exclude the owner’s career goals, interview preparation narratives, portfolio positioning and personal motivations for technology choices. Conversation alignment is not repository content. Apply this rule to README, handovers, journal entries, templates and pending task documents.

## Capability plugins

Read docs/plugins.md before changing plugin behavior. plugins/registry.json is reviewed host configuration; packages cannot grant themselves tools. Keep content pins, strict text-only validation, owner-scoped task snapshots, approved private skill versions and host evidence/permission checks. New supported public-research agents should use plugin definitions rather than new loop branches. Export only package files, never owner data or host configuration. Plugin edits require updated hashes, tests and the same independent review/release loop as code; no automatic remote installation.

## Authoritative history storage

Read docs/authoritative-storage.md before changing history/checkpoints. Use HistoryStore, not the legacy conversations.history/runtime_runs.messages arrays (empty after migration 012). Preserve immutable owner-scoped payloads, ordered references, compare-and-append counters and stable conversation IDs. Do not copy full history into checkpoints or provenance records. Run/call journals still preserve incomplete/uncertain actions. Do not prune data without tracing active-task/evidence/memory dependencies. An old-image rollback requires the documented legacy rehydration; app-only deployment cannot apply migration 012.
