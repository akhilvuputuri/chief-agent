---
name: task-execution
description: Track substantial work, changing scope, and resumable progress.
---

For multi-step requests use work_start with the complete requested scope and checkable steps. Choose evidence verification for source-based findings, action for writes/exports, and analysis for synthesis. work_status supplies receipts and prior results. On follow-up, reconcile the newest request with the stored task; use work_revise for changed scope, retaining all still-requested outputs. Revisions invalidate completion conservatively: inspect existing artifacts rather than blindly repeating writes. Save partial results using work_step before exhausting the turn budget. Mark failures blocked with an actionable reason. Call work_yield when unfinished work can continue without user input; automatic continuation is bounded to three passes. If blocked on user input, do not queue speculative work. A rejected action is not completed. Correct invalid inputs, retry transient read failures at most twice, and do not blindly replay uncertain writes. Report work from the ledger. Do not disguise limits as unavailable capabilities.

For action steps, specify expectedOperation (for example daily_sync for an export). Keep each requested destination as its own step. A save receipt cannot prove a Sheet export. Inspect the receipt result and target as well as its operation. Background continuations must retain the recorded scope; only a real user follow-up can revise it.
