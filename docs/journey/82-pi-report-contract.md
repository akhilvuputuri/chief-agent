# 82 — Complete coding reports must survive every handoff

Work date: 11 October 2026. Status: implementation and offline verification; independent review, paid acceptance and release pending.

## Problem and evidence

[Journal 81](81-pi-planning-progress.md) bounded planning but did not establish full-task acceptance. A subsequent owner-started job used the new worker and paused after 23 model calls and 33 navigation operations. CodeBuild completed successfully after 228 seconds in its BUILD phase, with a 45-minute receipt. Private structural inspection found two complete plan tool submissions of 9,357 and 7,426 characters; both failed the runtime's 6,000-character report schema. Summaries of 270/290 characters were valid. No provider truncation or sandbox timeout caused this pause. Private plans and conversations are excluded from this record.

The runtime report, host plan storage, reviewer findings, instruction projection and session/HTTP transport had independently chosen bounds. Raising one field alone would leave later handoffs brittle. The prior successful structural planning trial was insufficient evidence for a complete owner workflow.

## Contract and implementation

The independent package exports one report-document contract: versioned SHA-256 identity, full detail up to the existing 32,000-character host plan bound, separate status summary up to 4,000 characters and questions up to 2,000. These are storage/transport bounds, not Telegram presentation limits. Complete accepted documents are signed in local task state and acknowledged in host checkpoints; identity or plan-content mismatches are rejected. Owner approval continues to bind the complete exact plan, revision and original scope. No text is clipped to manufacture a valid plan.

Long approved plans and reviewer findings are immutable task reference documents, accessed by a paged read tool. They are not injected wholesale into the next phase's instruction string. Each new attempt/reviewer must read all required pages before edits, commands or a final report; documents remain available after compaction. Their full content remains scope/evidence, while summaries never become authority. Review findings are explicitly untrusted suggestions within the original approved scope.

A definite invalid report gets a bounded format-only correction. Valid settled reports end the native turn without an unnecessary continuation. Failures retain precise contract feedback and the complete submitted draft in encrypted session history. Explicit recovery resumes reporting without reopening repository investigation. Provider errors/truncation, cancellation and uncertain requests retain their existing stop/no-replay behavior. Trusted local pre-send context recovery remains available outside finalization.

Session entry and checkpoint/finish envelopes now accommodate the permitted document sizes, reasoning and existing bounded artifacts, including JSON escaping. Model-input and total-session allocations remain unchanged. Legacy request and review bounds are preserved at the controller boundary. CodeBuild, role models, provider price filters, time/model/tool allocations and the Python implementation are unchanged. No paused owner job is resumed or migrated.

## Verification and acceptance gates

Offline tests exercise the two incident-sized plans, maximum-size ASCII/Unicode plans and reviews, full approval delivery/binding, actual edits/checks, independent reviewer context and fixture draft publication. Additional tests cover document hash tampering, incomplete required reads, surrogate-pair page boundaries, encrypted oversized session entries, worst-case escaped checkpoint transport and formatting-only recovery. One paging test initially found missing range metadata; explicit source offsets corrected lossless reconstruction.

The paid acceptance harness is prepared by `node scripts/pi-report-acceptance.mjs OUTPUT`. Preparation makes no model calls. It uses checked-in public source/migration schemas with an isolated PGlite database, synthetic users and a multi-file options-resolution fixture. Its model proxy receives only synthetic task messages/tool observations; production model credentials stay at the existing trusted gateway. The fixture binds its own exact approval, checks real code and uses additional external assertions and a fixture draft publisher. It never confirms an owner job or publishes a real PR.

An initial remote launch was rejected by automatic approval review because a broad source/migration payload lacked explicit provenance. No paid call or production change ran. The test setup is being changed to an auditable public source revision and synthetic data before retrying. Paid results, actual CodeBuild checks, exact independent review and deployment remain pending; offline results are not a general reliability claim.

## Follow-up

Architecture/service ownership and a potential EC2 provider remain exploration in [issue 219](https://github.com/akhilvuputuri/chief-agent/issues/219), outside this fix. Release only after the agreed report/workflow checks and paid model acceptance are assessed; retain negative outcomes and separate real infrastructure/model evidence from synthetic delivery/publication and full owner-task acceptance.
