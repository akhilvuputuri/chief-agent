# 77 — Replace custom coding mechanics with an independent Pi package

Work dates: 9–10 October 2026. Current status: v0.3.61 Pi default released and healthy; real-model task acceptance remains unmeasured. Dated candidate observations below preserve the implementation/review history.

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

### Foundation release closure — 9 October 2026

[v0.3.59](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.59) is verified at foundation `5fa01cbeb2a8d54315f52c23d5a9ba5c35d98bef`. Its [exact production receipt](https://github.com/akhilvuputuri/chief-agent/actions/runs/37923924614) succeeded at 11:32:01 UTC after main checks; startup health passed. A separate bounded private heartbeat read observed the new gateway starting on that SHA at 11:31:37 UTC. The earlier host snapshot was on the prior SHA and is not relabelled as current foundation health. No DB/Compose migration, old-job resumption, model trial or default selection change occurred. The verified image pin and its own release remain separate; real-model acceptance and cutover await explicit authorization.

### Verified image-pin release closure — 9 October 2026

[PR 205](https://github.com/akhilvuputuri/chief-agent/pull/205) received independent approval of exact head `69ff5688014e86d537646b1e5e995ec80da32ebb`, passing hosted checks/Devin and a second independent anonymous image/source verification. [v0.3.60](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.60) is deployed at `e793a91f445947d6b6991905144b8876d12787e1`; [exact receipt](https://github.com/akhilvuputuri/chief-agent/actions/runs/37927101507) succeeded at 12:02:19 UTC with startup health. A separate bounded private read observed the gateway starting on that SHA at 12:01:55 UTC. The host snapshot available at 12:04 still named the prior foundation SHA; a later bounded read observed `e793a91f445947d6b6991905144b8876d12787e1` at 12:11:57 UTC with gateway and Postgres healthy, backup successful and log exporter active. These are startup/host observations, not a real-model acceptance result.

The independent runtime, CLI/RPC, Chief bridge and verified immutable image reference are built and shipped. `config/coding-backend.json` remains legacy; `coding_runtime/`, its Dockerfile/config image pin and all stored old jobs are preserved. No paid acceptance, new repository, default Pi selection or automatic merge authority has been granted. The separately authorized real-model trial and normal owner Telegram implementation decision are the remaining acceptance boundary before a new-task switch.

## Owner-authorized new-task default — 10 October 2026

The owner explicitly requests switching Chief's default to Pi now. This supersedes the earlier plan to wait for paid acceptance before changing selection; it does not establish a real-model result or authorize fabricating a Telegram approval. Baseline is freshly fetched main `9a20ee3a9e0b16a29d708c4fba21cc85b06f935f`. The app-only v0.3.61 candidate changes `config/coding-backend.json` to Pi and uses the already independently verified immutable worker image. Python source, Dockerfile, profile, stored jobs and uncertain-write handling remain intact. Models, effort, provider filters and allocations do not change. Pi remains draft-only with normal owner-bound implementation confirmation.

A synthetic controller regression reads the bundled profiles, starts a legacy job, switches controllers, retries the original request and creates a new Pi planning job. It verifies immutable saved settings/image, unchanged allocations, no automatic sandbox/model invocation, legacy cancellation through the new controller, and rollback affecting only future tasks. Required checks and exact-head independent review/release remain pending at this candidate. No paid acceptance task is run; actual Pi task quality and provider behavior remain unmeasured. Cloud/local release parity uses the existing GitHub path; a first owner Telegram task remains the live behavioral check.

## Default-switch release closure — 10 October 2026

[PR 207](https://github.com/akhilvuputuri/chief-agent/pull/207) merged at `76792d9a51ca6069ba6dda18e94ef44dc3394441` after independent approval of exact head `397b6eaffda93fb45919af5c1c0cbae98c817613`, Devin and hosted checks. The independent reviewer was explicitly configured GPT-6 Astra, with precise serving identity unavailable in its session; it passed 95 targeted tests and an additional executable queued-legacy/uncertain-create/ownership/duplicate-request probe. Full local checks/build/format passed 1,029 tests; hosted Linux/extraction checks passed.

[Exact release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37978324102) succeeded at 2026-10-09 19:13:13 UTC (10 October SGT), with deployment/startup health. Separate bounded diagnostics observed the same running SHA at 20:17:48 UTC and gateway/Postgres healthy at 20:18:14 UTC, with backup successful and exporter active. Immutable [v0.3.61](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.61) identifies the switch.

Pi is the configured default for new coding requests, using the previously verified immutable image. Python source/profile/image and existing stored jobs are unchanged; old-request identity, legacy cleanup/cancellation, normal owner implementation approval and Pi draft-only publication remain intact. No old job was resumed, no paid trial or live Telegram acceptance was performed, and no quality/cost benefit is inferred. The first real owner task remains the behavioral acceptance boundary.
