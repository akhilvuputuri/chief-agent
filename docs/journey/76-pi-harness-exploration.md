# 76 — Can Pi supply an independent coding runtime's basic mechanics?

Work date: 9 October 2026. Status: research and synthetic SDK validation; standalone implementation, paid acceptance and production switch pending.

## User-visible problem and preceding iteration

The owner reports that maintaining the fully custom coding harness leaves too many basic building blocks to implement and requests exploration of Pi. The owner subsequently clarified that Python compatibility is unnecessary, Chief's adapter can change, and the new runtime should be independent enough to move into a separate repository.

[Journal 75](75-coding-summary-repair.md) established guided planning acceptance after provider/summary and semantic corrections, not general autonomous coding quality. [Journal 73](73-coding-model-efficiency.md) proposes controlled comparisons. Those lessons inform the new design without requiring the old squad or gateway architecture.

## Evidence

- **Source inspection:** fetched Chief main `0547d4599ee6fd35666fabc9ebdf52b0fa04aec4`; read current instructions, work/handover, operations, coding contracts and host/worker source. [Exact release receipt](https://github.com/akhilvuputuri/chief-agent/actions/runs/37893930823) confirms deployment/startup health at 06:33:37 UTC, not current health or Pi acceptance.
- **Published dependency inspection:** Pi 1.1.0, release commit `abe508e1b89912adde45528136c3221eb69acdd7`; npm deprecates the old package name. Inspected the published SDK declarations, tool implementations and official documentation. [Research report](../pi-coding-harness.md) records the version/integrity and sources.
- **Synthetic experiment:** one local probe run after correcting its input shape, repeated after making its fixture directory portable. Both completed runs passed seven assertions with one synthetic provider response each and zero external model calls. Pi 1.1.0, Node 24.19.0, synthetic text files; no timing/quality/cost comparison. [Probe](../research/pi-sdk-probe.mjs) is retained for reproduction.
- **Compatibility observation:** default Node 22.15.0 triggered engine warnings; Pi requires >=22.19.0. An older direct edit input shape failed; the published `edits` array shape passed.
- **Counterexample:** Pi's default reader accessed a synthetic file above cwd. This verifies that cwd is not a filesystem boundary; no private file was used.
- **Capability preflight:** repository read/write and Actions-read available. Workflow mutation and fresh cloud access not tested.

## Diagnosis and alternatives

Hypothesis: adopting Pi's coding loop, tools, sessions and compaction reduces custom maintenance. Passing API assertions do not establish better semantic understanding or completed changes.

The initial exploration considered adapting Pi to Chief's existing custom gateway and squad/checkpoint controls. The owner's clarification removes that constraint. The proposed standalone runtime defines its own small task contract; Chief adapts to it. Prefer native Pi providers and, where Chief retains credential/policy ownership, a compatible Chief-side proxy. A custom Pi provider is a fallback rather than the default migration strategy.

A Python-to-Pi RPC supervisor and a lower-level pi-agent-core integration remain possible, but add unnecessary machinery for a TypeScript-first standalone package. No code fork, community orchestration package or multi-agent topology is needed for the first milestone.

## Implementation and review

This branch adds the research/design, a synthetic probe, and status/learning records. It does not add a production dependency or runtime implementation. The existing dirty checkout, runtime selection, models, allocations, paused jobs and deployment remain untouched. There is no independent implementation approval or live acceptance claim.

## Verification and outcome

The seven assertions cover line reads, targeted edits, stale-target failure, read-only tool selection, a custom provider/settled event, linear session restoration and cwd escape behavior. They do not cover gateway compatibility, actual model tool use, compaction quality, branching, cancellation, Linux isolation or correct feature implementation.

The next implementation is a self-contained package/CLI that learns, plans and builds an approved small fixture, stores its session and returns a checked artifact. Its build/tests must pass outside Chief's tree. Later work adds real-model acceptance, Chief integration and deliberate switching. Review/publication automation is separate.

## Coding-harness learning record

See the [dated learning entry](coding-agent-lessons.md#9-october--prefer-a-standalone-runtime-contract-over-compatibility-by-default). Preserve the engine/input failures and cwd counterexample. The next falsifying test is a fixed realistic task that fails scope retention or produces an incorrect patch under identical model/settings; synthetic SDK compatibility is not a task-quality result.

## Follow-up and release boundary

[The first-build plan](../pi-coding-harness.md#first-implementation-and-acceptance) defines the acceptance gates. No runtime image, production release, paid experiment, automatic resumption or new remote repository is part of this research. This candidate is for implementation planning; no release closure is asserted.
