# 139 — What still limits a CI run, and is it safe to run test files in parallel again?

Work dates: 1 November 2026. Written: 1 November 2026.
Status: Pi job split on [PR 386](https://github.com/akhilvuputuri/chief-agent/pull/386). Test files stay serial until the owner decides; see the stress run below.

## User-visible problem and preceding iteration

[Journal 138](138-faster-ci-checks.md) brought `checks` to 180–183 s and named the Pi job as the next limit. An article on speeding up CI suggested faster runners, skipping per-file app reloads and other changes, so we measured which of them apply here.

## Evidence

**Measured, the last 30 successful runs of each event type:**

| Measure                  | Pull requests        | Main                 |
| ------------------------ | -------------------- | -------------------- |
| Wait for a runner, a job | median 4 s, p90 61 s | median 4 s, p90 21 s |
| `actions/checkout`       | median 2 s           | median 1 s           |
| `setup-kite`             | median 2 s, p90 5 s  | median 3 s, p90 6 s  |

**Measured, two runs after journal 138's final weights:** `kite run test:ts` used 59.9% of all runner seconds. The Pi job took 152–172 s, of which one Docker and independence step took a median of 98 s.

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

**Measured, split job, first run (41224227641):** wall time 164 s, against 193–195 s on the same day's earlier PR runs. `Pi worker boundary` took 119 s and `Pi package` 91 s, against 152–184 s for the old job. Both ran the expected tests: one in `box-docker`, and 109 in each Pi test run.

**Flaky test found by that run, cause proven.** `tests 3/6` failed on an assertion that the sealed token box does not contain `r1`. The test box is 59 bytes of ciphertext, so two chosen bytes appear by chance about 1 run in 1,100 (58 positions in 65,536). It now looks for `"r1"` and `"a1"` with their quotes, as they appear in the sealed JSON, which still catches an unsealed box.

**Measured, parallel test files, on Node 22.23.4 and six shards:**

| Run                 | Shard jobs | Passed | SIGSEGV | `test:ts`               |
| ------------------- | ---------- | ------ | ------- | ----------------------- |
| 41221113728, 2 runs | 12         | 12     | 0       | 54–88 s                 |
| 41222890620, 3 runs | 90         | 90     | 0       | 49–93 s, median 82–86 s |

Serial `test:ts` took a median of 126 s. Journal 123's crash was on Node 22.19.0 with three shards: one crash in two runs, or one in six shard jobs.

- 0 in 102 shard jobs bounds the rate at about 3% per shard job, or about 16% per six-shard run, at 95% confidence.
- The cause of the original crash is still not established, so journal 123's condition is only partly met. The decision is the owner's.

## Follow-up and next iteration

- **Owner's decision:** four test files at a time. Hypothesis: test jobs of 69–108 s and a wall time near 130 s.
- **Next:** TypeScript 7 for type checks, and skipping the heavy jobs on docs-only PRs (15 of the last 60 merged PRs).
- **Local setup:** `tests/fetch-hygiene.test.ts` timed out on Node 22.14 and passes on 22.23.4, the version in `.nvmrc`.
