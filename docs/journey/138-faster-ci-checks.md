# 138 — Where does a CI run's time go now that installs are instant?

Work dates: 31 October 2026. Written: 31 October 2026.
Status: released in `9973a81`. The first run on the final weights took 180 s, against 237–287 s on main just before it. Single samples, and shards are still uneven.

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

**Measured, three runs on this change** (41189881282, 41213257878 and 41213831727, the last on the final weights), against runs on main:

| Measure                                   | Main         | First        | Second       | Final weights |
| ----------------------------------------- | ------------ | ------------ | ------------ | ------------- |
| Workflow wall time                        | 237–287 s    | 258 s        | 188 s        | 180 s         |
| Slowest test shard job                    | 220–256 s    | 165 s        | 165 s        | 151 s         |
| Pi job                                    | 199–261 s    | 190 s        | 178 s        | 171 s         |
| Test shard jobs, all six                  | not compared | not compared | not compared | 99–151 s      |
| Gate job's wait after its last dependency | about 3 s    | 62 s         | 3 s          | not measured  |

- **Tests kept:** on the final-weights run, top-level test titles matched main's exactly (b73e58c): 1,422 tests, 1,421 passed, 0 failed, 1 skipped. The earlier runs also matched.
- **The first run's 258 s was mostly a 62 s gate wait,** an outlier against about 3 s elsewhere. Its cause is not established.
- **The Pi job now sets the wall time.**
- **Balance is limited by runner speed (hypothesis).** Recorded time splits at 118–119 s per shard, but the jobs took 99–151 s. On the first run, per-file times within a shard ran a nearly uniform 0.6× or 1.0× of main's, which points to runner speed rather than a bad split.
- **Weights.** Only the third run used the final weights, from the complete log of run 41187266188: 140 of 140 files, 711 s. The first two also missed files, apparently because the source log was cut off (inferred from where the entries stop), and the first also missed templated titles (57–69 s on the runs checked).
- **The updater's check.** It now requires a summary line from every shard, which a cut-off log lacks. An earlier 95% file-count check would not have caught the actual cut, which still credited 138 of 140 files.
- **pip:** the first run had no cache to restore; later runs restored it.

### Release closure — 31 October 2026

Merged as `9973a81` ([PR 379](https://github.com/akhilvuputuri/chief-agent/pull/379)). CI configuration only; nothing changes in production.

## Follow-up and next iteration

- Refresh the weights only if shards drift clearly apart: one run's times carry that run's runner speeds.
- The Pi job is the next limit on wall time.
