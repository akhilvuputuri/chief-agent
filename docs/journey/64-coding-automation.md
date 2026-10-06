# 64 — One squad review, MR feedback and guarded merge

Work date(s): 2026-10-07. Status: v0.3.42 candidate; independent review, final CI, image pin/App read-scope setup and exact release pending. Coding remains on at the preceding verified release; the automatic selector is not yet enabled.

## Preceding iteration and requirement

[Journal 61](61-coding-squad.md) installed and activated a fixed Python squad; [journal 63](63-coding-topic.md) routed its progress and decisions. Publication stopped at a draft PR. The owner requested MR feedback handling and automatic ordinary-change merge, clarified that the existing independent squad review should suffice without an unconditional final pass, and added Telegram model selection and useful log access.

## Baseline and evidence

Fresh integrated main and the preceding verified deployment are `471f6f68d311d2a3c7ed188196d1a087fdfb6b8a`. GitHub repository read/write and Actions-read access passed doctor. Source confirms separate review contexts, protected requirement confirmation, encrypted host model journals, immutable worker image and draft-only publisher. Devin's GitHub status is readable and attributed to `devin-ai-integration[bot]`; its external report is a link, so GitHub feedback availability is a distinct boundary. Existing provider price filters exclude an automatic Astra switch; the clarified implementation retains the configured reviewer/filters and explicitly updates the owned-squad review policy.

## Decision and implementation

[Contract](../coding-automation.md): one reviewer loop, host-bound artifact/Git-tree/head identity and deterministic CI/feedback/merge/release gates. The host uses private suppressed coding events for durable automation/budget state, so no database migration or Compose change is needed. Feedback returns to the same approved scope in fresh member contexts, preserving remaining model/tool/active-time allocation; the existing PR is updated without force. Protected paths retain explicit review/operations. Unknown merge results are reconciled without replay; exact release receipts are verified independently of merge.

Owner model-role choices use append-only owner-scoped records and a live eligible-model catalog. New jobs capture choices; running/approved jobs do not change. The Python worker gains a bounded owner-scoped operational diagnostic read through Chief, with existing structural projection and no raw conversations/credentials. Python package 0.1.3 must be published/pinned before the automatic selector is enabled. The App needs reviewed additional read-only check/status/Actions access; write/administration/workflow permissions are not widened.

## Verification and limits

The first full local check passed 764 application tests, 50 script tests and 30 existing Python tests; one new Python test used the wrong Workspace.git return type and was corrected. The affected Python suite then passed 32 tests, including bounded log reads and shared-tool recovery; the existing 51 coding/controller/confirmation tests passed. Focused automation/telemetry tests passed, including actual encrypted reviewer-journal binding rather than trusting a worker report. Final full checks/review/deployment evidence will be appended after completion. These are synthetic correctness results, not coding-quality, model-cost or live merge measurements. No paid model/CodeBuild acceptance job has run.

## Next step

Complete exact-head independent review/CI, release the implementation, publish the trusted Python image, obtain the App's additional read-only scope and pin image/automatic selector through a reviewed follow-up. Verify exact release, current health and effective policy. Then run a separately authorized live plan/confirmation/repair/merge cycle with actual cleanup/release evidence. The source default-off coding switch and existing paused-work boundaries remain intact.

### Independent review/fix checkpoint — 7 October 2026

GPT-6 Astra REQUESTED CHANGES at `91cc27d924248ad26843c5b0e439081177882022`: the protected-path gate omitted Python execution/isolation/approval/dependency code and the plugin capability registry; an independent full automation reproduction merged a worker.py change. It also reproduced a row-limited diagnostic read incorrectly reporting no truncation. The fixes protect the complete coding_runtime/plugins trees and runtime/model policy owners, and query an extra row with per-category hasMore flags while retaining the byte bound. New full-path automation and event/call/run cap regressions cover both findings. The original full local check subsequently passed 769 application, 50 script, 30 existing Python and 32 worker tests; affected fixes and a new exact-head review remain required. No automatic selector or App permission was enabled from the rejected head.

A live read-only check of the draft feature PR showed no Devin status. Marking that independently approved PR ready triggered Devin Review. The automatic workflow therefore needs an early ready transition after artifact/protection gates, before waiting for Devin; readiness itself never authorizes merge. Added a durable readiness phase and a regression proving an approved ordinary draft becomes ready while merge count remains zero until required statuses pass. Protected candidates remain drafts. This lifecycle fix requires another exact-head re-review.

### Devin feedback before release — 7 October 2026

Devin's overall status passed at `71a0c53`, but its GitHub inline comments contained four actionable findings. They were inspected instead of treating the pass label as an absence of issues. Model preference reads were split from `coding_model_set` writes, with actual restart recovery regression coverage. The host now freshly rechecks feedback/check state after attestation and before merge claim; late feedback returns to the coder. The reviewer proof requires complete contiguous plan pages actually delivered in requests for the same handoff/artifact, including codepoint offsets and prior request coverage, not a current same-batch tool call. Security/plugin-execution/registry modules joined the manual-review boundary. Fifty-two affected automation/telemetry/proof tests and typechecks passed. This changed head requires fresh independent review and CI; no rejected/older approval was used for release.

Live GitHub inspection also showed Devin posting trusted resolved replies against earlier inline findings. The feedback reader now respects GitHub-resolved thread state and exact-parent, newer trusted Devin resolution replies; it does not send resolved notices back as new repair work. Spoofed resolutions, edits newer than a resolution and missing chronology retain feedback. The bounded thread query and regression coverage require re-review of the changed head.

Re-review REQUESTED CHANGES at `06383f2`: a historical Devin resolution reply could suppress a thread explicitly reopened in GitHub without editing its root comment. The textual fallback was removed. Only authoritative current GitHub thread state closes inline feedback, and merge gates now require zero unresolved threads, including already handled fingerprints and the fresh pre-merge inspection. Reopened-thread regressions exercise the actual GitHub reader and full automation path. No resolution/dismissal write is added.

The reopened-thread fix passed 56 affected automation, GitHub, review-proof, feedback and operational projection tests and both TypeScript typechecks. This remains synthetic validation; exact-head re-review and hosted checks are required before merge.

### Integrated implementation — 7 October 2026

[PR #172](https://github.com/akhilvuputuri/chief-agent/pull/172) merged at `0cb710c2653324d8f4d99adf566b6fefa547dd6b`. GPT-6 Astra [approved exact head](https://github.com/akhilvuputuri/chief-agent/pull/172#issuecomment-6024160620) `182fbdc7aa93ab0eee24f27072cfab3d56981fe7`, independently passing 40 focused tests plus five failure scenarios. Exact-head [Linux checks](https://github.com/akhilvuputuri/chief-agent/actions/runs/37521208393) and Devin passed; all four earlier inline findings were fixed, independently reviewed and resolved. Main release and Python 0.1.3 image publication/pin remain pending. The additional App read-scope request is awaiting owner approval, so automatic merge remains off. Log access and role preferences can ship independently of that permission expansion.

### Worker image follow-up — 7 October 2026

The trusted-main [image publication](https://github.com/akhilvuputuri/chief-agent/actions/runs/37522280197) succeeded for `0cb710c2653324d8f4d99adf566b6fefa547dd6b`, Python package 0.1.3. Anonymous index/manifest/config verification confirms linux/amd64, non-root worker and `python -I -m chief_coding_runtime.worker` at `sha256:d4be34f01a98a82acf03635d3d44061c2488ed9ed0fbd9cda7b0c46b96f151c8`. The follow-up pins only that image; model/effort/allocation/price settings are unchanged and automatic merge remains absent pending owner approval for App read scopes. This enables the new logs_read tool when the pin is deployed. Exact pin-head review/checks and production verification remain required.
