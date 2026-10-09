# Coding field-local summary repair — candidate, 9 October 2026

PRs #197–199 shipped compatible provider/summary foundations through v0.3.56 (`63a37fea`), with exact receipt and current health verified. Python 0.1.8 completed scoped planning and recovered provider empties, but a later corrective revision paused after two invalid `nextAction` summaries. Global activation is withdrawn. Python 0.1.9 proposes repairing only invalid notebook fields while retaining valid evidence exactly, using the same bounded recovery/allocation. Review/checks/image/new live acceptance remain pending; default remains 0.1.6 and old jobs are unchanged. See [journal 75](journey/75-coding-summary-repair.md).

# Coding approval brief — released v0.3.53, 9 October 2026

[PR #194](https://github.com/akhilvuputuri/chief-agent/pull/194)/[PR #195](https://github.com/akhilvuputuri/chief-agent/pull/195) passed exact-head Astra review, 996-test PR/main checks and container smoke. Foundation/activation exact releases and separate current health/configuration reads verified v0.3.53 at `ad9e7553d897ec93c6708cf51e5598cc8ab0fd3d`, using the independently verified Python 0.1.6 worker for new jobs. Briefs guide concise complete scope and return actionable revision rather than truncation; delivery avoids duplicate summaries. Near-limit scopes can still span Telegram parts. Existing jobs/plans retain their pins; no job was resumed or paid trial run. See [journal closure](journey/72-coding-approval-brief.md#release-closure--9-october-2026). [Reviewed efficiency research](coding-model-efficiency.md) proposes independent accepted-change/cost comparisons; the inference adapter and actual coding-quality/cost benefits remain unmeasured.

Coding-agent learning record: [cumulative lessons](journey/coding-agent-lessons.md) connects the released iterations and distinguishes verified mechanisms from unmeasured quality/cost improvements. Future meaningful harness changes update it alongside the detailed journal.

# Coding progress and recovery — released v0.3.51

[v0.3.51](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.51) is verified at `2bc5ea36a11014c2515de171f19d5e1f5471bfe4`. New jobs use the independently verified Python 0.1.5 image and `harnessVersion: 2` for all six progress/recovery improvements. Exact-head foundation/pin reviews, 992-test PR/main checks and container smoke, both exact release receipts and separate production configuration/gateway/Postgres reads passed. Models, effort, price filters and shared allocations are unchanged. Both old jobs remain paused on their original pins; ordinary resume does not upgrade them. No paid/live trajectory acceptance was run. See [journal 71 closure](journey/71-coding-progress-recovery.md#release-closure--8-october-2026).

# Coding allocations — released v0.3.49

[v0.3.49](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.49) is verified at `b44e1cee723ccfdd624152bbea54e7f23b1134d7`. New coding attempts use the public verified Python 0.1.4 image with two hours / 400 model calls / 1,000 tool calls shared by the squad. Foundation/pin independent reviews, PR/main checks, exact release receipt and separate production configuration/gateway/Postgres health passed. Existing paused jobs retain their original image/limits/checkpoints; ordinary resume does not upgrade them. An owner-requested fresh job uses the new defaults. No paid/live coding acceptance ran. See [journal 70](journey/70-coding-allocations.md#release-closure--8-october-2026).

# Public article-link resolution — released v0.3.47

[PR #185](https://github.com/akhilvuputuri/chief-agent/pull/185) shipped shared
link resolution and Reader article/discussion targeting. Independent approval,
full CI, reviewed migration 031/browser installation, the normal release receipt
and separate health verified `df3c08848c268e23f83c82303ecc31615d096ad4`.
One live observed-target save returned Reader ready with a duplicate receipt;
original/publisher provenance and same-key replay passed. Anonymous Reddit access
remains blocked in the measured case; new blocked links need a publisher URL or
future authorized Reddit access. Phone offline/conversational acceptance remain
separate. See [contract](link-resolution.md) and [journal closure](journey/69-link-resolution.md#release-closure--8-october-2026).

# Coding planning continuation — validated fix, delivery tracked

A live planning job stopped after its first valid DeepSeek tool response because the next request retained provider tool-call `index` metadata that Chief’s strict API rejected. The host now accepts that optional integer field and exposes safe, attempt-scoped rejection categories in `coding_status`. The reported job remains paused pending explicit owner resume. No worker-image, model, allocation or permission change. Full local checks and independent implementation review passed. Final revision, hosted checks and exact release evidence are tracked in [PR #183](https://github.com/akhilvuputuri/chief-agent/pull/183). See [journal 68](journey/68-coding-tool-index.md).

# Remote MCP connectors — v0.3.45; Reader activated, 8 October 2026

Reader was activated on verified release `ace4a33d956da1d427ac38b0104ebe6a0278d298`.
The owner-authorized credential was installed directly in the private host environment
through reviewed SSH-stdin operations, with idle/migration/uncertain-write checks
and preserved unrelated settings. Health and owner binding passed. Authenticated
discovery returned exactly the three grants; one public guide and one labelled test
brief reached server `ready`. Cached replays preserved the original receipts. Server-side retries returned the
same submissions with duplicate receipts; zero pending writes remain. No model call or
Telegram send was used for these acceptance checks. Phone **Available offline**,
actual conversational selection and live revocation acceptance remain unverified.

[PR #181](https://github.com/akhilvuputuri/chief-agent/pull/181) shipped the framework
through reviewed migration 030/Compose and verified normal release. OAuth, stdio,
non-idempotent writes and paid picker eval remain separate. See [contract](mcp.md),
[rollout](mcp-deployment.md) and [activation evidence](journey/67-mcp-connectors.md#reader-activation--8-october-2026).

# Coding benchmark pack — offline validation complete

Six runnable Chief seeded component repair fixtures and four pinned public SWE-bench selections are prepared in [the coding benchmark pack](../evals/coding/README.md). Offline source/grader validation, actual local Docker checks and the full repository suite pass. GPT-6 Astra approved the implementation; final-head review, hosted checks and merge/release receipts are tracked in [PR #180](https://github.com/akhilvuputuri/chief-agent/pull/180). Live inference integration, public environment checks and paid trials remain pending. No production coding settings change. See [journal 66](journey/66-coding-benchmarks.md).

# Explicit Main conversation topic — released v0.3.44

[PR #178](https://github.com/akhilvuputuri/chief-agent/pull/178) ships Main beside News, Coding and Markets. Root/All input is persisted first and normalized to Main before execution; default owner sends and logical general destinations use Main. All remains Telegram's combined history. Final GPT-6 Astra review approved `d628ec714be2741fa78e55bf63904452317d2f71`; required hosted full CI and [automatic release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37615771842) passed at merge `e522f5349af2d7be869bb18bcff2ba0327b06e08`. Separate server RELEASE/health, threaded-mode and Main-record checks passed; Telegram accepted one introduction in Main with zero model calls. No schema/Compose/history changes. Owner-client acceptance remains separate. See [contract](telegram-topics.md), [journal 65](journey/65-main-conversation-topic.md) and [v0.3.44](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.44).

# Coding MR automation — enabled v0.3.43

[v0.3.43](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.43) is verified at `60b3ec55f03f0296ef027b413debab61eef7d2f7`: coding and guarded MR feedback/merge automation are on for new jobs. Exact-head Astra/PR/main CI/Devin, repository-only App scope/read verification, exact release and separate current health/effective selector checks passed. Planning/owner confirmation, one independent reviewer loop, protected paths and shared allocations remain intact; legacy/paused jobs retain settings. Zero jobs and no paid/live coding acceptance. See [contract](coding-automation.md) and [journal closure](journey/64-coding-automation.md#automatic-selector-release-closure--7-october-2026).

# Coding diagnostics and models — released v0.3.42; automatic merge pending permission

[v0.3.42](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.42) is verified at `1136126e8a86439aec84b94c27183b1d41d1f4ff`: Telegram role-model preferences and Python 0.1.3 scoped diagnostics are available; coding stays on. The one-review MR repair/merge implementation is integrated, but automatic merge remains off while additional read-only App scopes await owner approval. Models, effort, allocations and price filters are unchanged; zero coding jobs and no paid/live acceptance. See [contract](coding-automation.md) and [journal 64](journey/64-coding-automation.md).

# Coding activation — enabled, 7 October 2026

Coding is **on** at verified production `2273e8c8eb6a81d764bc74c84016f3022750fa80` after the independently approved idle-only operator activation on 7 October. Deployed GitHub installation authentication, scoped CodeBuild project validation, gateway/Postgres health and public worker 401/unknown-path 404 checks passed. The Singapore worker role has no identity policies; the controller has only exact-project operations and exact-worker PassRole. Secrets stay on Chief, source defaults remain off, and jobs stop at a draft PR for owner review/merge. Zero jobs; paid/live plan→confirmation→candidate acceptance remains pending. See [activation evidence](journey/61-coding-squad.md#activation-verified--7-october-2026).

# Owner-defined stock rules — released v0.3.41

"Tell me when…" stock rules ([PR #168](https://github.com/akhilvuputuri/chief-agent/pull/168)) are live at `84149f9`, through reviewed migration 029. Rules for average cost need IBKR connected, which is still pending the owner's consent. Next: the Phase 2c daily digest. See [stock rules](stock-rules.md) and [journal 60](journey/60-stock-rules.md).

# Coding topic / main-channel updates — released v0.3.40

[PR #167](https://github.com/akhilvuputuri/chief-agent/pull/167) shipped [v0.3.40](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.40) at `1975525a7b5dd00b76c803d065cf2847298acbfb`: Updates is renamed Coding in place, preserving its thread/messages. Coding milestones go there; unprompted answers/responsibility findings and coding requirements/questions/terminal results go to General. GPT-6 Astra approved exact head `5c0cc77`; PR/main CI, [exact release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37169850070), separate health/policy and unchanged topic-identity checks passed. No DB/Compose/image change or synthetic message send. Live coding remains off with zero jobs; scoped project/App/auth/ingress configuration is absent, and the `chief` AWS identity check did not succeed. Activation and paid/live coding acceptance remain separate. See [journal closure](journey/63-coding-topic.md#release-closure--4-october-2026).

# Durable invoice gathering — released v0.3.39, on

[PR #160](https://github.com/akhilvuputuri/chief-agent/pull/160) shipped [v0.3.39](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.39) at `3aeafe316aa04c310c8e2f4a651b94a2989a6509`. Chief coordinates exact provider/account/month/source scopes; the gathering agent collects original PDFs, matches recorded clues and verifies source coverage. Private PDF/ZIP downloads, read-only Gmail attachment retrieval and isolated owner browser handoff are enabled. GPT-6 Astra approved exact head `cd5b0633b0508837eaf8a41dbfe69ef72ffe8177` and the one-time operator artifact. Main checks, reviewed migration **028**/browser/ingress install, [normal release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37156340441) and independent SHA/health/access/preservation checks passed on 4 October SGT. Gathering is on; IBKR remains on and coding off. Actual merchant login/invoice acceptance and paid evals have not run. Invoice collection does not automatically change subscription records; price alerts, monthly summaries, responsibility adapters and broader document/website capabilities remain separate. See [contract](gathering.md), [rollout](gathering-deployment.md) and [journal 62](journey/62-gathering-harness.md).

# Three-member coding squad — released v0.3.38, off

[PR #163](https://github.com/akhilvuputuri/chief-agent/pull/163)/[PR #164](https://github.com/akhilvuputuri/chief-agent/pull/164) shipped the fixed Python leader/coder/reviewer squad as [v0.3.38](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.38) at `c0373741b0a0b289e9a245e309940c323ac4ceee`. GPT-6 Astra approved exact implementation/pin heads `52b2e4c`/`8bc9f618`; PR/main Linux CI, reviewed migration 027/operator install, immutable image verification, [exact release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37143007928) and separate health/policy/preservation checks passed. Chief assigns the leader; coder edits and reviewer independently reviews, with changes returned through the leader until exact approval. Separate contexts, restricted tools, typed durable handoffs and owner confirmation preserve authority; shared allocations/price filters are unchanged. OpenRouter uses DeepSeek V4.1 Flash for leader/coder and GPT-6.1 Sol for reviewer. Coding remains off with zero jobs; scoped provider/App/ingress activation and paid/live acceptance remain pending. See [contract](coding-squad.md) and [journal closure](journey/61-coding-squad.md#release-closure--4-october-2026).

# Read-only IBKR holdings and stock lookup — released v0.3.37

IBKR holdings ([PR #152](https://github.com/akhilvuputuri/chief-agent/pull/152)) are installed and **on** at `c3cea89` through reviewed migration 026, with owner-tapped connect and disconnect cards and read-only scope. Owner connection and acceptance are pending. Stock lookup ([PR #161](https://github.com/akhilvuputuri/chief-agent/pull/161)) is deployed at `7e81985`. Next is Phase 2b: general "tell me when…" rules, which need a new additive migration; 027 is now the coding squad. See [IBKR portfolio](ibkr-portfolio.md), [stock rules](stock-rules.md) and journals [59](journey/59-ibkr-portfolio.md) and [60](journey/60-stock-rules.md).

# Conversational coding requirements — released v0.3.36, off

[PR #157](https://github.com/akhilvuputuri/chief-agent/pull/157)/[PR #158](https://github.com/akhilvuputuri/chief-agent/pull/158) enforce plan → owner confirmation → Python implementation without slash commands. Astra approved exact heads `aafecf3` and `140c97d`; PR/main Linux CI passed. The [exact release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37120011881), separate health/policy/preservation checks and immutable [v0.3.36](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.36) verify `67db5e135c99eee85a10416dbe159ce93432eee0`. No DB/Compose change. Coding remains off with zero jobs; provisioning authentication and scoped provider/App/ingress setup are incomplete. No paid/live coding acceptance. See [journal closure](journey/58-coding-requirements.md#release-closure--3-october-2026).

# Python coding runtime — released v0.3.35, off

[PR #154](https://github.com/akhilvuputuri/chief-agent/pull/154) refactored execution into Python; [PR #155](https://github.com/akhilvuputuri/chief-agent/pull/155) pinned the public image with the matching fixed launcher. GPT-6 Astra approved exact heads `e0b0b63cf629544ef41d025fa1eec9efc682f964` and `8b2dac76d1023c0da15a4e9a88816f2dcf8fd111`; PR/main Linux CI passed. The [exact release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37099789621), separate health/deployed-policy/preservation checks and [v0.3.35](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.35) verify `448597a475827c3eb88df5ae3f3697f04a125563`. Chief stays TypeScript; OpenRouter uses DeepSeek V4.1 Flash for coding and the existing reviewer. Coding remains off, zero jobs, no DB/Compose change or paid acceptance. Provider/App/ingress activation remains pending. See [journal closure](journey/57-python-coding-runtime.md#release-closure--3-october-2026).

# Issue 132 — Bill/subscription manual milestone released v0.3.34

[PR #142](https://github.com/akhilvuputuri/chief-agent/pull/142) shipped explicit owner capture, the read-only Mini App tracker and opt-in renewal/trial/cancellation-deadline reminders as [v0.3.34](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.34) at `b79fd27f8cdf5ecadb05622217ab61666a63f70b`. GPT-6 Astra approved exact head `142486080c9094bbab151636d48e767dfc7e7d99`; its tree matches the merged release. PR/main checks, reviewed migration 025/operator installation, [normal release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37030523500), separate health/preservation checks and a transaction-rolled-back deployed-module smoke passed. No fixture remained, and the smoke made no Telegram send or model call. Actual owner Telegram acceptance remains separate. Email/browser/document intake, price alerts, monthly summaries and automatic responsibility monitoring remain later work; issue 132 stays open. See [contract](subscriptions.md) and [journal closure](journey/54-subscriptions.md#release-closure--3-october-2026).

# Coding runtime — v0.3.33 installed off, 2 October 2026

[PR #150](https://github.com/akhilvuputuri/chief-agent/pull/150) shipped the owned TypeScript/Node 22 coding-runtime foundation as [v0.3.33](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.33) at `1ee7c4bb4f6ef99ab79d9e648455e00ff4fc66ff`. GPT-6 Astra approved exact head `f05c4b20875e844417b672adb7d038a101ba4a4b`; PR/main CI, reviewed migration 024/Compose install, normal release and separate health/preservation checks passed. Coding is **off**, with zero live jobs. The public immutable worker image is published and anonymously pullable. Live execution still needs a scoped CodeBuild identity/project, repository-only GitHub App and authenticated ingress. See [setup](coding.md) and [journal closure](journey/56-coding-runtime.md). No paid sandbox/model acceptance has run. Deferred evaluation/memory branches remain separate.

# Issue 131 — Responsibilities released v0.3.32

[PR 148](https://github.com/akhilvuputuri/chief-agent/pull/148) shipped as [v0.3.32](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.32) at `9f5031ccb3a45e54cdde7f3f41accaa498faceff`. Final GPT-6 Astra approval covered exact head `943d71e0c6a1b1caf328f3716488f77a9da034ac`; CI and full checks passed. Reviewed migration-023 installation, normal release, separate health/preservation checks and idle-only activation succeeded on 2 October SGT. No responsibility was created; Telegram confirmation starts monitoring. Gmail is a bounded supporting adapter; lifecycle, scoped investigations and attention decisions are the core. Scheduled research can spend model budget on unchanged passes, as disclosed on confirmation. Live Telegram/provider acceptance and one-week quality/cost measurements remain pending; see [the contract](responsibilities.md) and [journal 54](journey/54-responsibilities.md).

# Libby linking refusal — 2 October 2026 (recovery released v0.3.31)

[PR #145](https://github.com/akhilvuputuri/chief-agent/pull/145) fixes the repeated-linking failure flow, not account access. GPT-6 Astra approved exact head `86c7fea975a50d7cd368a4d2e1818029080d22d2`; full checks passed (569 application, 21 JS, 30 Python tests). [Release](https://github.com/akhilvuputuri/chief-agent/actions/runs/36893817001), server RELEASE and health verified `3382c5d63a6551ea960615332d0fc0cd3643e672`. Live `/library` and `/library link` settled the historical refusal and explained the blocker with zero extra library calls. Catalogue checking works; the owner-approved card transfer is explicitly refused and borrowing remains unimplemented. See [library status](library.md#current-account-linking-blocker--2-october-2026) and [journal closure](journey/22-library-assistant.md#release-closure--2-october-2026). Official API access or a separately verified official-app approach is still needed for account features.

# Issue 137 — General input, feed destinations and exact references (released)

[v0.3.29](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.29) ships destinations, task origins, scoped approval placement, thread-aware FIFO/fences and durable work delivery through [PR #138](https://github.com/akhilvuputuri/chief-agent/pull/138). The reviewed migration-022 operator rollout installed `015b8a99d770977ada6035c3feed4b9bbdd7226d`; separate health and preserved-record checks plus [automatic release](https://github.com/akhilvuputuri/chief-agent/actions/runs/36872648089) passed.

[v0.3.30](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.30) ships exact sent feed references, bounded General discovery, owner-scoped feed/original-input reads, frozen per-input anchors and shared thread-aware continuity through [PR #139](https://github.com/akhilvuputuri/chief-agent/pull/139). Independent GPT-6 Astra approved exact head `cdab8b518bd08ceb00b95365d86c54d61209133e`; full 563 application, 21 JS and 30 Python checks passed. [Automatic release](https://github.com/akhilvuputuri/chief-agent/actions/runs/36875352644) verified merge `7cdbda24d7e7145f9482eb47819ec822722dc649`, followed by separate server RELEASE/health and a transaction-rolled-back deployed-module smoke for references, ownership and stable message binding. No fixture was retained; no Telegram message or model request was sent. Owner live Telegram acceptance remains separate. Read [topic contracts](telegram-topics.md) and [journal 53](journey/53-feed-destinations.md).

# Chief as coordinator with typed agents (released `5222e33`) — 1 October 2026

- **One generic delegation tool:** `agent_run(type, objective, context?, model?, effort?)` replaces `research_delegate`, `plugin_delegate` and `media_delegate`. Every agent is a plugin agent. Chief's domain work (email, parcels, calendar, daily, jobs, stocks, news, library, web lookups, media) moves into the bundled `core` plugin, and Chief keeps coordination, recall, memory, work tracking, canvases and job alignment. Subagents default to Gemini 3.8 Flash through model tiers in `config/model-policy.json`, and Chief runs on GPT-6.1 Sol (PR #126). See [coordinator and agents](agents.md) and [journal 49](journey/49-coordinator-agents.md). Production latency, cost and Flash answer quality are not measured yet.

# Bounded context within one long task (released) — 30 September 2026

- **Issue #77 closed (released `1c0e480` via [PR #122](https://github.com/akhilvuputuri/chief-agent/pull/122)):** a single long task no longer grows until the hard limit. Past 120,000 characters, the oldest call groups of the current turn leave the prompt in blocks of 8. A digest lists each with its read IDs, and failed calls keep their errors. Owner input sent during the task always stays. Synthetic tasks of 21–160 calls stay at 94k–105k characters; before, 160 calls failed. After real long tasks, check `trimmedGroups` and repeated `observation_read` of the same ID. See [journal 48](journey/48-bounded-turn.md) and [context management](context-management.md).

# Calendar stuck-uncertain fix and repeated-failure guard (released) — 29 September 2026

- **Repeated tool failures (released `4042743` via [PR #116](https://github.com/akhilvuputuri/chief-agent/pull/116)):** one request on 28 September called `parcel_list` 25 times with an unknown parcel ID. The parcel error now says where valid IDs come from, and the agent refuses a call form (an operation plus its argument names) after it fails the same way in three model steps with no successful call in between. See [journal 44](journey/44-repeated-tool-failure.md).
- **Calendar retries blocked (released `78d6f4e` via [PR #115](https://github.com/akhilvuputuri/chief-agent/pull/115); owner acceptance pending):** one approved Calendar write left `uncertain` blocked every later draft, and **Check status** could never clear it (the same mechanism as [journal 31](journey/31-calendar-authorization-failure.md)). Branch `claude/calendar-event-creation-bug-nad2ub` settles such approvals by a read-only GET once no attempt can be in flight. It also records why an insert became uncertain. The owner's next Calendar request, or **Check status**, should now settle the stuck approval and show a new card. See [journal 43](journey/43-calendar-stuck-uncertain.md).

# Stock monitoring hours and news bulletin (v0.3.28) — 28 September 2026

- **Stock monitoring hours (released):** [PR #108](https://github.com/akhilvuputuri/chief-agent/pull/108) was installed through the migration-020 operator rollout at `069c8d5`; health and schema were verified. The owner can now ask Chief to monitor only during Singapore-time hours, such as from the open until midnight. Owner Telegram acceptance is pending. See [journal 39](journey/39-watch-monitoring-window.md).
- **Daily news bulletin (released in v0.3.28):** [PR #109](https://github.com/akhilvuputuri/chief-agent/pull/109) restarts issue #50 after closing the ~5k-line PR #83. Migration 021 was installed at `8f7f7f7` through `scripts/deploy-news.py`. Nothing is configured until the owner tells Chief which sites to follow, the time and any topics. See [journal 42](journey/42-news-bulletin.md) and the [runbook](news-bulletin.md).

# Chief — production on AWS Lightsail with private logs (v0.3.27)

On 26 September 2026 SGT production moved from DigitalOcean to one AWS Lightsail VM, following the owner's migration handover. Changes:

- [PR #94](https://github.com/akhilvuputuri/chief-agent/pull/94): sanitized operational log projection.
- [PR #96](https://github.com/akhilvuputuri/chief-agent/pull/96): host procedure, least-privilege CloudWatch identities, a bounded `npm run logs:cloudwatch` reader, and the validated `CHIEF_DEPLOY_HOST` release target.
- [PR #98](https://github.com/akhilvuputuri/chief-agent/pull/98): journal exporter that survives reboots.

Each PR was independently reviewed by Opus 5.5 until approved.

The cutover took about 45 seconds of downtime. The restored database matched the quiesced source on every table's row count and content hash. The normal release workflow now deploys to Lightsail with exact-SHA receipts. Details, the acceptance ledger and pending owner checks are in [journal 35](journey/35-lightsail-private-logs.md); the procedure is in [lightsail.md](lightsail.md). Existing defect: the Sheets refresh token returns `invalid_grant` on both hosts. The owner's live Telegram text, voice, image, Calendar approval and Mini App checks passed on 26 September. Voice replies are now off (`VOICE_REPLIES=false`) at the owner's request.

Released v0.3.25 stock inspection fix through [PR #93](https://github.com/akhilvuputuri/chief-agent/pull/93): independent GPT-6 Astra approved head `7665709`; full checks passed (405 application tests and 10 script tests), as did formatting and CI. The [automatic release](https://github.com/akhilvuputuri/chief-agent/actions/runs/36233697974) verified merge `d96cdb70dff85343efb57baac8988462f8120601` and startup health. Separately reviewed exact-call reconciliation passed a rolled-back production dry run and committed on 26 September, preserving the old error/timestamp and appending evidence; no unresolved owner calls remained. No Calendar action was replayed. See [stock incident](journey/25-stock-watchlist.md#follow-up--26-september-2026-stale-uncertainty-blocked-stock-management).

Released [v0.3.26](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.26) through [PR #95](https://github.com/akhilvuputuri/chief-agent/pull/95): independent GPT-6 Astra approved exact head `1b62f05fa42b4ae787a49eef8e194dda4f80daed`. Full local checks passed (407 application tests and 10 script tests), plus formatting and CI. The [automatic release](https://github.com/akhilvuputuri/chief-agent/actions/runs/36234286230) and separate server inspection verified `f3ab7f10bea05e436424712a03a757f8744d9c02` healthy. This accepts US Nasdaq listing segments `XNGS`, `XNMS` and `XNCM`, retaining exact identity and explicit exchange selection. Live provider lookup and quote passed; a deployed validated-dispatcher add/list check preserved owner isolation and rolled back all test watch/run/events, sending no alert. US markets were closed during verification; actual owner Telegram and threshold-triggered delivery remain separate acceptance checks. No database or Compose changes.

On 24 September 2026 SGT, [v0.3.24](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.24) was installed at exact commit `69274943db264770c1c26468dce941113eb91bce` through the independently reviewed migration-019 operator procedure. Main checks passed; the procedure reported migration 19 and healthy startup, and separate inspection confirmed `RELEASE`, gateway health, owner-only `.env` permissions, the resolved old Calendar approval, and a successful primary-calendar read after token renewal. [PR #67](https://github.com/akhilvuputuri/chief-agent/pull/67) adds parcel tracking; [PR #89](https://github.com/akhilvuputuri/chief-agent/pull/89) clarifies blocked Calendar drafts; [PR #90](https://github.com/akhilvuputuri/chief-agent/pull/90) ties failure status guidance to the current task. Real owner-approved Calendar creation and parcel tracking from a live email remain acceptance checks. GitHub's automatic release job could not start at this initial rollout because Actions reported an account payment/spending-limit block. See [Calendar incident](journey/31-calendar-authorization-failure.md) and [delivery tracker](journey/33-delivery-tracker.md).

Later on 24 September, the repository became public and a rerun of [PR #91 checks](https://github.com/akhilvuputuri/chief-agent/actions/runs/35897167907) completed the full test/build job. PR #91 merged as `4db377df1743cafe75e07ba22d288da1945248a4`; [main checks](https://github.com/akhilvuputuri/chief-agent/actions/runs/35898242145) and the [automatic release](https://github.com/akhilvuputuri/chief-agent/actions/runs/35898616558) passed for that exact SHA, with a successful deployment receipt and startup health. The preceding [PR #88 model pin](https://github.com/akhilvuputuri/chief-agent/pull/88) also received a successful [automatic release](https://github.com/akhilvuputuri/chief-agent/actions/runs/35898129290) at `2240fe1b3d868871b393874dc82776e122849da2`, and is contained in `4db377d`. The bundled main-model policy now selects `openai/gpt-6-sol`. No post-release paid model request or owner Telegram acceptance was run, so provider acceptance and response quality remain unverified. The v0.3.24 tag still points to the earlier verified migration rollout; it was not moved.

As verified on 23 September 2026 SGT, [v0.3.23](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.23) deployed `b22b09d0abca93bc6551468d0ad50ca68551f102` with successful [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/35870399160), startup health and bounded [diagnostics](https://github.com/akhilvuputuri/chief-agent/actions/runs/35871182944) reporting that exact server SHA. The bundled main-model policy is now live. Its initial `main: null` preserves the current environment-derived model; **no GPT-6 switch occurred in this release**. Future agents can pin a verified OpenRouter model in a reviewed PR and let the ordinary release deploy it. See [model deployment](deployment.md#changing-the-production-model-through-a-release) and [journal 32](journey/32-repo-controlled-model.md). This evidence is at release time; check newer releases and the current server `RELEASE` for later state.

As verified on 22 September 2026 SGT, [v0.3.22](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.22) deployed exact commit `c936d7d630831f6f0c4b27dd62c5a06141a50201`: the [release run](https://github.com/akhilvuputuri/chief-agent/actions/runs/35634079343) and authenticated exact-commit receipt report startup health. Running-container inspection confirmed the temporary 400,000-character internal ceiling with compaction still starting at 120,000. A synthetic 133,396-character continuation passed without a provider call; no failed user request was automatically resumed. This is release-time evidence, not a current health or semantic-completion claim. Check the newest release and server `RELEASE` for any later state. [Journal evidence](journey/28-context-wire-compaction.md#verified-v0322-release--22-september-2026).

The earlier Chief identity change shipped in v0.3.21; [live branding verification](journey/30-chief-rebrand.md#verified-application-release) passed. Existing server/database/plugin identifiers are retained; see [compatibility](rebranding.md). The context ceiling is only headroom: unbounded working groups and the large fixed tool inventory remain open in [issue #77](https://github.com/akhilvuputuri/chief-agent/issues/77) with a [staged plan](context-management.md).

Use [troubleshooting](troubleshooting.md) to distinguish integrated source, deployed release and private incident evidence. On 24 September 2026, the operator replaced the primary Calendar token after a confirmed `invalid_grant` and verified the server's connected account plus a primary-calendar read. That does not establish a successful live event creation: it still requires an owner-approved Telegram draft. The follow-up to [the Calendar incident](journey/31-calendar-authorization-failure.md) records the exact boundary.

Cloud harness PRs #74/#75 are merged: shared independent-review instructions, `/companion` Devin shortcut, exact-commit release receipts, and a pinned-owner/Devin-bot diagnostics comment command. Released at `f71468a` with startup health and authenticated release receipt verified; actual Devin-originated diagnostics and PR reply passed; see [workflow](cloud-agent-workflow.md) and [evidence](journey/29-cloud-agent-harness.md). Self-merge remains unverified under the reported platform restriction; schema/host rollouts remain operator-mediated.

New context incident diagnosed on 22 September: the wire-compaction patch works but accumulated current-turn groups still outgrow the internal character guard. See [measured follow-up](journey/28-context-wire-compaction.md#follow-up--22-september-2026-accumulation-remains-unbounded). Model capacity and application policy are distinct; general rolling-context remediation is not yet implemented.

# Current work and shipped baseline

Released v0.3.24 delivery tracker ([issue #64](https://github.com/akhilvuputuri/chief-agent/issues/64)): migration 019, append-only parcel history, explicit precedence between owner statements and email, and host-computed matching that asks rather than guesses. The tool surface was reduced and the capability gated to limit prompt pressure; see [deliveries](deliveries.md) and [journal 33](journey/33-delivery-tracker.md). No owner acceptance yet.

Released v0.3.20 at `c323b34`: recoverable context repacking after serialized tool results exceed the application guard. [Incident, regression and deployment evidence](journey/28-context-wire-compaction.md). Original messages/results remain stored; fixed schema footprint optimization remains separate.

Released [v0.3.19](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.19): two read-only Gmail accounts with explicit account selection, separate credentials/caches and a shared request allocation. See [runbook](google-authorization.md) and [journal](journey/27-multiple-gmail-accounts.md). Independent review and CI passed; operator rollout verified `452b4fd` healthy with migration018 and both Gmail account searches successful.

The stock watchlist from [PR #63](https://github.com/akhilvuputuri/chief-agent/pull/63) was installed with additive migration 018 during the v0.3.19 operator rollout. That initial rollout did not configure a market-data provider. Twelve Data configuration and successful live symbol/quote reads were verified on 26 September 2026; the key remains private in the host environment. The later runtime uncertainty and Nasdaq segment defects are resolved by v0.3.25/v0.3.26 and the separately reviewed exact-call reconciliation described above. See [stock-watchlist.md](stock-watchlist.md), [stock journal](journey/25-stock-watchlist.md) and [initial rollout evidence](journey/27-multiple-gmail-accounts.md#verified-release--21-september-2026).

Released scheduled routine foundation: [v0.3.15](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.15), issue #56, PRs #58/#59, migration 017. Operator rollout verified `c1f8e7088676d4ee3d041993d5e08412e4c73a70` healthy on 20 September 2026. Future domain agents should reuse the [contract/runbook](scheduled-routines.md). No live routine was created during deployment.

Released [v0.3.11](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.11) at `9c71f61d3578ae5718804b56aa281ee469d38396` ([PR #51](https://github.com/akhilvuputuri/chief-agent/pull/51)): NLB catalogue availability with the Lucky Day verdict rule, a pinned-route paced client and a CI boundary test; app-only. Owner acceptance from the phone is pending. Released [v0.3.12](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.12) at `71de810f370d109f859a845de262ae694d3e552f` by the reviewed operator rollout on 20 September 2026 (migration 16): encrypted Libby identity, phone linking ceremony, `/library` commands and `library_shelf`. The first real link is the pending acceptance experiment; record the direction Libby used in journal 22. Then approved writes (Phase 3) and the hold-ready watcher (Phase 4). Plan: [issue #41](https://github.com/akhilvuputuri/chief-agent/issues/41); behaviour: [library](library.md); journal: [22](journey/22-library-assistant.md).

Released [v0.3.14](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.14) at `dd2be311e4cbfaecd75eca64bb0bcb730abfab76`, deployed and health-verified on 20 September 2026: mailbox search returns sender, subject, date and snippet per hit instead of bare identifiers, `gmail_thread` reads a conversation in one bounded call, a 40-request per-turn ceiling is enforced in the adapter, and the model is given a Gmail operator sheet in `personal-assistance` version 3. App-only. Independent review found and fixed an unbounded conversation read that had defeated the untrusted-content warning; see the journal. Plan: [issue #53](https://github.com/akhilvuputuri/chief-agent/issues/53); contract: [Google integrations](google-integrations.md); journal: [23](journey/23-gmail-search.md). Phone acceptance and any decision about a local metadata index remain open.

Released [v0.3.10](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.10): [PR #44](https://github.com/akhilvuputuri/chief-agent/pull/44) merged persistent preparation evidence chains at `672021f2afcea620224fd9f7ce7ccfdc53b9ba89`, whose tree matches Astra-approved `b01a9226c37ea73fa0cb3140fdfb43e11fc08772`. Required checks passed. The reviewed operator rollout succeeded on 14 September 2026: exact deployed SHA verified, startup healthy and migration 15 installed. Separate read-only verification found all three existing preparation tasks retained with empty evidence chains and no active runs. The [standard release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/34773911229) passed, and the immutable v0.3.10 tag resolves to the verified deployed SHA. See the [contract](preparation.md), [rollout](preparation-rollout.md) and [review history](journey/21-preparation-chain.md). No backfill, role reanalysis or paused-task resumption is part of this release.

Previous published milestone, verified before the preparation rollout on 14 September 2026: [v0.3.9](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.9), deployed SHA `9c6335be09582432d9bf7c4a475c90f9b5e9272a`. The [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/34764417365) and [subsequent diagnostics](https://github.com/akhilvuputuri/chief-agent/actions/runs/34769892493) succeeded at that SHA. See the [engineering journal](journey/README.md) for the chronological record, connected incidents and release closures. Deferred memory/evaluation work remains separate; real Telegram checkpoint-steering acceptance is still an open check.

Version 0.3.9 ([PR #42](https://github.com/akhilvuputuri/chief-agent/pull/42)) lets ordinary follow-ups join the same unbound run at model/tool checkpoints, preserves completed results, stops unstarted calls and separates input preparation from execution and delivery. Explicit cancellation still aborts; task-bound runs pause and hand off. See [behavior, tests and migration014 rollout](checkpoint-steering.md) and [journal 18](journey/18-checkpoint-steering.md).

The PR records final exact-head independent approval; the published v0.3.9 release records the reviewed migration014 rollout, preserved data and verified health. Its one-time operator procedure required released v0.3.8 (`d0e33365c7cec7b7cb1eb64c22de7c09d5d9a314`) as the baseline. A branch or version field alone does not prove deployment. No automatic input replay, extra allocation, active-work cancellation, data reset or paid evaluation is part of this rollout. Existing model/provider/voice/Google settings and deferred branches remain unchanged.

The entries below preserve earlier checkpoint states. The explicitly labeled v0.3.8 candidate notes preserve their original pending steps; [v0.3.8 release evidence](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.8) closes those steps, and v0.3.9 supersedes its ordinary interrupt-and-replace behavior.

# Historical v0.3.8 candidate notes: rolling conversation control

Candidate v0.3.8 on `feature/rolling-conversation` replaces implicit owner-global task routing with a foreground conversation and independently selected background jobs. Context preserves the current exchange; history search uses original messages; pending questions retain source IDs; incoming messages are persisted before waiting and can interrupt model reasoning. See [implementation, tests and migration](rolling-conversation.md) and [development journal](journey/17-rolling-conversation.md).

At the candidate stage, next release steps were independent Astra review of the PR, fix/re-review any findings, passing checks, merge, then reviewed migration013 on the existing DigitalOcean server and exact-SHA health verification. No data reset or cancellation of active user work is authorized for rollout. Existing model/provider/voice/Google integration settings remain unchanged. Deferred observable-memory and evaluation branches remain deferred.

The candidate notes above are historical. The pickup map below distinguishes released work from deferred checkpoints; check GitHub main and server RELEASE when starting later work.

# Pickup map

Status reconciled 14 September 2026; earlier baseline/checkpoint observations below retain their original dates. Historical metrics and handover snapshots are not current production queries. Verify GitHub and production diagnostics when starting an incident investigation.

## Historical released baseline — 9 September 2026

Owned TypeScript runtime; Telegram text and ElevenLabs voice; research, tasks, reminders and Sheets; read-only Gmail; Calendar queries and explicit Telegram approval for event creation; basic explicit memories; token accounting and focused context/search optimizations. GitHub checks and automatic app release are installed. Last release verified while preparing this document: `e6837c0ab0061d768ea752a42548c3921ca3c095`. Later releases supersede this historical verification.

## Observable memory checkpoint

Code: [checkpoint/observable-memory](https://github.com/akhilvuputuri/chief-agent/tree/checkpoint/observable-memory), checkpoint `2a85839`. Read its [detailed checkpoint](https://github.com/akhilvuputuri/chief-agent/blob/checkpoint/observable-memory/docs/checkpoints/observable-memory.md). This is incomplete and not deployed. Start a new working branch from that checkpoint, incorporate relevant main changes, then finish tests/review and prepare additive migration 010. Do not merge it merely because code exists.

Known remaining issues include pre-mutation error classification, dedicated provenance/ownership/revision tests, trace inclusion semantics, bounded private export, full checks and reviewed deployment. Private memory-trace workflow support in that branch is not yet installed in production. No production secrets are required to reproduce the mocked tests.

## Subsequent agreed direction

1. Python trace analysis consuming versioned exports from the actual TypeScript runtime.
2. One narrow evaluation/improvement/comparison cycle with sanitized fixtures; no broad paid eval project.
3. Image/PDF ingestion: released in PR #22 at application `eb501b3`, then routed through the isolated media specialist in v0.3.2 (current-turn image bytes remain ephemeral; PDF text is stored in `research_sources` with `source_read`). See [journey 07](journey/07-attachments.md). Remaining: owner check with a real photo and PDF, OCR or page rendering for scanned PDFs, other document types.

## Deferred work

`feature/runtime-evaluations` is an earlier, explicitly deferred candidate. Its migration 007 is not production schema. Do not merge or run paid experiments incidentally. See [checkpoint](checkpoints/runtime-evaluations.md).

Realtime voice, parallel specialist teams/shell execution and runtime self-deployment remain later milestones. The authenticated read-only Mini App and versioned canvases shipped in v0.3.5; signed Telegram launch and model-generated production-canvas acceptance remain separate checks. Claude cloud setup instructions exist, but the account connection and a Claude-originated release have not been verified.

## Handover requirements

At each checkpoint record the branch and commit, objective, implemented behavior, actual checks, known failures, migration/rollback requirements and next concrete step. Publish source without secrets. Keep private traces out of Git; link their authorized inspection procedure instead.

## Research specialist — issue #27, phase 1

Released in [v0.2.0](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.2.0) through PR #29: isolated public research, exact targets, validated source quotations, parent/child execution and cost traces, shared cancellation and budgets. No database migration or new infrastructure. See [handover](research-specialist.md) and [journal](journey/08-research-specialist.md). The [journal release closure](journey/08-research-specialist.md) records the exact deployed SHA and workflow. Media specialization later shipped in v0.3.2; Python weekly analysis (#28) remains separate work.

## Job-alignment refinement

Released in [v0.3.0](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.0) through PR #30, the job-alignment specialist implements the clarified purpose in issue #27: any selected scope of saved roles, source-backed fit/interview findings and minimum useful preparation. See [contract and operation](job-alignment.md) and [journey 09](journey/09-job-alignment.md). No migration; standalone memory/Python checkpoints remain untouched. Independent Astra approval, passing checks and exact deployment/health verification are recorded in the [journal closure](journey/09-job-alignment.md). Semantic quality and comparative cost remain unmeasured.

## Foundation review fixes

Independent Astra review of v0.2.0 found delegated search-cache isolation from its parent and a restart gap in child elapsed-time accounting. PR #31 addressed both with focused tests and shipped in [v0.2.1](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.2.1). See [review journal](journey/10-foundation-review.md). Astra re-review approved the fixed head; release/health verification passed, and dependent PR #30 incorporated the fixes before its final review/release.

## Interactive Telegram output — issue #26

Released in [v0.3.1](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.1) through PR #32, Telegram views implement phases 1/2: owner/message-bound read-only views, optional answer envelopes, grouped scheduled briefings and delivery/tap metadata. See [implementation and pickup](telegram-views.md) and [journey 11](journey/11-telegram-views.md). Mini App phase 3 subsequently shipped in v0.3.5 on the existing DigitalOcean host and free HTTPS hostname. The journal records independent approval, tests and exact v0.3.1 deployment; real-phone navigation and real-model UX acceptance remain separate.

The earlier foundation and job-alignment work above has since shipped: MR #31 / v0.2.1 and MR #30 / v0.3.0, respectively. The latter deployed `1c625cbe9dd56292347970f257513cfc7dcd9ada` in release run `34698539900`, verified healthy. The media specialist for issue #27 has since shipped in v0.3.2 (see below).

## Media specialist — issue #27, phase 2

Released in PR #33 as v0.3.2, deployed commit `10a2716b589783972a9f3f00e279a0e1d30971cf`, release run 34709810663 healthy. Image reading and targeted document questions go through the read-only specialist runner: per-turn attachment IDs, `media_delegate`/`media_report`, stored image extractions, content-hash reuse of usable results only, image-free traces and an optional `MEDIA_MODEL`. See [media processing](media-specialist.md) and [journey 12](journey/12-media-specialist.md). First real use on 12 September: a photo routed through the media child correctly; a PDF turn failed before its model call, most plausibly on the context guard, and PR #34 (v0.3.4, deployed `1e44bdb`) makes that guard keep the current message plus its newest tool group and squeeze the rest under the unchanged allowance (see cost-controls follow-up). Follow-ups: a regression test pinning the per-request ceiling, and the media test cases for wrong-quote-after-read and kind mismatch. Next: resend that PDF question after release and inspect the child trace and reported cost; consider a short follow-up test restoring the wrong-quote-after-read and kind-mismatch cases the reviewer noted. OCR for scanned PDFs remains open.

## Mini App HTTPS foundation — issue #26

The owner selected DigitalOcean and a free hostname on 13 September. PR #35 shipped [v0.3.3](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.3) with a Caddy host service initially serving a holding response at `companion.188-166-246-143.sslip.io`. See [deployment and canvas follow-up](miniapp-deployment.md) and [journey 13](journey/13-miniapp-https.md). The release records trusted TLS, redirect and restricted-route verification. Authentication, frontend, versioned canvases and agent tools subsequently shipped in v0.3.5. The HTTPS-only milestone had no DB/Compose change; ordinary app releases do not install the host Caddyfile.

## Persistent canvases — released v0.3.5, issue #26

PR #36 shipped [v0.3.5](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.5) at `677683a043e9f16d4a4bd4dc680a78b87ae9b639`, implementing the Mini App with Telegram authentication, a library of independent revisioned canvases, read-only roles, canvas tools and provenance/view traces. See [contract](canvases.md), [journal](journey/14-persistent-canvases.md) and [additive rollout](miniapp-deployment.md). Independent review, CI, operator migration/ingress installation and exact release/health verification passed. A real signed Telegram launch and a model-generated production canvas remain distinct acceptance checks. Observable memory/Python checkpoints remain separate.

## Portable plugins — released v0.3.6, issue #37

PR #38 shipped [v0.3.6](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.6) at `20564401c5130f79e2f90a8c802c32298c6c502e`. It packages general research and adds declarative import/export, a host registry, generic delegation, lazy skills and durable definition pins. See [plugin guide](plugins.md). No migration/Compose change. Job alignment/media and external vendor-format adapters remain separate; the product issue stays open. The [journal closure](journey/15-portable-plugins.md) records exact-head approval, passing checks and verified release; wider vendor compatibility and measured quality/cost improvement are not established.

## Authoritative message storage — released v0.3.7

PR #39 shipped [v0.3.7](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.7) at `099e7478ff5d33bb240740406f822e3a01e7a580`. It normalizes repeated message payloads, appends checkpoint deltas and adds bounded history loading plus owner-scoped conversation search/read. See [storage architecture and rollout](authoritative-storage.md). Migration012 and the Compose baseline were installed through the reviewed operator deployment; old-image rollback still requires legacy rehydration. No data reset or automatic trace purge; memory/wiki work remains subsequent. The [journal closure](journey/16-authoritative-storage.md) records exact approval/release evidence and measured storage reduction; it does not infer API savings. Rolling-context retrieval and independent jobs subsequently shipped in v0.3.8, followed by v0.3.9 steering above.

## Telegram topics, phase 1 — 1 October 2026

Threaded mode is on for the production bot, and users cannot create threads. Phase 1 posts the news bulletin to a **News** topic and stock alerts to a **Markets** topic, and answers a message typed in a topic in that same topic. Memory and the conversation stay shared, and everything else stays in General. See [topics in the private chat](telegram-topics.md) and [journal 52](journey/52-telegram-topics.md). Phase 1 was released as `03a1ef4`. Phase 2 creates all topics at startup and sends a message typed in the **Email** topic straight to the email agent, which saves Chief's routing call. News and Markets only give Chief a hint. Next: live acceptance for both phases.

Integration follow-up: main `a3c428e3d0050f89be89dfa31667d8600160db14` adds the released v0.3.36 conversational coding confirmation and fixed worker pin. Those changes are incorporated and remain off; no coding activation is part of gathering. Migration 026 remains unused upstream.
