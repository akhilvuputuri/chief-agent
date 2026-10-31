# 138 — Where does a CI run's time go now that installs are instant?

Work dates: 31 October 2026. Written: 31 October 2026.
Status: in review. The latest CI run took 188 s against 237–270 s on main. That is one sample, and shards are still uneven.

## User-visible problem and preceding iteration

[Journal 128](128-kite-replaces-npm.md) cut each job's install step to 0–1 s, but a `checks` run still took about 265 s.

## Evidence

**Measured, one `checks` run on main:**

- Wall time was 265 s, set by the slowest test shard at 256 s.
- `kite run test:ts` took 83, 89, 115, 130, 154 and 182 s across the six shards, 753 s in total, so a balanced shard would take about 126 s.
- `kite run build` (`tsc`) took 12–20 s in each of eight jobs.
- Installing ripgrep with `apt` took 7–27 s per job, and `pip` took 5–11 s.
- The Pi job took 199 s, of which 137 s was one verification step. That step ran the Pi test suite a second and third time, at about 30 s each.

## Diagnosis and alternatives

- **Shards.** Node's `--test-shard` splits by file count, not by time.
- **A baked CI image** would only replace the `apt` and `pip` steps, and adds an image to maintain. A pinned ripgrep binary and a pip cache get nearly the same gain.
- **Pi's three test runs differ, but one is redundant.** `check:pi` tests Pi against the root lockfile, which is what `Dockerfile.coding-pi` uses. The independent copy tests Pi's own lockfile with no parent `node_modules`. The middle run tests Pi's own lockfile inside the repository, which the independent copy covers more strictly.

## Implementation and review

- **`scripts/test-shard.mjs`** balances shards using each file's recorded time in `tests/test-weights.json`. An unrecorded file counts as the median, so stale weights can skew the balance but never skip a test.
- **`scripts/update-test-weights.mjs`** refreshes the weights from a run's log: `gh run view <id> --log | node scripts/update-test-weights.mjs`. The log has no per-file lines, so each test's time is credited to the file declaring its title.
- **Test shards build with `build:image`** (esbuild). `format and types` still type-checks, and the `other` and Pi jobs still run `tsc`.
- **`.github/actions/setup-ripgrep`** installs a pinned, checksum-verified ripgrep 14.1.1. `apt` had installed whichever version Ubuntu carried.
- **`setup-python` caches pip.**
- **The Pi step** no longer runs the redundant middle test run.

## Verification and outcome

**Measured, the first two runs on this change** (41189881282 and 41213257878), against three baseline runs on main:

| Measure                                   | Main            | First run | Second run |
| ----------------------------------------- | --------------- | --------- | ---------- |
| Workflow wall time                        | 265, 237, 270 s | 258 s     | 188 s      |
| Slowest test shard job                    | 256, 228, 231 s | 165 s     | 165 s      |
| Pi job                                    | 199, 219, 261 s | 190 s     | 178 s      |
| `test:ts` across shards                   | 83–182 s        | 70–145 s  | 81–149 s   |
| Gate job's wait after its last dependency | not measured    | 62 s      | 3 s        |

- **Tests kept:** each run matched main's top-level test titles, with 1 skipped: 1,415 tests on the first run and 1,422 on the second, after main gained tests.
- **Most of the drop between the two runs is the gate wait disappearing.** Its cause is not established, so 188 s may not hold on every run.
- **The Pi job is now the slowest,** at 178–190 s, and sets the wall time.
- **Balance is limited by runner speed (hypothesis).** Shards were planned to be even but took 81–149 s on the second run. On the first run, per-file times within a shard ran a nearly uniform 0.6× or 1.0× of main's, which points to runner speed rather than a bad split.
- **Weights.** Neither run used the final weights. The first missed templated titles, 57–69 s on the runs checked. The second came from a cut-off log, which dropped two files and under-weighted a third. The final weights come from the complete log of run 41187266188: 140 of 140 files, 711 s, 118–119 s per shard. The updater now refuses a log covering under 95% of test files.
- **pip:** the first run had no cache to restore; the second restored it.

### Release closure — pending

## Follow-up and next iteration

- Refresh the weights only if shards drift clearly apart: one run's times carry that run's runner speeds.
- The Pi job is the next limit on wall time.
