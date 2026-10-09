# 77 — Replace custom coding mechanics with an independent Pi package

Work date: 9 October 2026. Status: implementation candidate; independent review, hosted Linux checks, image activation and live acceptance pending.

## User-visible problem and preceding iteration

The owner requests completing the [independent runtime plan](../pi-coding-runtime-plan.md), with the old coding runtime untouched and Chief connecting to the new runtime after validation. [Journal 76](76-pi-harness-exploration.md) tested the published SDK and established compatibility, not task quality. [Journal 75](75-coding-summary-repair.md) retained the limits of the custom planner's guided acceptance. This iteration adopts a dependency for coding mechanics without claiming that Pi necessarily improves the model's understanding.

## Evidence

- **Baseline:** freshly fetched main `0547d4599ee6fd35666fabc9ebdf52b0fa04aec4`. GitHub read/write and Actions reads verified after rerunning restricted network calls. Shared dirty checkout preserved; implementation is in an isolated worktree.
- **Synthetic tests:** pinned Pi 1.1.0, exact Node 22.19.0 and Python 3.12.14; no external model calls. Pi's actual tool loop planned, required exact approval, fixed a seeded subtraction bug and ran a real Node assertion. False completion with a failing test remained paused.
- **Native protocol reproduction:** a loopback mock verified compatible SSE, complete tool continuation, structured reasoning metadata, Unicode and distinct call IDs. This does not validate paid provider behavior or live token streaming.
- **Boundary counterexamples:** initial tests exposed path canonicalization differences on macOS and direct edit API shape differences. Subsequent hardening includes signed task metadata, cross-client cancellation, allocation accounting, exact indexed UTF-8 export and routing Git filters through the same executor. These are reproduced safeguards, not measured quality gains.
- **Compatibility:** the full application/Python checks passed locally; later changed code still requires final exact-head checks. Old Python source, Dockerfile and image/default configuration are unchanged. New hosted Linux smoke/extraction checks are added.
- **Environment limitation:** local Docker startup cannot be completed while the Mac is locked; Linux CI is used rather than claiming local process-boundary verification.

## Diagnosis and alternatives

Pi supplies the loop, coding tool semantics, native model conversion, sessions and compaction. A small standalone package supplies workflow and client control. Chief's new bridge keeps application-specific lifecycle, authorization and policy outside that package. Native protocol support is added on Chief rather than porting the old Python gateway protocol into Pi.

The first candidate has one task-facing agent and optional separate read-only review at the publication boundary. It does not port the leader/squad checkpoint state machine. A library, CLI and JSONL transport make extraction testable. CodeBuild remains an adapter/runner choice, not a runtime import.

## Implementation and review

[Runtime contract and rollout](../pi-coding-runtime.md) links package, bridge, model facade, encrypted session entries, independent image workflow and reversible default selector. The backend remains legacy while the foundation is reviewed. Pi profiles prohibit auto-merge and Python harness selectors; existing jobs retain their stored backend/settings.

Exact-head reviewer verdicts, findings/fixes and hosted CI results will be recorded here when available. No independent approval or production activation is asserted yet.

## Verification and outcome

Synthetic fixtures validate mechanical execution, approval boundaries and actual check/artifact handling. They do not establish scope recall under real compaction, provider quality, accepted production code or a cost advantage. Node was upgraded in a temporary verified toolchain rather than overwriting the shared machine installation. Hash-locked dependencies and the exact Linux image are part of reproduction.

## Coding-harness learning record

See [the cumulative learning record](coding-agent-lessons.md). The next falsifying test is a fixed real task with independent scope/patch grading through the new route. A dependency, valid plan, passing tests or healthy startup is insufficient by itself.

## Follow-up and release boundary

Complete the independent reviewer loop and hosted Linux/extraction checks; release the default-legacy foundation; publish and verify the main-built immutable Pi image; then perform authorized acceptance and a separately reviewed selector change. Preserve old jobs and uncertain writes. No paid trial, owner-button forgery, automatic old-job resumption, new remote repository or deployment claim has occurred at this checkpoint.

## Integration counterexamples and corrections — 9 October

The complete local mock Chief-to-Pi trajectory exposed a GET heartbeat sent to a POST-only endpoint and an extra command-output truncation field rejected by the strict finish schema. Correcting the method and exporting only canonical check fields allowed planning, bound fixture approval, an actual edit/test/check run, a fresh read-only review and draft publication to complete. These are synthetic fixture records, not a real owner Telegram interaction or paid acceptance.

Hosted CI initially failed because a fresh checkout typechecked the Chief bridge before building the independent package declarations. The typecheck command now builds the package first. Tool execution is explicitly serialized to avoid process cleanup interfering with another tool. Reviewer handoffs bound output receipts without omitting approved requirements, and all phases use the same remaining attempt allocation. A fresh exact-head CI/review is still required.
