# Current work and shipped baseline

Scheduled routine foundation: issue #56, branch `feature/scheduled-agent-routines`, migration 017; see [contract/runbook](scheduled-routines.md). Candidate pending independent review/deployment.

Released [v0.3.11](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.11) at `9c71f61d3578ae5718804b56aa281ee469d38396` ([PR #51](https://github.com/akhilvuputuri/companion-agent/pull/51)): NLB catalogue availability with the Lucky Day verdict rule, a pinned-route paced client and a CI boundary test; app-only. Owner acceptance from the phone is pending. Released [v0.3.12](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.12) at `71de810f370d109f859a845de262ae694d3e552f` by the reviewed operator rollout on 20 September 2026 (migration 16): encrypted Libby identity, phone linking ceremony, `/library` commands and `library_shelf`. The first real link is the pending acceptance experiment; record the direction Libby used in journal 22. Then approved writes (Phase 3) and the hold-ready watcher (Phase 4). Plan: [issue #41](https://github.com/akhilvuputuri/companion-agent/issues/41); behaviour: [library](library.md); journal: [22](journey/22-library-assistant.md).

Candidate v0.3.13 on `feature/gmail-search`: mailbox search returns sender, subject, date and snippet per hit instead of bare identifiers, `gmail_thread` reads a conversation in one bounded call, a 40-request per-turn ceiling is enforced in the adapter, and the model is given a Gmail operator sheet in `personal-assistance` version 3. App-only, with no schema or Compose change, so the ordinary release deploys it. Plan: [issue #53](https://github.com/akhilvuputuri/companion-agent/issues/53); contract: [Google integrations](google-integrations.md); journal: [23](journey/23-gmail-search.md). Phone acceptance and any decision about a local metadata index remain open.

Released [v0.3.10](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.10): [PR #44](https://github.com/akhilvuputuri/companion-agent/pull/44) merged persistent preparation evidence chains at `672021f2afcea620224fd9f7ce7ccfdc53b9ba89`, whose tree matches Astra-approved `b01a9226c37ea73fa0cb3140fdfb43e11fc08772`. Required checks passed. The reviewed operator rollout succeeded on 14 September 2026: exact deployed SHA verified, startup healthy and migration 15 installed. Separate read-only verification found all three existing preparation tasks retained with empty evidence chains and no active runs. The [standard release workflow](https://github.com/akhilvuputuri/companion-agent/actions/runs/34773911229) passed, and the immutable v0.3.10 tag resolves to the verified deployed SHA. See the [contract](preparation.md), [rollout](preparation-rollout.md) and [review history](journey/21-preparation-chain.md). No backfill, role reanalysis or paused-task resumption is part of this release.

Previous published milestone, verified before the preparation rollout on 14 September 2026: [v0.3.9](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.9), deployed SHA `9c6335be09582432d9bf7c4a475c90f9b5e9272a`. The [release workflow](https://github.com/akhilvuputuri/companion-agent/actions/runs/34764417365) and [subsequent diagnostics](https://github.com/akhilvuputuri/companion-agent/actions/runs/34769892493) succeeded at that SHA. See the [engineering journal](journey/README.md) for the chronological record, connected incidents and release closures. Deferred memory/evaluation work remains separate; real Telegram checkpoint-steering acceptance is still an open check.

Version 0.3.9 ([PR #42](https://github.com/akhilvuputuri/companion-agent/pull/42)) lets ordinary follow-ups join the same unbound run at model/tool checkpoints, preserves completed results, stops unstarted calls and separates input preparation from execution and delivery. Explicit cancellation still aborts; task-bound runs pause and hand off. See [behavior, tests and migration014 rollout](checkpoint-steering.md) and [journal 18](journey/18-checkpoint-steering.md).

The PR records final exact-head independent approval; the published v0.3.9 release records the reviewed migration014 rollout, preserved data and verified health. Its one-time operator procedure required released v0.3.8 (`d0e33365c7cec7b7cb1eb64c22de7c09d5d9a314`) as the baseline. A branch or version field alone does not prove deployment. No automatic input replay, extra allocation, active-work cancellation, data reset or paid evaluation is part of this rollout. Existing model/provider/voice/Google settings and deferred branches remain unchanged.

The entries below preserve earlier checkpoint states. The explicitly labeled v0.3.8 candidate notes preserve their original pending steps; [v0.3.8 release evidence](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.8) closes those steps, and v0.3.9 supersedes its ordinary interrupt-and-replace behavior.

# Historical v0.3.8 candidate notes: rolling conversation control

Candidate v0.3.8 on `feature/rolling-conversation` replaces implicit owner-global task routing with a foreground conversation and independently selected background jobs. Context preserves the current exchange; history search uses original messages; pending questions retain source IDs; incoming messages are persisted before waiting and can interrupt model reasoning. See [implementation, tests and migration](rolling-conversation.md) and [development journal](journey/17-rolling-conversation.md).

At the candidate stage, next release steps were independent Astra review of the PR, fix/re-review any findings, passing checks, merge, then reviewed migration013 on the existing DigitalOcean server and exact-SHA health verification. No data reset or cancellation of active user work is authorized for rollout. Existing model/provider/voice/Google integration settings remain unchanged. Deferred observable-memory and evaluation branches remain deferred.

The candidate notes above are historical. The pickup map below distinguishes released work from deferred checkpoints; check GitHub main and server RELEASE when starting later work.

# Pickup map

Status reconciled 14 September 2026; earlier baseline/checkpoint observations below retain their original dates. Historical metrics and handover snapshots are not current production queries. Verify GitHub and production diagnostics when starting an incident investigation.

## Historical released baseline — 9 September 2026

Owned TypeScript runtime; Telegram text and ElevenLabs voice; research, tasks, reminders and Sheets; read-only Gmail; Calendar queries and explicit Telegram approval for event creation; basic explicit memories; token accounting and focused context/search optimizations. GitHub checks and automatic app release are installed. Last release verified while preparing this document: `e6837c0ab0061d768ea752a42548c3921ca3c095`. Later releases supersede this historical verification.

## Observable memory checkpoint

Code: [checkpoint/observable-memory](https://github.com/akhilvuputuri/companion-agent/tree/checkpoint/observable-memory), checkpoint `2a85839`. Read its [detailed checkpoint](https://github.com/akhilvuputuri/companion-agent/blob/checkpoint/observable-memory/docs/checkpoints/observable-memory.md). This is incomplete and not deployed. Start a new working branch from that checkpoint, incorporate relevant main changes, then finish tests/review and prepare additive migration 010. Do not merge it merely because code exists.

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

Released in [v0.2.0](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.2.0) through PR #29: isolated public research, exact targets, validated source quotations, parent/child execution and cost traces, shared cancellation and budgets. No database migration or new infrastructure. See [handover](research-specialist.md) and [journal](journey/08-research-specialist.md). The [journal release closure](journey/08-research-specialist.md) records the exact deployed SHA and workflow. Media specialization later shipped in v0.3.2; Python weekly analysis (#28) remains separate work.

## Job-alignment refinement

Released in [v0.3.0](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.0) through PR #30, the job-alignment specialist implements the clarified purpose in issue #27: any selected scope of saved roles, source-backed fit/interview findings and minimum useful preparation. See [contract and operation](job-alignment.md) and [journey 09](journey/09-job-alignment.md). No migration; standalone memory/Python checkpoints remain untouched. Independent Astra approval, passing checks and exact deployment/health verification are recorded in the [journal closure](journey/09-job-alignment.md). Semantic quality and comparative cost remain unmeasured.

## Foundation review fixes

Independent Astra review of v0.2.0 found delegated search-cache isolation from its parent and a restart gap in child elapsed-time accounting. PR #31 addressed both with focused tests and shipped in [v0.2.1](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.2.1). See [review journal](journey/10-foundation-review.md). Astra re-review approved the fixed head; release/health verification passed, and dependent PR #30 incorporated the fixes before its final review/release.

## Interactive Telegram output — issue #26

Released in [v0.3.1](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.1) through PR #32, Telegram views implement phases 1/2: owner/message-bound read-only views, optional answer envelopes, grouped scheduled briefings and delivery/tap metadata. See [implementation and pickup](telegram-views.md) and [journey 11](journey/11-telegram-views.md). Mini App phase 3 subsequently shipped in v0.3.5 on the existing DigitalOcean host and free HTTPS hostname. The journal records independent approval, tests and exact v0.3.1 deployment; real-phone navigation and real-model UX acceptance remain separate.

The earlier foundation and job-alignment work above has since shipped: MR #31 / v0.2.1 and MR #30 / v0.3.0, respectively. The latter deployed `1c625cbe9dd56292347970f257513cfc7dcd9ada` in release run `34698539900`, verified healthy. The media specialist for issue #27 has since shipped in v0.3.2 (see below).

## Media specialist — issue #27, phase 2

Released in PR #33 as v0.3.2, deployed commit `10a2716b589783972a9f3f00e279a0e1d30971cf`, release run 34709810663 healthy. Image reading and targeted document questions go through the read-only specialist runner: per-turn attachment IDs, `media_delegate`/`media_report`, stored image extractions, content-hash reuse of usable results only, image-free traces and an optional `MEDIA_MODEL`. See [media processing](media-specialist.md) and [journey 12](journey/12-media-specialist.md). First real use on 12 September: a photo routed through the media child correctly; a PDF turn failed before its model call, most plausibly on the context guard, and PR #34 (v0.3.4, deployed `1e44bdb`) makes that guard keep the current message plus its newest tool group and squeeze the rest under the unchanged allowance (see cost-controls follow-up). Follow-ups: a regression test pinning the per-request ceiling, and the media test cases for wrong-quote-after-read and kind mismatch. Next: resend that PDF question after release and inspect the child trace and reported cost; consider a short follow-up test restoring the wrong-quote-after-read and kind-mismatch cases the reviewer noted. OCR for scanned PDFs remains open.

## Mini App HTTPS foundation — issue #26

The owner selected DigitalOcean and a free hostname on 13 September. PR #35 shipped [v0.3.3](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.3) with a Caddy host service initially serving a holding response at `companion.188-166-246-143.sslip.io`. See [deployment and canvas follow-up](miniapp-deployment.md) and [journey 13](journey/13-miniapp-https.md). The release records trusted TLS, redirect and restricted-route verification. Authentication, frontend, versioned canvases and agent tools subsequently shipped in v0.3.5. The HTTPS-only milestone had no DB/Compose change; ordinary app releases do not install the host Caddyfile.

## Persistent canvases — released v0.3.5, issue #26

PR #36 shipped [v0.3.5](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.5) at `677683a043e9f16d4a4bd4dc680a78b87ae9b639`, implementing the Mini App with Telegram authentication, a library of independent revisioned canvases, read-only roles, canvas tools and provenance/view traces. See [contract](canvases.md), [journal](journey/14-persistent-canvases.md) and [additive rollout](miniapp-deployment.md). Independent review, CI, operator migration/ingress installation and exact release/health verification passed. A real signed Telegram launch and a model-generated production canvas remain distinct acceptance checks. Observable memory/Python checkpoints remain separate.

## Portable plugins — released v0.3.6, issue #37

PR #38 shipped [v0.3.6](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.6) at `20564401c5130f79e2f90a8c802c32298c6c502e`. It packages general research and adds declarative import/export, a host registry, generic delegation, lazy skills and durable definition pins. See [plugin guide](plugins.md). No migration/Compose change. Job alignment/media and external vendor-format adapters remain separate; the product issue stays open. The [journal closure](journey/15-portable-plugins.md) records exact-head approval, passing checks and verified release; wider vendor compatibility and measured quality/cost improvement are not established.

## Authoritative message storage — released v0.3.7

PR #39 shipped [v0.3.7](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.7) at `099e7478ff5d33bb240740406f822e3a01e7a580`. It normalizes repeated message payloads, appends checkpoint deltas and adds bounded history loading plus owner-scoped conversation search/read. See [storage architecture and rollout](authoritative-storage.md). Migration012 and the Compose baseline were installed through the reviewed operator deployment; old-image rollback still requires legacy rehydration. No data reset or automatic trace purge; memory/wiki work remains subsequent. The [journal closure](journey/16-authoritative-storage.md) records exact approval/release evidence and measured storage reduction; it does not infer API savings. Rolling-context retrieval and independent jobs subsequently shipped in v0.3.8, followed by v0.3.9 steering above.
