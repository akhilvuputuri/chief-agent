# Current work: checkpoint steering

Released baseline v0.3.8 is `d0e33365c7cec7b7cb1eb64c22de7c09d5d9a314`. Candidate v0.3.9 on `feature/checkpoint-steering` lets ordinary follow-ups join the same unbound run at model/tool checkpoints, preserves completed results, stops unstarted calls and separates input preparation from execution and delivery. Explicit cancellation still aborts; task-bound runs pause and hand off. See [behavior, tests and migration014 rollout](checkpoint-steering.md) and [journal 18](journey/18-checkpoint-steering.md).

Next: finish integrated checks, exact-head independent Astra review, CI and merge, then the reviewed baseline-pinned operator deployment and exact-SHA health/data verification. The candidate is not deployed. No automatic input replay, extra allocation, active-work cancellation, data reset or paid evaluation is part of this rollout. Existing models/provider/voice/Google settings and deferred branches remain unchanged.

The entries below preserve earlier checkpoint states. Their pending-release statements are historical; the baseline above supersedes the v0.3.8 candidate status.

# Historical v0.3.8 candidate notes: rolling conversation control

Candidate v0.3.8 on `feature/rolling-conversation` replaces implicit owner-global task routing with a foreground conversation and independently selected background jobs. Context preserves the current exchange; history search uses original messages; pending questions retain source IDs; incoming messages are persisted before waiting and can interrupt model reasoning. See [implementation, tests and migration](rolling-conversation.md) and [development journal](journey/17-rolling-conversation.md).

Next release steps: independent Astra review of the PR, fix/re-review any findings, passing checks, merge, then reviewed migration013 on the existing DigitalOcean server and exact-SHA health verification. No data reset or cancellation of active user work is authorized for rollout. Existing model/provider/voice/Google integration settings remain unchanged. Deferred observable-memory and evaluation branches remain deferred.

The earlier entries below are historical checkpoints. Check GitHub main and server RELEASE for live state.

# Current work and pickup map

Updated 12 September 2026. Historical metrics and handover snapshots are not current production queries. Verify GitHub and production diagnostics when starting an incident investigation.

## Released baseline

Owned TypeScript runtime; Telegram text and ElevenLabs voice; research, tasks, reminders and Sheets; read-only Gmail; Calendar queries and explicit Telegram approval for event creation; basic explicit memories; token accounting and focused context/search optimizations. GitHub checks and automatic app release are installed. Last release verified while preparing this document: `e6837c0ab0061d768ea752a42548c3921ca3c095`. Later releases supersede this historical verification.

## Observable memory checkpoint

Code: [checkpoint/observable-memory](https://github.com/akhilvuputuri/companion-agent/tree/checkpoint/observable-memory), checkpoint `2a85839`. Read its [detailed checkpoint](https://github.com/akhilvuputuri/companion-agent/blob/checkpoint/observable-memory/docs/checkpoints/observable-memory.md). This is incomplete and not deployed. Start a new working branch from that checkpoint, incorporate relevant main changes, then finish tests/review and prepare additive migration 010. Do not merge it merely because code exists.

Known remaining issues include pre-mutation error classification, dedicated provenance/ownership/revision tests, trace inclusion semantics, bounded private export, full checks and reviewed deployment. Private memory-trace workflow support in that branch is not yet installed in production. No production secrets are required to reproduce the mocked tests.

## Subsequent agreed direction

1. Python trace analysis consuming versioned exports from the actual TypeScript runtime.
2. One narrow evaluation/improvement/comparison cycle with sanitized fixtures; no broad paid eval project.
3. Image/PDF ingestion: released in PR #22 at application `eb501b3` (Telegram photos and image files to the vision model for the current turn; PDF text extraction into `research_sources` with `source_read`). See [journey 07](journey/07-attachments.md). Remaining: owner check with a real photo and PDF, OCR or page rendering for scanned PDFs, other document types.

## Deferred work

`feature/runtime-evaluations` is an earlier, explicitly deferred candidate. Its migration 007 is not production schema. Do not merge or run paid experiments incidentally. See [checkpoint](checkpoints/runtime-evaluations.md).

Realtime voice, parallel delegation/shell execution, self-deployment and a Mini App are separate later milestones. Claude cloud setup instructions exist, but the account connection and a Claude-originated release have not been verified.

## Handover requirements

At each checkpoint record the branch and commit, objective, implemented behavior, actual checks, known failures, migration/rollback requirements and next concrete step. Publish source without secrets. Keep private traces out of Git; link their authorized inspection procedure instead.

## Research specialist — issue #27, phase 1

Implemented on `feature/research-specialist`: isolated public research, exact targets, validated source quotations, parent/child execution and cost traces, shared cancellation and budgets. No database migration or new infrastructure. See [handover](research-specialist.md) and [journal](journey/08-research-specialist.md). Verify the PR/release result before treating it as live. Media specialist and Python weekly analysis (#28) remain separate work.

## Job-alignment refinement

`feature/job-alignment` implements the clarified purpose in issue #27: any selected scope of saved roles, source-backed fit/interview findings and minimum useful preparation. See [contract and operation](job-alignment.md) and [journey 09](journey/09-job-alignment.md). No migration; standalone memory/Python checkpoints remain untouched. The owner requires an Astra subagent review and approval before merge/release. Verify the PR and exact release rather than assuming this branch is live.

## Foundation review fixes

Independent Astra review of v0.2.0 found delegated search-cache isolation from its parent and a restart gap in child elapsed-time accounting. `fix/specialist-architecture-review` addresses both with focused tests. See [review journal](journey/10-foundation-review.md). Require Astra re-review of the fixed head and successful deployment before treating the fixes as live; incorporate them into dependent MR #30 before its final review/release.

## Interactive Telegram output — issue #26

`feature/telegram-views` implements phases 1/2: owner/message-bound read-only views, optional answer envelopes, grouped scheduled briefings and delivery/tap metadata. See [implementation and pickup](telegram-views.md) and [journey 11](journey/11-telegram-views.md). Mini App phase 3 now targets the existing DigitalOcean host and a free HTTPS hostname; see the HTTPS milestone below. Next version is v0.3.1 under the owner’s new patch-only version policy. Require independent Astra approval, passing CI and exact deployment verification before marking this candidate live.

The earlier foundation and job-alignment work above has since shipped: MR #31 / v0.2.1 and MR #30 / v0.3.0, respectively. The latter deployed `1c625cbe9dd56292347970f257513cfc7dcd9ada` in release run `34698539900`, verified healthy. The media specialist for issue #27 has since shipped in v0.3.2 (see below).

## Media specialist — issue #27, phase 2

Released in PR #33 as v0.3.2, deployed commit `10a2716b589783972a9f3f00e279a0e1d30971cf`, release run 34709810663 healthy. Image reading and targeted document questions go through the read-only specialist runner: per-turn attachment IDs, `media_delegate`/`media_report`, stored image extractions, content-hash reuse of usable results only, image-free traces and an optional `MEDIA_MODEL`. See [media processing](media-specialist.md) and [journey 12](journey/12-media-specialist.md). First real use on 12 September: a photo routed through the media child correctly; a PDF turn failed before its model call, most plausibly on the context guard, and PR #34 (v0.3.4, deployed `1e44bdb`) makes that guard keep the current message plus its newest tool group and squeeze the rest under the unchanged allowance (see cost-controls follow-up). Follow-ups: a regression test pinning the per-request ceiling, and the media test cases for wrong-quote-after-read and kind mismatch. Next: resend that PDF question after release and inspect the child trace and reported cost; consider a short follow-up test restoring the wrong-quote-after-read and kind-mismatch cases the reviewer noted. OCR for scanned PDFs remains open.

## Mini App HTTPS foundation — issue #26

The owner selected DigitalOcean and a free hostname on 13 September. `feature/miniapp-https` prepares `companion.188-166-246-143.sslip.io` with a Caddy host service serving only a holding response. See [deployment and canvas follow-up](miniapp-deployment.md) and [journey 13](journey/13-miniapp-https.md). Verify the PR/operator checks before treating HTTPS as live. Authentication, the actual frontend, multiple versioned canvases and agent tools are still unbuilt. No DB/Compose change; ordinary app releases do not install the host Caddyfile.

## Persistent canvas candidate — issue #26

`feature/miniapp-canvases` starts from main `1e44bdb` and implements the Mini App with Telegram authentication, a library of independent revisioned canvases, read-only roles, canvas tools and provenance/view traces. See [contract](canvases.md), [journal](journey/14-persistent-canvases.md) and [additive rollout](miniapp-deployment.md). Patch candidate v0.3.5. The earlier HTTPS foundation is live; this application's status requires the exact independent review, CI, migration, release and real Telegram acceptance evidence. Observable memory/Python checkpoints remain separate.

## Portable plugin candidate — issue #37

`feature/portable-plugins` (v0.3.6 candidate) packages general research and adds declarative import/export, a host registry, generic delegation, lazy skills and durable definition pins. See [plugin guide](plugins.md). No migration/Compose change. Job alignment/media and external vendor-format adapters remain separate; the product issue stays open. Require independent exact-head approval, CI and verified release before treating this as live.

## Authoritative message storage — v0.3.7 candidate

`feature/authoritative-storage` normalizes repeated message payloads, appends checkpoint deltas and adds bounded history loading plus owner-scoped conversation search/read. See [storage architecture and rollout](authoritative-storage.md). Migration 012/Compose require reviewed operator deployment and legacy rehydration for old-image rollback. No data reset or automatic trace purge; memory/wiki work remains subsequent. Verify exact review, CI and release before treating this candidate as live. The previous portable-plugin release v0.3.6 shipped PR #38 at `20564401c5130f79e2f90a8c802c32298c6c502e`.
