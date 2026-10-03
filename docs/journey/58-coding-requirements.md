# 58 — Chief asks for requirements, then waits for the owner

Work date(s): 2026-10-03. Status: implementation candidate; checks, independent review, new Python image pin and release pending. Coding remains off; no paid/live acceptance.

## User-visible problem and preceding iteration

[Journal 57](57-python-coding-runtime.md) shipped Python execution behind Chief’s TypeScript gateway. The owner should describe a Chief bug or feature conversationally, review its requirements, and confirm before implementation. Inspection of fresh main `591ee4af071f9128b2c56ab82feda386d2a6f77e` found that the backend supported planning and revisions but still accepted direct implementation dispatch. A planning capability alone was not an enforced confirmation boundary.

## Evidence

Code inspection, not a production incident: `coding_start` accepted both modes and `coding_reply` could select implementation. Synthetic controller and Telegram tests now exercise planning, owner/message/scope binding, expiry, duplicates/races, decline, uncertain delivery, direct text confirmation, immutable checkpoints and explicit resume. Python regressions cover non-empty briefs and ignoring unapproved replacement plans in an implementation report. These tests make no model-quality or paid provider acceptance claim.

Private activation preflight verified healthy production at `591ee4a`, Python image/DeepSeek policy present, coding off and zero jobs. Scoped AWS/project, GitHub App, auth/origin/commit metadata and worker ingress were not configured. The local log-reader authenticated; provisioning profile `chief` required `aws login`. No credentials or private traces are retained here. Activation is separately pending that access and the [reviewed setup](../coding.md#operator-activation).

## Diagnosis and alternatives

Prompt-only instructions could request consent but could not prevent a model from selecting implementation. The host now treats a delivered owner-bound requirement brief as authority. Existing coding event JSON stores the proposal and decision; no database migration or general approval-operation expansion is needed. Telegram buttons and explicit replies to the exact requirement message offer conversational use without slash commands. A bare unrelated yes cannot select among multiple outstanding scopes.

## Implementation and review

Every new job plans first. The plan-ready transition atomically creates its requirement event. Full brief delivery precedes its confirmation button; only a recorded complete send grants a usable message binding. The host queues implementation once after cleanup, with a frozen scope and revision. Models cannot confirm requirements. Changes replan and invalidate previous approvals; explicit unchanged resume preserves the context/approval. Host checkpoint/completion/provisioning guards enforce the approved plan, and the Python worker preserves it. Empty planning reports must be corrected before finishing.

GPT-6 Astra requested changes at `41fe7c697cd84be56c291aabe60ddb7a334cdd0f`: a post-commit acknowledgement failure could falsely claim implementation had not started, and decline did not advance the locked revision used to fence a concurrent approval. The fixes separate confirmation from acknowledgement/receipt delivery, retain uncertainty without false non-start claims, and advance/audit every decision through the job revision. Regressions cover both button/text acknowledgement failure and decline/approve concurrency. Corrected-head re-review is pending. Passing checks alone are not approval. Existing paid allocations, provider filters, owner scoping, cancelled/uncertain writes and private journals are preserved; no automatic merge, deployment or paused-task resumption is added.

## Verification and outcome

Local full checks passed: 679 application tests, 22 JavaScript script tests, 30 existing Python tests and 20 coding-runtime tests, plus typechecks/build/format. After the final brief-boundary change, affected checks reran: 47 coding/controller/Telegram tests and 20 Python tests passed. Exact-head independent review and Linux image validation remain required. Runtime activation and one plan → confirmation → draft PR acceptance run require provisioning/App/ingress setup and remain unperformed. No production keys were copied, no sandbox was provisioned and no paid model call was made.

## Follow-up and next iteration

Obtain exact-head review, publish/pin the Python 0.1.1 image, verify the exact release, then complete scoped activation after provisioning authentication is refreshed. Test conversational requirement confirmation first, followed by a bounded harmless candidate, cancellation and checkpoint recovery. Keep live findings separate from synthetic proof.
