# 141 — Can CI run test files four at a time despite an unexplained crash?

Work dates: 1 November 2026. Written: 1 November 2026.
Status: on [PR 389](https://github.com/akhilvuputuri/chief-agent/pull/389). CI only; coding boxes stay serial. The original crash remains unexplained.

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

Pending.

## Follow-up and next iteration

- **Watch for it:** a test job that fails with a process killed by SIGSEGV and no assertion failure. Record each one here, with its run, file and Node version, as well as rerunning it. Set `TEST_CONCURRENCY` back to 1 in `ci.yml` if they recur.
- **Weights:** test durations in parallel runs carry contention, so refresh `tests/test-weights.json` only if shards drift clearly apart.
- **Coding boxes:** measure before enabling it there, since journal 123 expected them to gain the most.
