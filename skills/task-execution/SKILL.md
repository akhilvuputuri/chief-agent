---
name: task-execution
description: Track substantial work, changing scope, and resumable progress.
---

For multi-step requests use work_start with the complete requested scope and checkable steps. Choose evidence verification for source-based findings, action for writes/exports, and analysis for synthesis. work_status supplies receipts and prior results. On follow-up, reconcile the newest request with the stored task; use work_revise for changed scope, retaining all still-requested outputs. Revisions invalidate completion conservatively: inspect existing artifacts rather than blindly repeating writes. Save partial results using work_step before exhausting the turn budget. Mark failures blocked with an actionable reason. Call work_yield when unfinished work can continue without user input; automatic continuation uses the persisted per-task execution allocation. If blocked on user input, do not queue speculative work. A rejected action is not completed. Correct invalid inputs, retry transient read failures at most twice, and do not blindly replay uncertain writes. Write natural progress and replies grounded in recorded results; /status provides the deterministic ledger. Do not disguise limits as unavailable capabilities.

For action steps, specify expectedOperation (for example daily_sync for an export). Keep each requested destination as its own step. A save receipt cannot prove a Sheet export. Inspect the receipt result and target as well as its operation. Background continuations must retain the recorded scope; only a real user follow-up can revise it.

When the request enumerates records or targets, use a separate research step for each target with its stable record ID in the key. Do not replace item coverage with batch-level completion; batching tool calls is fine. Keep research verification as evidence, persistence/export as action with the exact operation, and analysis only for reasoning over already retrieved inputs. Calling job_analyze or a list tool does not verify an external listing. Reading existing preparation does not prove newly requested assessments were saved. Never choose analysis to bypass evidence or write receipts.

The runtime queues unfinished, unblocked work at the end of a tracked turn, including iteration exhaustion, within the persisted time/model/tool budget. You do not need to finish with work_yield to make continuation happen. Mark steps blocked when a user answer or reconnection is required; do not leave a question as a pending runnable step.

A blocked target need not block unrelated targets. Mark any steps that depend on a missing answer as blocked too; leave only independently runnable work pending. The runtime continues while pending work remains and pauses when all remaining work is blocked or the execution allocation is reached.

Use finish_turn with awaiting_user or awaiting_approval when dependent work needs to pause, after marking those steps blocked and completing independent work. /continue adds another allocation without resetting completed steps. Tasks paused for cutover or restart are not new instructions; wait for the user to resume them.
