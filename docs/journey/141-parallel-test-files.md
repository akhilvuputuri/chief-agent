# 141 — Can CI run test files four at a time despite an unexplained crash?

Work dates: 1 November 2026. Written: 1 November 2026.
Status: released in `a02cbd8` ([PR 389](https://github.com/akhilvuputuri/chief-agent/pull/389)). CI only; coding boxes stay serial. The original crash remains unexplained.

## User-visible problem and preceding iteration

The test shards set `checks`' wall time after the Pi split ([journal 139](139-ci-audit-pi-split.md)). Running test files in parallel is the largest remaining gain, but [journal 123](123-faster-checks.md) records a SIGSEGV at four files at a time and the owner's choice of serial files.

## Evidence

**Measured ([journal 139](139-ci-audit-pi-split.md)):** no crash in 102 shard jobs at four files at a time, or 17 whole-suite runs, on Node 22.23.4 and GitHub's runners. That bounds the rate at about 3% per shard job and 16% per six-shard run, at 95% confidence, assuming independent jobs. Journal 123's crash was one in two whole-suite runs on Node 22.19.0, with three shards.

**Not measured:** coding boxes.

## Diagnosis and alternatives

- **Stay serial:** rejected by the owner. A crash fails the required `test` check visibly, and rerunning one shard is cheap.
- **Parallel everywhere:** rejected. Coding boxes run the same `test:ts` through `kite run check`. A crash there would fail a real coding job rather than a rerunnable CI shard, and their CPU and memory have not been tested with parallel files.

Journal 123's condition for retrying asked for a cause or fix as well as repeated runs. Only the repeated runs are met. This decision accepts that, on the owner's say (1 November).

## Implementation and review

- **`scripts/test-shard.mjs`** reads `TEST_CONCURRENCY`, defaulting to 1.
- **`.github/workflows/ci.yml`** sets it to 4 for the test shards.

## Verification and outcome

**Measured, run 41227010626 on this change:** wall time 138 s, against 164–168 s with the Pi split alone. `test:ts` took 59–86 s and the test jobs 79–107 s. `scripts, evals and Python runtime` (119 s) and `Pi worker boundary` (118 s) now set wall time. The shards ran 1,428 tests: 1,427 passed, 0 failed, 1 skipped.

**Measured, first real docs-only PR ([PR 388](https://github.com/akhilvuputuri/chief-agent/pull/388), run 41226844802):** 70 s with every code job skipped, which proves [journal 140](140-docs-only-checks.md)'s decision on a real diff.

### Release closure — 1 November 2026

Merged as `a02cbd8`. Independent review (Claude Opus 5.5) approved the merged head `e7a74c3`, whose CI took 136 s (run 41227270155). `checks` on main passed in 151 s with the gateway image (run 41227670597). The automatic release (run 41227879255) succeeded with a healthy gateway. Release run 41227899983 failed at "Verify current main" as designed: it was for `d5ac1a3`, already superseded. Nothing changes in production.

## Follow-up and next iteration

- **Watch for it:** a test job that fails with a process killed by SIGSEGV and no assertion failure. Record each one here, with its run, file and Node version, as well as rerunning it. Set `TEST_CONCURRENCY` back to 1 in `ci.yml` if they recur.
- **Timing tests:** a few tests assert absolute wall-clock limits, such as `tests/otel-content.test.ts` under 500 ms. They passed in all 114 parallel shard jobs, but contention could make them flaky, and that failure would look different from a SIGSEGV.
- **Weights:** test durations in parallel runs carry contention, so refresh `tests/test-weights.json` only if shards drift clearly apart.
- **Coding boxes:** measure before enabling it there, since journal 123 expected them to gain the most.
