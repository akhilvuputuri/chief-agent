# 61 — A leader coordinates a fixed coder and reviewer

Work date(s): 2026-10-04. Status: squad implementation reviewed/merged and migration 027 installed/verified; worker image published/anonymously verified; pin review/final release pending. Coding remains off; no paid/live acceptance.

## User-visible problem and preceding iteration

[Journal 58](58-coding-requirements.md) shipped enforced conversational requirement confirmation around a Python coder/reviewer loop. That loop was coordinated by program logic, without a task-facing model leader. The requested squad has three distinct members: Chief assigns the leader; leader delegates coding and exact review, returns requested changes to coder, and reports approved completion to Chief.

## Evidence

Implementation starts from freshly fetched main `c3cea89d0a666ba1b64bb9235648358fce27ce7d`. A bounded production read verified the same deployed SHA, healthy containers, migration 26, coding off/zero jobs and the existing Python/DeepSeek configuration. GitHub read/write/Actions access passed doctor. This establishes baseline installation, not live coding acceptance. No credentials or raw private traces are retained here.

Synthetic tests exercise real local Git/npm verification across leader → coder → reviewer → changes → coder → reviewer → leader. Separate tests reject skipped checks/self-approval/leader writes, preserve acknowledged handoffs on unknown member calls or failed checkpoints, share allocation and restore findings into fresh contexts without old review authority. Host tests cover leader model/cache/journal identity, attempt/scope/sequence fences, checkpoint CAS/idempotence and illegal/stale approval. The reviewed rollout regression checks exact DB/Compose changes and archive checksum. These are synthetic correctness tests, not measurements of coding quality, speed or provider cost.

A concurrent stock release integrated while this candidate was built. It is reconciled from main `baa5a72f024cb1200a20a24627e4b418b3c58472`; its stock lookup code/plugin pins are preserved and the squad candidate moves to v0.3.38. A separate bounded read verified live `7e8198517c141b0e64b93cf1d87f16001b9f2876`, healthy/off with migration 26; main documentation head alone is not deployment evidence. The subsequent exact main documentation release `baa5a72f024cb1200a20a24627e4b418b3c58472` was then separately verified healthy/off with migration 26; it is the refreshed installer baseline for final review.

## Diagnosis and alternatives

Adding role names to a single conversation would not provide independent contexts or restricted responsibilities. The Python supervisor now executes fixed role-specific loops and validated typed handoffs. The model leader makes assignments; deterministic code still owns transition, verification, artifact and approval authority. One sequential sandbox is sufficient for this fixed squad and avoids introducing parallel file mutation or extra paid environments. The existing shared allocations and provider filters are preserved.

## Implementation and review

[Contract](../coding-squad.md): Python leader/coder/reviewer contexts, fixed dispatch tools, exact-artifact review, private fenced squad checkpoints and explicit recovery. Host model routing supports leader and keeps journal/price/auth boundaries. Migration 027 expands the role constraint only; existing coding-event JSON stores handoff history, so no new state table is required. `scripts/deploy-coding-squad.py` prepares a reviewed idle-only migration/Compose rollout from the verified baseline, with exact archive digest and rollback/preservation guards.

GPT-6 Astra requested changes at `62fbf1298aeca125a526511588c495a19b0456cb`: post-action checkpoint errors could be swallowed and continue member execution, and a stale completion snapshot could rewind a newer acknowledged checkpoint. Both were reproduced independently. The fixes propagate post-action durable-write uncertainty as fatal to the member/squad loop and compare the previous checkpoint atomically in completion. New regressions stop remaining same-batch commands and retain the last acknowledgement, and prevent approved sequence 5 from overwriting acknowledged sequence 6. GPT-6 Astra APPROVED corrected head `52b2e4c305a442c7c884db4b49c9b70a4a8df1fc` after independently reproducing both fixes and passing 50 controller/29 Python tests plus rollout regression. [Exact-head Linux CI](https://github.com/akhilvuputuri/chief-agent/actions/runs/37140219676) passed; [PR #163](https://github.com/akhilvuputuri/chief-agent/pull/163) merged at `3b3bf8ca2a482e067a924b3b20e81adcab49b37e`. The source config initially keeps the old immutable image and legacy settings; the new image/squad/leader-model pin follows trusted-main publication. Runtime remains off through both phases. No worker can approve owner requirements, create extra agents, publish, merge or deploy.

## Verification and outcome

After main reconciliation, local full checks passed: 720 application tests, 23 JavaScript script tests, 30 existing Python tests and 29 coding-runtime tests, plus typechecks/build/format. A final recovery-alias fix separates mutable supervisor state from the acknowledged checkpoint; its failed-ack regression and the affected suites were rerun. Cross-language tests validate squad checkpoint/owner scope identity. The affected review-fix run passed 50 controller tests and 29 Python tests. Exact-head re-review and updated Linux CI remain required. Migration/operator installation, exact deployment and image pin remain unverified. Provisioning authentication/scoped AWS/project, GitHub App, auth/origin and ingress remain the live activation gap from journal 58. No paid sandbox/model job, data reset or automatic paused-task resumption occurred.

## Follow-up and next iteration

Complete independent review, install additive migration 027 with preservation proof, publish/pin the reviewed Python image, verify exact release, then run a bounded separately authorised live plan/confirmation/candidate cycle after scoped activation. Record actual role/model/call/check/cleanup evidence without inferring quality from mocked tests.

### Reviewed operator installation and image publication — 4 October 2026

The reviewed `deploy-coding-squad.py` installed merged archive `3b3bf8ca2a482e067a924b3b20e81adcab49b37e` with independently matched SHA-256 `92420bc4bf7a4c7517995be5a7732aabd21dcf57212baa5c00e4a553aaeb498c` from verified idle baseline `baa5a72`. It reported healthy migration 27. Separate bounded reads confirmed matching server RELEASE, healthy gateway/Postgres, migration 27, retained count equality, no active/pending inputs and coding off/zero jobs. The [normal exact release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37141325755) also succeeded. Historical schemas and existing integrations were preserved; no down migration or user-work cancellation occurred.

The [trusted main image workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/37141145109) published Python 0.1.2 from that exact merge at `sha256:abb2ab34c754ea3cf65deed80ec69b965a737ef3359de0c2ff26fa8bc1b7b4e6`. Anonymous requests verified index, Linux/amd64 manifest and config SHA-256 identities, worker user and isolated Python entrypoint. The pin candidate switches image, squad selector and DeepSeek leader model together. Pin review/exact release remain pending; no paid sandbox/model or live squad acceptance has run.
