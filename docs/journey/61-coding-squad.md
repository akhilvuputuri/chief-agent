# 61 — A leader coordinates a fixed coder and reviewer

Work date(s): 2026-10-04. Status: implementation candidate; tests, exact-head independent review, migration 027/operator installation, image pin and release pending. Coding remains off; no paid/live acceptance.

## User-visible problem and preceding iteration

[Journal 58](58-coding-requirements.md) shipped enforced conversational requirement confirmation around a Python coder/reviewer loop. That loop was coordinated by program logic, without a task-facing model leader. The requested squad has three distinct members: Chief assigns the leader; leader delegates coding and exact review, returns requested changes to coder, and reports approved completion to Chief.

## Evidence

Implementation starts from freshly fetched main `c3cea89d0a666ba1b64bb9235648358fce27ce7d`. A bounded production read verified the same deployed SHA, healthy containers, migration 26, coding off/zero jobs and the existing Python/DeepSeek configuration. GitHub read/write/Actions access passed doctor. This establishes baseline installation, not live coding acceptance. No credentials or raw private traces are retained here.

Synthetic tests exercise real local Git/npm verification across leader → coder → reviewer → changes → coder → reviewer → leader. Separate tests reject skipped checks/self-approval/leader writes, preserve acknowledged handoffs on unknown member calls or failed checkpoints, share allocation and restore findings into fresh contexts without old review authority. Host tests cover leader model/cache/journal identity, attempt/scope/sequence fences, checkpoint CAS/idempotence and illegal/stale approval. The reviewed rollout regression checks exact DB/Compose changes and archive checksum. These are synthetic correctness tests, not measurements of coding quality, speed or provider cost.

A concurrent stock release integrated while this candidate was built. It is reconciled from main `baa5a72f024cb1200a20a24627e4b418b3c58472`; its stock lookup code/plugin pins are preserved and the squad candidate moves to v0.3.38. A separate bounded read verified live `7e8198517c141b0e64b93cf1d87f16001b9f2876`, healthy/off with migration 26; main documentation head alone is not deployment evidence. The installer baseline is refreshed accordingly before final review.

## Diagnosis and alternatives

Adding role names to a single conversation would not provide independent contexts or restricted responsibilities. The Python supervisor now executes fixed role-specific loops and validated typed handoffs. The model leader makes assignments; deterministic code still owns transition, verification, artifact and approval authority. One sequential sandbox is sufficient for this fixed squad and avoids introducing parallel file mutation or extra paid environments. The existing shared allocations and provider filters are preserved.

## Implementation and review

[Contract](../coding-squad.md): Python leader/coder/reviewer contexts, fixed dispatch tools, exact-artifact review, private fenced squad checkpoints and explicit recovery. Host model routing supports leader and keeps journal/price/auth boundaries. Migration 027 expands the role constraint only; existing coding-event JSON stores handoff history, so no new state table is required. `scripts/deploy-coding-squad.py` prepares a reviewed idle-only migration/Compose rollout from the verified baseline, with exact archive digest and rollback/preservation guards.

Independent review is pending. The source config initially keeps the old immutable image and legacy settings; the new image/squad/leader-model pin follows trusted-main publication. Runtime remains off through both phases. No worker can approve owner requirements, create extra agents, publish, merge or deploy.

## Verification and outcome

Local full checks passed: 705 application tests, 23 JavaScript script tests, 30 existing Python tests and 28 coding-runtime tests, plus typechecks/build/format. A final recovery-alias fix separates mutable supervisor state from the acknowledged checkpoint; its failed-ack regression and the affected suites were rerun. Cross-language tests validate squad checkpoint/owner scope identity. Exact-head independent review and Linux image validation remain required. Migration/operator installation, exact deployment and image pin remain unverified. Provisioning authentication/scoped AWS/project, GitHub App, auth/origin and ingress remain the live activation gap from journal 58. No paid sandbox/model job, data reset or automatic paused-task resumption occurred.

## Follow-up and next iteration

Complete independent review, install additive migration 027 with preservation proof, publish/pin the reviewed Python image, verify exact release, then run a bounded separately authorised live plan/confirmation/candidate cycle after scoped activation. Record actual role/model/call/check/cleanup evidence without inferring quality from mocked tests.
