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

## Independent review corrections — 9 October

GPT-6 Astra requested changes on `8b0fa27e4e17bc7fbd86f29f956ee475227a8c89` after reproducing three failures: replacement workspace cwd filtered out restored history; the guarded standalone CLI failed to wire native descendant cleanup; and abrupt interruption restored uncharged time. The corrected candidate explicitly opens the active session with its new cwd, uploads that exact file with preserved prefix, installs cleanup for default CLI executors, and persists a time reservation charged conservatively during interrupted recovery. A two-worker authenticated fixture retains the first worker's observation after explicit resume. Hosted CI now also tests the actual standalone guarded CLI entry with synthetic model traffic. Fresh review of the updated head remains required.

The earlier hosted Linux run passed the Pi bridge image/process smoke and package extraction, then failed the existing browser image build because its root build did not copy the new development package. Its builder now copies the package consistently; browser behavior and the old Python Dockerfile are unchanged. Passing part of CI is not a release or final CI result.

## Foundation review and image verification — 9 October

GPT-6 Astra approved exact implementation head `54f460e6e674af0bdcf00f8dd2362d37f0b1459c` after independently passing 17 package and 12 targeted Chief tests and repeating the interruption counterexample. [PR 204](https://github.com/akhilvuputuri/chief-agent/pull/204) merged at `5fa01cbeb2a8d54315f52c23d5a9ba5c35d98bef` after [exact-head hosted checks](https://github.com/akhilvuputuri/chief-agent/actions/runs/37921358766) and Devin passed. Its Git tree equals the approved head's tree. The complete local required checks passed 1,028 tests; hosted Linux validated both worker privacy/descendant cleanup and the actual standalone guarded CLI, plus package extraction. This establishes implementation/test evidence, not real-model quality. Foundation main release verification is pending at the time of this entry.

The [trusted main image workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/37922620221) published a new `pi-<SHA>` tag in the existing public package, preserving old Python tags/digests. Anonymous digest retrieval independently verified image index `sha256:7939ffdc9cde73d428ed0b74e79f8122d380f6fb99b7fdd5f9956ec9de9ddfe1`, linux/amd64 manifest `sha256:dcddef3ea19ccf4ffbf155aaa55d89ae14d09f033c842553cc6677a26733fad5`, user worker, fixed Node inspector-disabled bridge entry, installed Pi 1.1.0, all 14 compiled runtime/bridge JavaScript files matching the main-built local source, and a root-owned non-writable native guard. The follow-up pins this immutable image with default still legacy. No paid trial or default switch has occurred.
