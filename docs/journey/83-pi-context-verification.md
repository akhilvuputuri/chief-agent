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
