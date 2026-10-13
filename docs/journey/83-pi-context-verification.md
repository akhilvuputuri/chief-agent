# 83 — Sustained coding must survive context maintenance

Work date: 13 October 2026. Status: in progress; failing reproductions established, no runtime correction deployed.

## Preceding iteration and observed failure

[Journal 82](82-pi-report-contract.md) shipped v0.3.69 and verified report transport, short paid workflows and infrastructure. A subsequent owner-approved implementation exhausted productive context before producing a saved patch. Structural private inspection measured 119 implementation model calls: 95 ordinary calls, 16 successful compactions and eight failed summary calls. The retained summary grew from 5,414 to 51,850 characters. The six approved-plan pages were reread 28 times in total. The final error was a local context-envelope rejection; the displayed result lost that cause. CodeBuild completed successfully before its 45-minute timeout. No raw task content or private reasoning is included here.

The previous 1,099-test count described the whole repository. Long-document tests primarily checked transport with scripted responses; the paid options-function fixture used small synthetic code and syntax checks under build/format labels. Those checks did not establish sustained real-repository completion. The [execution contract](../pi-runtime-verification.md) now distinguishes each gate and requires retained failures plus a fixed 24-attempt representative matrix.

## Failing baseline measurements

On unmodified v0.3.69 source, two new authenticated-facade/provider-wire tests reproduce both native output-limit fields being replaced: requested 4,096, provider received 16,000. No paid provider call is made by these regressions.

An actual Pi-session lifecycle fixture initially did not enter compaction; that invalid fixture was corrected to create actual context pressure and assert that compaction occurred. The corrected truncated-summary baseline made five compaction requests and four ordinary build calls before pausing with the generic `No valid report` result. The oversized-summary case likewise lost the cause. Both fail the required explicit compaction-failure contract. These are deterministic lifecycle counterexamples, not model-quality measurements.

## AWS follow-up

AWS Support's 12 October reply says the service team investigated and asks for new builds. A disposable zero-model probe on 13 October requested 125 minutes; both StartBuild and BatchGetBuilds returned 125, versus the earlier 45-minute clamp. The probe was explicitly stopped. This verifies timeout admission, not a 125-minute execution or a change to production job allocations. The existing 40-minute runtime allocation is retained while context correctness is tested. No support reply or case resolution was submitted.

## Current execution

A zero-model CodeBuild baseline is measuring the full public repository's real install/check/build/format commands at the pinned deployed source. Production credentials and owner job state are untouched. Concrete representative workload oracles, context repair, stress/recovery tests, the paid matrix, exact review and release remain outstanding. No passing acceptance or new deployment is claimed.

## Candidate correction and deterministic checks — 13 October

The unshipped candidate preserves native per-call output budgets and purpose through the authenticated facade, binds both to replay identity, and clamps requests to the existing role maximum. Pi now uses its native pre-compaction extension to create one replacement summary, checks projected size/shrinkage/headroom before persistence, and stops with a retained cause when compaction fails. It also checks workspace/observation progress at settled boundaries. Neither a successful report nor a failed maintenance request permits another implicit maintenance cycle.

A second baseline reproduced rejection of a 202-message transcript representing 100 small tool steps, despite fitting the 180,000-byte envelope. The Pi-only message bound is now 2,048; legacy validation and byte/model/tool allocations remain intact. Small-transcript and budget/replay facade regressions pass.

The package suite passes 62 tests. Actual native-session synthetic stress completed 100 tool steps with 32 compactions; the long immutable scope variant completed with 65. Small observations completed 100 steps without compaction. Unchanging observations paused after nine calls with context pressure or 32 without it. Truncated/oversized/disconnected compaction paused without subsequent investigation; cancellation remained cancelled, and reopening retained storage preserved the outcome, plan identity and counters. These controlled responses establish lifecycle mechanisms, not paid-model task quality. A post-report compaction regression first reproduced an unnecessary extra summary and now verifies none is admitted.

Trusted configured checks now receive decreasing remaining task time rather than the interactive shell's two-minute ceiling. A real subprocess test confirms checks share prior elapsed allocation; global runtime limits and interactive shell limits are unchanged. A first version of that regression used an invalid test-store method and failed; correcting the test to the actual store API produced the passing result above.

## Real-repository sandbox baseline remains unresolved

All these experiments use public v0.3.69 source and the published Pi 0.1.3 image, zero model calls and no owner-job writes. Install/build/format passed, while combined checks did not. Initial medium-sandbox runs lost whole test files to SIGKILL. CPU-affinity controls and a 1,024-MiB Node heap control still reached the approximately 7.25-GB cgroup memory limit and failed three workspace tests. An isolated Git/workspace control passed. A large-compute control likewise reached its approximately 15-GB cgroup limit and failed seven tests. Larger compute alone is not an accepted fix. One intermediate wrapper had a quoting/setup error and was discarded as infrastructure setup evidence, not a test result.

A medium-sandbox control with explicit serial test-file execution and a 768-MiB Node heap is in progress. It retains all assertions; its transient package-script change must be recorded separately from the unmodified baseline. No production compute configuration has changed. The paid matrix remains unstarted because an unresolved baseline invalidates representative model acceptance. Full local checks, workload oracles, real-gateway paid runs, independent review and release remain outstanding.
