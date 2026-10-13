# Pi runtime verification execution contract

Work started 13 October 2026 from integrated/deployed `e4b71ad71d92a4de974c7f75943499cbc6725491` (v0.3.69). This document defines gates, not a completion claim. Existing owner jobs remain paused and unchanged. Architecture/service extraction is separate.

## Gate 1: reproduce before repair

Use the actual Pi SDK/session and authenticated Chief facade. Capture the final provider HTTP request. A summary request for 4,096 tokens must not become the job maximum of 16,000. Exercise both native token fields and request identity. Native automatic compaction must actually execute in lifecycle tests; a test that never compacts is not evidence. Reproduce truncated and oversized summaries, continued investigation after failure, and loss of the actual pause cause. Retain the failing baseline commit and sanitized counters.

## Gate 2: context and failure contracts

Preserve valid per-call token budgets within the existing job maximum, including replay identity and invalid/conflicting native fields. Classify compaction separately from ordinary generations. Failed or ineffective compaction must produce a durable, specific outcome and cannot silently trigger more provider requests/investigation. Assert total projected request size and headroom, rather than merely a summary character limit. Preserve original requirements, immutable document identities and saved artifacts. Exercise at least 20 context transitions and 100 deterministic tool turns, including successful shrinkage, increasing summaries, truncation, disconnect, cancellation, restart and uncertain calls. Validate no duplicate writes or implicit owner-job resumption.

## Gate 3: real repository baseline and frozen oracles

Pin target source to the public Chief repository at the baseline above. Measure unmodified `npm ci`, `npm run check`, `npm run build` and `npm run format:check` in the actual worker environment before paid coding. Do not rename syntax checks as build/format acceptance. A check that exceeds the harness command deadline exposes a runtime gap; do not weaken the check to obtain a passing run.

Prepare three isolated workloads with explicit requirements and external acceptance oracles: a narrow existing defect, a change spanning multiple application modules, and a larger coherent change that forces context maintenance. Freeze concrete task definitions, permitted paths and independent tests before paid runs. Require baseline failure for the target behavior and baseline success for unrelated checks. Do not use padding to stand in for semantic complexity or alter goals after a failed attempt without creating a separately identified workload revision.

## Gate 4: paid matrix

Run each of the three frozen workloads twice under each configuration: DeepSeek V4.1 Flash/GPT-6.1 Sol; GPT-6.1 Sol/Claude Sonnet 5.5; Claude Sonnet 5.5/GPT-6.1 Sol; Gemini 3.8 Flash/GPT-6.1 Sol. This is 24 planned attempts, not a reliability estimate. Keep selected effort, price filters and job allocations intact. Use the actual candidate model adapter/parameters; a helper must not replace native per-call budgets. Positive cases require correct artifacts, real repository checks and separate read-only review. A pause is not successful implementation. Retain every failure, diagnosis, retry and revision change; stop the matrix when a known unresolved defect would invalidate further runs.

## Gate 5: artifact and operational path

Verify the pruned gateway dependency closure, independent worker package and actual immutable image. Exercise CodeBuild, authenticated gateway, checkpoint persistence/restart and isolated publication. Identify simulated approval/delivery explicitly; never fabricate approval for an owner job. An actual draft-publication canary must use a dedicated test branch and preserve normal permissions. Secrets stay in their existing broker; no production database/transcript copies or raw traces in public artifacts.

## Gate 6: review, release and acceptance

Require exact-head independent review, passing relevant/full/hosted checks, image verification and a guarded release. Verify the exact deployed SHA, current health, effective worker image and unchanged historical jobs. Then run the controlled canary against the released artifact. Report per-workload results and limits. Do not claim a general runtime fix from infrastructure health or small fixtures alone.

## Scorecard

For each attempt retain source/runtime/image identity, workload/oracle revision, selected role models, final state, model calls by purpose, tool operations, first saved change, unique/repeated reads, document rereads, compaction input/output/projected sizes, preserved requirement IDs, saved patch/check receipts, review verdict, publication identity, elapsed time, reported model cost and missing billing. Record setup failures separately from model/workflow outcomes. Raw source observations, private reasoning and credentials stay out of the scorecard.

## Prepared workload/oracle revision 2

The manual [manifest](../scripts/pi-acceptance/workloads.json) defines three disposable candidates: runtime-neutral approval wording, job-pinned execution status, and an owner-scoped current-attempt model-call audit. These are acceptance workloads, not proposed product changes to merge. The [oracle template](../scripts/pi-acceptance/oracles.ts.txt) is kept outside agent workspaces and uses the baseline controller fixture, independent expected outputs, strict schemas, actual database rows and owner/attempt boundaries. Full repository checks remain separate requirements.

Prepare it with `node scripts/pi-acceptance/prepare-oracle.mjs /absolute/candidate /absolute/external-output`, then run the generated test with `PI_ACCEPTANCE_WORKLOAD` set to a manifest ID. This command makes no paid calls or approvals. All three oracles fail against the pinned baseline and pass against separate disposable reference implementations. An initial audit-oracle typo called the wrong JobTools method; the positive control caught it, and the oracle was corrected to the actual `execute` entry point before any paid run. The reference implementations are not provided to coding agents. The runner must reject changes outside permitted paths or to the base/dependency/check scripts. Independent grading must occur after the coding process ends, against its exact saved artifact in a fresh workspace; do not expose a writable oracle to an active agent. These runner gates are not yet implemented.

The larger workload still requires measured native context maintenance during real execution; its size/name alone is not proof of that gate. Runtime/image and oracle identities must be frozen together in each paid attempt's scorecard. Paid execution remains blocked on the unresolved real-repository sandbox baseline.

The original e4b71ad sandbox baseline failed from accumulated embedded-database memory. Revision 2 moves the target to reviewed candidate `9abd9d0b0d5042a89e773db463cf78f00e52539b`, whose unchanged complete assertions pass on medium CodeBuild after test-process partitioning. The independent fixture remains frozen at e4b71ad. This prerequisite correction and strengthened profile oracle happened before any paid attempt; task objectives remain unchanged. Candidate source is deliberately distinct from integrated/deployed main.
