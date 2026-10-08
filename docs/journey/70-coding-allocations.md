# 70 — Allocations sized for coding and visible to the squad

Work date: 8 October 2026. Status: worker foundation implemented; review/image publication and default activation pending.

## Problem and preceding iteration

The [indexed-continuation fix](68-coding-tool-index.md) allowed a resumed planner to make forty model requests, but it exhausted its allocation without a final report. Bounded production metadata measured 59 file-read requests, fourteen rejected command attempts, one plan read and one scoped log read. Planning never handed off to coder/reviewer. The default 15 minutes/40 model calls/100 tool calls was a bootstrap allocation, not a measured adequate coding workload.

The owner requested two hours, 400 model calls and 1,000 tool calls per attempt, shared by the fixed squad. This iteration expands the compatible host/worker contract, provides allocation hints, advertises the exact read-only command forms and preserves a specific exhaustion explanation. It does not claim that larger allocations alone solve task quality or that a live coding cycle has passed.

## Evidence and cost scope

Measured on 8 October for one resumed DeepSeek V4.1 Flash planning attempt: all 40 calls completed and included reported usage cost, totalling USD 0.0210415264; 1,045,880 input tokens, 681,984 cached tokens and 7,526 output tokens. Its Linux-medium CodeBuild build ran 131.714 seconds, rounded to three billed minutes. The official Singapore on-demand Linux `general1.medium` rate was USD 0.01/minute, producing an estimated USD 0.03 compute cost and USD 0.0510415264 combined. The earlier one-call attempt reported USD 0.0001792116 and one estimated build minute; both coding attempts together were approximately USD 0.061220738. These are reported model usage plus a compute estimate, not an invoice reconciliation; Chief conversation calls, fixed hosting, credits, tax and ancillary charges are excluded. Reviewer/output-heavy coding costs were not measured.

Source: [AWS pricing](https://aws.amazon.com/codebuild/pricing/) and its Singapore public pricing feed, inspected 8 October. No private prompts, code excerpts or job identifiers are included here. The new allocation is an engineering starting point, not an empirically optimal limit or a dollar cap.

## Implementation and rollout

Python 0.1.4 and TypeScript both accept up to 7,200,000 ms, 400 model calls and 1,000 tool calls. Squad checkpoint tool-usage bounds match. Each model request receives the real remaining shared call/tool allocation and deadline countdown; the note asks for a complete result or explicit blocker without bypassing checks, review or approved scope. Reasoning and tool arguments remain intact.

Planning, leader and reviewer command definitions enumerate the four existing exact read-only forms. Rejections return a fixed code, those forms and a safe correction hint rather than arbitrary exception text. Implementation keeps its existing sandbox shell capability. Known allocation exhaustion reaches the supervisor and its paused summary; uncertain action/checkpoint failures retain their separate handling. Owner-scoped status now exposes the job's actual pinned limits, including old attempts.

Rollout has two reviewed steps because the old Python image rejects the larger assignment:

1. Merge the expanded contract/package while leaving the current image and 15-minute/40/100 selector intact. Verify required checks and publish the main-only immutable worker image.
2. Independently verify the public digest/platform/package, then pin that digest and the two-hour/400/1,000 selector in a reviewed PR. Verify exact release and deployed effective configuration.

The original paused job retains its settings, checkpoint and history. It is not automatically resumed, repriced or silently assigned another image. New jobs after selector activation use the increased allocation; an ordinary old-job resume retains its pinned settings. Provider price filters, role models, approvals, cancellation, exact-artifact review and publication controls are preserved. CodeBuild gets a 125-minute per-build override to cover two active hours plus the existing provisioning allowance; no project, IAM, database or Compose change is needed.

## Verification and review

Regressions cover both language validation boundaries, assignment/provisioning/deadline/status and 800-tool checkpoints, corrected read-only requests, shared-budget exhaustion without replay, isolated reviewer contexts and exact indexed-call/reasoning preservation. Initial local checks exposed reused dependencies missing the newer parser package, position-based assertions needing adjustment for the allocation note, and a full local disk. Current locked dependencies were installed after removing only disposable artifacts created by this task; no shared checkout or production data was cleaned. The initial full check passed 960 tests plus type/Ruff/mypy/build; later long-context/countdown coverage passed 38 Python tests. Independent GPT-6 Astra review requested changes on `50ae92b`: appending an allocation hint before compaction made the newest undelivered tool group removable. The correction compacts before the hint and preserves the existing newest-group guard, with regressions for oversized opaque plan-read and write-result groups. Devin additionally identified the deadline timer’s cancellation path, which bypasses worker finish reporting. The host now records explicit deadline expiry before classifying a terminal sandbox; owner revocation and heartbeat loss remain separate, attempt-fenced reasons. Regressions cover expiry while running and after worker exit. Updated checks and final-head review are recorded on the implementation PR.

## Outcome and next iteration

Default activation and live acceptance are pending. This focused change does not add file search/list tools, broad progress telemetry, semantic completion grading or model-weight training. The offline [benchmark pack](66-coding-benchmarks.md) remains separate. A later owner-requested fresh planning job on the new image should validate whether it produces a usable brief, not merely whether startup and fixture tests pass.
