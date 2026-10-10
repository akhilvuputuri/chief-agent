# 81 — Planning must converge before the sandbox ends

Work date: 11 October 2026. Status: implementation candidate; exact review, worker image activation and release remain pending.

## Problem and preceding iteration

[Journal 80](80-codebuild-timeout-mismatch.md) established that CodeBuild killed a later planning attempt after 45 minutes despite a requested 125-minute timeout. Its receipt guard prevented insufficient launches, but left two-hour Pi attempts unable to start. The owner asks to work within 45 minutes and refocus on the missing plan. Account investigation remains separate from runtime progress.

## Evidence and diagnosis

Measured privately inside the trusted gateway on 11 October: one retained DeepSeek V4.1 Flash planning attempt used 203 model calls. Its encrypted Pi history contains 169 assistant messages, 34 compactions and 246 navigation calls: 139 grep, 91 read, 12 ls and four find. There were zero report calls. There were 239 distinct argument hashes; only seven navigation calls repeated earlier arguments. This is sustained exploration without a result boundary, not evidence of an identical-call loop or repeated rejected plans. Three tool errors were observed; their private content is not published. No model call, job mutation or automatic resume was used for this inspection.

The earlier small arithmetic/provider fixtures did not test long repository exploration. Hypothesis: a bounded investigation followed by a mandatory report can produce a usable plan or an explicit evidence gap before repeated compaction consumes the whole attempt. This does not prove plan quality or justify omitting approved requirements.

Operator authentication was refreshed and a second zero-model disposable launch confirmed AWS still returned 45 for a 125-minute request. The disposable build was stopped. An AWS account-support inquiry was submitted without a support-plan upgrade; the reason remains unconfirmed. The [documented API](https://docs.aws.amazon.com/codebuild/latest/APIReference/API_StartBuild.html) accepts five to 2,160 minutes. Lifting that restriction is no longer a prerequisite for the chosen runtime changes.

## Implementation

Pi planning now ends its investigation after 32 settled navigation operations or ten minutes, with shorter allocations reserving their final quarter for reporting. The native Pi turn boundary waits for checkpoint acknowledgement and ends cleanly without aborting or replaying a model/tool operation. One report-only generation must cover the complete objective, affected components, proposed behavior and acceptance checks, or identify a specific evidence gap in a question. An ignored/invalid final report pauses visibly; it cannot continue navigation, approve a plan or fabricate completion. Error/length/uncertain provider outcomes and cancellation still stop rather than replaying a request.

New Pi jobs default to 40 active minutes and retain 400 model/1,000 tool allocations, selected role models, effort and price filters. The host also bounds explicitly resumed historical Pi attempts to 40 minutes without rewriting their saved settings/image or automatically resuming them. Launch/recovery requests therefore require a verified 45-minute sandbox receipt. Heartbeats do not extend the active deadline. Legacy Python allocation, source and image routing remain intact.

Runtime package 0.1.2 must be built into a new immutable main image and independently verified/pinned before new jobs receive the planning mechanism. The app-only host release can establish the 40-minute attempt ceiling sooner. Historical jobs continue using their saved older image; an explicit new task or separately authorized migration is needed to receive new worker code.

## Verification and outcome

Regressions exercise sustained exploration, report-only enforcement, missing evidence, short-time reporting reserve, durable checkpoint ordering, cancellation at handoff, historical Pi allocation, non-extending heartbeats and preserved legacy two-hour behavior. All 1,062 offline tests, typecheck, build and formatting passed. The first larger-repository paid trial used public main `a3a6d33b61ab5030a5de1a8544ff4c9b724852ce`, DeepSeek V4.1 Flash/high, native facade, guarded disposable Linux container and a ten-minute trial allocation. It reached the report-only boundary after 32 navigation operations, but a subsequent provider failure prevented a plan/question: paused after 270 seconds, 23 locally admitted generations, 22 successful billed generations, three compactions and USD 0.0166554776 reported cost. Failed-request billing is unknown. This negative result predates the focused-investigation prompt/checkpoint-order refinement; a follow-up with structural failure diagnostics is running. No owner job/preference/approval write or Telegram acceptance was involved. No accepted owner task or comparative cost/quality improvement is claimed.

## Review and release

Exact-head independent review, hosted Linux/Devin checks, exact deployment receipt, image publication/pin and current health remain pending. No database, Compose, credential or permission change is needed.

## Next falsifying test

Use the published worker on a separately authorized full task: verify the plan covers every requirement or asks a specific useful question, then verify approved implementation, actual checks and fresh review. Larger tasks may need explicit follow-up planning passes. A report boundary is a convergence mechanism, not proof of correctness.
