# Chief development

## Workflow

This repository follows the [a-stack engineering workflow](https://github.com/akhilvuputuri/a-stack/blob/workflow--v0.1.1/plugins/workflow/CORE.md), pinned to marketplace ref `workflow--v0.1.1`. Claude Code loads it through the `workflow@a-stack` plugin pinned in `.claude/settings.json`. Its core rules cover freshness, capabilities, independent review, delivery, evidence, records and hygiene, and its skills cover `preflight`, `independent-review`, `ship`, `journal`, `incident` and `experiment`. For Codex, run `codex plugin marketplace add akhilvuputuri/a-stack@workflow--v0.1.1` and `codex plugin add workflow@a-stack` once; `.codex/config.toml` keeps it enabled here. The Codex plugin has no hooks, so the rules below are Codex's always-on workflow. Other agents should read the linked CORE.md at that tag before starting work. The bindings below supply this repository's specifics and win where they are more specific.

Non-negotiable even without the plugin:

- Fetch origin and read from `origin/main` before exploring or changing anything, and again whenever you cannot establish that the last fetch is still current. Never reset or clean a shared or dirty checkout. Work on a branch or worktree.
- Every change gets an independent reviewer that did not write it, with an explicit APPROVE or REQUEST CHANGES for the exact head SHA. Re-review after every fix.
- A task ends at verified delivery (exact deployed SHA and evidence) or a named blocker.
- Label claims as reported, tested, measured, hypothesis or deferred. Never invent results.
- Commit as the human developer's git identity, with no agent author or `Co-Authored-By` trailer. If `git config user.name`/`user.email` is unset or shows an agent (common in cloud sessions), stop and ask the developer; never set an identity yourself. Keep secrets and private data out of the repository, PRs and logs.

### Workflow bindings

- **Read first, from `origin/main`:** `docs/current-work.md`, `HANDOVER.md`, `docs/portable-development.md`, `docs/cloud-development.md` and the relevant source. For an incident, start with `docs/troubleshooting.md`. Historical incident reports and deferred candidates describe earlier states. Current code, exact release evidence and verified production diagnostics take precedence.
- **Checks:** Node 22. `npm ci`, `npm run check`, `npm run build`, `npm run format:check`. Use Prettier on changed files. Tests use PGlite and mocked integrations, so production credentials are unnecessary.
  - Do not run routinely: `npm run smoke:runtime` (paid) and other paid evals, which remain deferred.
  - Exception: run `npm run eval:picker` (about $0.04) by hand after changing `config/tool-picker.json`, and record the result in the journal.
- **Reviewer:** the most capable model available. That is GPT-6 Astra where available; Opus 5.5 is accepted in Claude sessions. Select it explicitly.
  - Devin Review runs automatically when a PR is ready and on each push. It is a second signal only.
  - The reviewer contract is [REVIEW.md](REVIEW.md).
  - Related foundation fixes must be incorporated and reviewed before a dependent feature is released.
- **Merge authority:** the owner permits merging passing, requested, ordinary changes once the current head is independently approved, via `gh pr merge N --squash --match-head-commit SHA`.
  - Never merge the deferred `feature/runtime-evaluations` branch incidentally.
  - If GitHub mutation credentials are unavailable, open the PR through the cloud task UI and report that it needs merging.
- **Release:** a push or merge to `main` triggers `checks`, then `release`. A pushed feature branch is not live.
  - Verify with `npm run release:status -- FULL_MERGE_SHA` and the watched release run. Report the deployed SHA, health, tests and limitations.
  - Production releases refuse to run during active runtime work, and refuse database or Compose changes. Those need the reviewed operator procedure in [docs/cloud-development.md](docs/cloud-development.md). Never bypass the guard. Retry a busy release when the runtime is idle, and never cancel user runtime work.
  - Versioning: patch component only, including features, unless the owner changes the policy. Tags are immutable and do not trigger deployment. See [docs/releases.md](docs/releases.md).
- **Records:**
  - Journal: [docs/journey](docs/journey/README.md), using its [template](docs/journey/TEMPLATE.md). Keep the chronological index and the topic paths current.
  - Work index: `docs/current-work.md`. Handover: `HANDOVER.md`. Release notes: `docs/releases.md`.
  - Meaningful coding-harness changes also update [the coding-agent learning guide](docs/journey/coding-agent-lessons.md) in the same PR.
- **Diagnostics:**
  - Run `npm run doctor:cloud` early whenever a task needs GitHub or production access.
  - For runtime failures, first read the sanitized production logs with `npm run logs:cloudwatch`, using the private log-reader identity from your environment ([docs/lightsail.md](docs/lightsail.md#reading-logs)). Never run it in GitHub Actions, because this repository is public.
  - The `production-diagnostics` workflow is guarded to private repositories.
  - Cloud tasks do not inherit local browser sessions or SSH credentials. See [the cloud-agent workflow](docs/cloud-agent-workflow.md).
- **Chief's sandboxed coding runtimes** (Pi and the Python squad) follow their host instructions, which take precedence over the general rules in this file where they differ (pinned base, no publication, merge or deploy). They do not need to fetch CORE.md or load workflow skills. The inline rules above, REVIEW.md and the repository docs are sufficient for them.
- **Exceptions:**
  - **Owned coding squad:** the owned, fixed Python coding squad accepts its configured owner-selected reviewer (see below).
  - **Stricter documentation scope:** see below.

## Architecture

`src/telegram.ts` is the client; `agent.ts` manages conversations; `custom-agent.ts` runs the loop; `model.ts` calls OpenRouter. `context.ts`, `record-context.ts`, `execution.ts`, and `work.ts` handle context and durable work. Tools run through owner-scoped `tools.ts` and Zod `protocol.ts`. Read the domain module before changing a tool. `answer.ts` defines optional presentation data; `telegram-views.ts` owns read-only callback state/delivery and `telegram-view-render.ts` reads saved records. Views must never invoke the model or authorize an action. `alignment.ts` manages frozen job-alignment scopes and reports; `agents.ts` runs `agent_run`: Chief coordinates and typed plugin agents (the bundled `plugins/core` domain agents and any enabled package) do domain work, see docs/agents.md; `research.ts` runs isolated read-only specialists; `media.ts` delegates image and document reading to that runner; `attachments.ts` handles Telegram file intake. No production Hermes dependency.

`canvases.ts`/`canvas-schema.ts` own versioned canvas storage and tools. `miniapp.ts`/`miniapp-auth.ts` expose authenticated read-only APIs; `miniapp-ui.ts` is browser code compiled by npm test/build, with static files in web/. Validate owner scope on every read and Telegram initData server-side. Preserve immutable revisions, request-key idempotency and base-revision conflicts. See docs/canvases.md and the reviewed additive deployment procedure in docs/miniapp-deployment.md. Do not add public writes or model-generated executable UI.

Main is an explicit Telegram topic alongside News/Coding/Markets; All remains the client aggregate. Logical `general` destinations map to Main. Persist pending input before any topic-resolution wait. Preserve guarded text/voice/approval sends across Main lookup and fallback, and use `sentThread` rather than intended destination for sent receipts; intentional root fallback must bypass default Main routing. See [journal 65](docs/journey/65-main-conversation-topic.md).

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

## Cloud parity

Cloud/local capability parity is a standing owner priority. Cloud tasks should progressively gain the ability to inspect useful private traces, reproduce incidents, implement and evaluate fixes, and ship verified releases without the Mac. Treat current access gaps as engineering work to close where practical, not permanent product restrictions. Prefer shared tooling usable from both environments, scoped authenticated access and explicit release controls; do not copy unrestricted production credentials into cloud tasks. When proposing work, identify relevant remaining gaps and opportunities to close them.

## Owned coding squad review exception

For the owned fixed Python coding squad, the owner-authorized automatic workflow accepts the configured, owner-selected reviewer as its independent review. This exception requires separate coder/reviewer contexts, read-only review tools, complete approved requirements, actual passing sandbox checks, a matching encrypted host reviewer-call journal and exact reviewed-artifact/published Git-tree identity. The approval is bound to the published head; any changed candidate receives fresh squad review. Trusted exact-head CI and Devin plus readable MR feedback remain separate gates. There is no additional final model review for an unchanged artifact. Protected infrastructure, credential, permission and runtime-control paths require explicit review/operations and cannot auto-merge. This exception does not change the most-capable independent reviewer requirement for development outside that owned runtime. See [coding automation](docs/coding-automation.md).

## Local and concurrent development

- Mocked tests need no .env or external account. Optional local integration credentials belong in an ignored .env with owner-only permissions. Never copy production tokens or the deployment key into a development checkout. Use a distinct test bot to avoid competing production polling.
- Each new machine needs its own authorized GitHub login. Repository read access alone does not prove merge or Actions permission. Use the shared GitHub deployment path from local and cloud tasks alike.
- Current work and checkpoint branches are indexed in docs/current-work.md. Use draft PRs for work in progress; a checkpoint is not a tested release. Push resumable work with exact remaining checks instead of leaving the only copy on one laptop.

## Documentation scope

Keep repository documentation specific to application behavior, architecture, technical decisions, incidents, tests and operations. Exclude the owner’s career goals, interview preparation narratives, portfolio positioning and personal motivations for technology choices. Conversation alignment is not repository content. Apply this rule to README, handovers, journal entries, templates and pending task documents.

## Capability plugins

Read docs/plugins.md before changing plugin behavior. plugins/registry.json is reviewed host configuration; packages cannot grant themselves tools. Keep content pins, strict text-only validation, owner-scoped task snapshots, approved private skill versions and host evidence/permission checks. New supported public-research agents should use plugin definitions rather than new loop branches. Export only package files, never owner data or host configuration. Plugin edits require updated hashes, tests and the same independent review/release loop as code; no automatic remote installation.

## Authoritative history storage

Read docs/authoritative-storage.md before changing history/checkpoints. Use HistoryStore, not the legacy conversations.history/runtime_runs.messages arrays (empty after migration 012). Preserve immutable owner-scoped payloads, ordered references, compare-and-append counters and stable conversation IDs. Do not copy full history into checkpoints or provenance records. Run/call journals still preserve incomplete/uncertain actions. Do not prune data without tracing active-task/evidence/memory dependencies. An old-image rollback requires the documented legacy rehydration; app-only deployment cannot apply migration 012.
