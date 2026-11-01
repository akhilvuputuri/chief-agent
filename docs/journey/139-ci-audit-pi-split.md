# 139 — What still limits a CI run, and is it safe to run test files in parallel again?

Work dates: 1 November 2026. Written: 1 November 2026.
Status: Pi job split, released in `9fdbca7` ([PR 386](https://github.com/akhilvuputuri/chief-agent/pull/386)). Test files stay serial until the owner decides; see the stress run below.

## User-visible problem and preceding iteration

[Journal 138](138-faster-ci-checks.md) brought `checks` to 180–183 s and named the Pi job as the next limit. An article on speeding up CI suggested faster runners, skipping per-file app reloads and other changes, so we measured which of them apply here.

## Evidence

**Measured, the last 30 successful runs of each event type:**

| Measure                  | Pull requests        | Main                 |
| ------------------------ | -------------------- | -------------------- |
| Wait for a runner, a job | median 4 s, p90 61 s | median 4 s, p90 21 s |
| `actions/checkout`       | median 2 s           | median 1 s           |
| `setup-kite`             | median 2 s, p90 5 s  | median 3 s, p90 6 s  |

**Measured, two runs after journal 138's final weights (41215085273, 41214790029):** `kite run test:ts` used 59.9% of all summed step seconds. The Pi job took 133 and 172 s, of which one Docker and independence step took 83 and 112 s.

**Measured locally, on a 10-core Mac:**

- `tsc --noEmit` took 4.4–4.6 s on TypeScript 5.9.3 and 1.2 s on 7.0.2, with no errors on either config. Compiled output was not tested.
- All test files with no test isolation used 685 s of CPU, against 727 s at four files at a time with isolation. The two runs differ in concurrency, so this is only a rough bound. It reported 1,417 tests, not 1,422.

## Diagnosis and alternatives

- **Faster paid runners:** rejected. Waits are small, and GitHub's runners are free for this public repository.
- **No test isolation:** rejected. It saves little, and five tests went unreported.
- **Blobless clone and cache seeding:** rejected. Checkout and setup already take seconds.
- **Oxlint:** not applicable. The repository has no lint script to replace.
- **Parallel test files:** promising but not adopted here. [Journal 123](123-faster-checks.md) records a SIGSEGV at four files at a time and the owner's decision to run serially. It allows a retry only with a cause or fix for the crash, measured over repeated runs.
- **Splitting the Pi job:** adopted. Its package checks don't need the images.

## Implementation and review

- **`pi` ("Pi package")** runs `check:pi` and the independent-copy check.
- **`pi-worker` ("Pi worker boundary")** builds the images and runs the container smoke tests and `box-docker`.
- **The required `test` gate** now needs both jobs. Every command from the old job still runs.
- **`pi` no longer runs `kite run build`:** `check:pi` builds Pi itself, and its tests did not need the root build. `pi-worker` keeps it for `dist`.
- **`tests/portfolio.test.ts`:** see the flaky test below.

## Verification and outcome

**Measured, split job, two runs (41224227641, 41224599934):** wall time 164 and 168 s. `Pi worker boundary` took 119 and 122 s, and `Pi package` 91 and 95 s. Both ran the expected tests: one in `box-docker`, and 109 in each Pi test run.

**Measured, serial runs before the split, all at journal 138's final weights:** PR runs took 172 s (41222337689), 209 s (41222503360), 212 s (41214790029) and 326 s (41222961479); the old Pi job took 150, 201, 172 and 209 s. Journal 138's three final-weights runs took 180–183 s. So the split saves about 12–19 s against journal 138's figures, and the slowest test shard (154 and 160 s on the split runs) now sets wall time. The 326 s run is not a fair baseline: its jobs waited 15–179 s for a runner. It overlapped this work's 30-shard stress run, which probably caused the queue (hypothesis).

**Flaky test found by the first run, cause by elimination.** `tests 3/6` failed on an assertion that the sealed token box does not contain `r1`. The sealed test box is 59 bytes, so two chosen bytes appear by chance about 1 run in 1,100 (57–58 positions in 65,536). The failing box was not captured, but the log shows that assertion and the box is random on each run. It now looks for `"r1"` and `"a1"` with their quotes, as they appear in the sealed JSON, which still catches an unsealed box.

**Measured, parallel test files, on Node 22.23.4 and six shards:**

| Run                 | Shard jobs | Passed | SIGSEGV | `test:ts`               |
| ------------------- | ---------- | ------ | ------- | ----------------------- |
| 41221113728, 2 runs | 12         | 12     | 0       | 54–88 s                 |
| 41222890620, 3 runs | 90         | 90     | 0       | 49–93 s, median 82–86 s |

Serial `test:ts` took a median of 126 s. Journal 123's crash was on Node 22.19.0 with three shards: one crash in two whole-suite runs, against none in 17 whole-suite runs here. Those shard jobs held twice as many files, so per-job rates are not comparable. These runs covered GitHub runners only, not coding boxes.

- 0 in 102 shard jobs bounds the rate at about 3% per shard job, or about 16% per six-shard run, at 95% confidence.
- The cause of the original crash is still not established, so journal 123's condition is only partly met. The decision is the owner's.

### Release closure — 1 November 2026

Merged as `9fdbca7`. `checks` on main passed in 167 s (run 41225471428), and the automatic release (run 41225693192) succeeded with a healthy gateway. Nothing changes in production.

## Follow-up and next iteration

- **Owner's decision:** four test files at a time. Hypothesis: a wall time near 130 s, set by `Pi worker boundary`. Test jobs took 69–108 s on the first two runs and up to 116 s in the stress runs.
- **Next:** skipping the code jobs on docs-only PRs, and TypeScript 7, deferred; see [journal 140](140-docs-only-checks.md).
- **Local setup:** `tests/fetch-hygiene.test.ts` timed out on Node 22.14 and passes on 22.23.4, the version in `.nvmrc`.
