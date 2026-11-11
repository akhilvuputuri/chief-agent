# 159 — What does a test file's own process cost, and can a serial run do without it?

Work dates: 10–11 November 2026. Written: 11 November 2026.
Status: tested locally. CI is unchanged by design; coding boxes are not yet measured.

## User-visible problem and preceding iteration

[Journal 158](158-reused-test-databases.md) made a test's database cheap. What it left was the cost each test file pays once: its own process compiles the database engine, builds the snapshot and loads the application again. The owner asked for a custom test runner in Kite to remove it, with Kite transpiling TypeScript itself.

## Evidence

**Measured, 11 November, a quiet Mac on Node 22.23.4, all 154 test files with database reuse on.** CPU time is the test processes' user and system time.

| Run                                        |      Wall |       CPU |
| ------------------------------------------ | --------: | --------: |
| One process per file, serial               |   275.7 s |     425 s |
| One shared process                         | 176–190 s | 200–213 s |
| One process per file, four at a time       |   113.8 s |     691 s |
| Four shared processes, files dealt in turn |    70.3 s |     247 s |

- **Same tests:** both ways report the same 1,603 distinct top-level tests. One test imports another test file, so five tests run twice with a process per file and once when shared.
- **Order:** the shared run passed with files sorted, reversed and shuffled, apart from the timing flake recorded in journal 158.
- **Memory:** the shared process peaked at 1.87 GB. The largest single file's process peaked at 2.01 GB.
- **TypeScript loading (31-file sample, a process per file):** files transpiled ahead of time and served by in-thread hooks used 111–114 s of CPU against 128–151 s under tsx. In one shared process tsx used 50 s and the ahead-of-time variant 61 s, so there the loader is not a cost. Node's built-in type transform was slower than tsx (124.9 s against 75.4 s wall, on a loaded machine).

## Diagnosis and alternatives

The saving comes from paying the per-process costs once, not from how TypeScript is loaded.

- **A transpiler in Kite (not built):** it would save 13–25% of CPU with a process per file and nothing measurable in a shared process.
- **A shared process for serial runs (chosen):** Node's own runner does it with `--experimental-test-isolation=none`.
- **Shared processes in CI (not adopted):** CI's wall time is set by the image job, not the test shards, and CI is more useful as the strict reference.

Files in one process can see each other's module state, a crash takes every file with it, and a stray `process.exit` would end the run early with a passing code. A shared run therefore decides only what it can vouch for.

## Implementation and review

`scripts/test-shard.mjs`:

- **Mode:** a serial run shares one process (`TEST_ISOLATION=shared`). Parallel files, as in CI, keep one process each (`TEST_ISOLATION=process`). Either can be set by hand; shared with parallel files is refused.
- **Report:** a second reporter, `scripts/test-ran-files.mjs`, writes each file as it reports a test and again when one fails.
- **Undecided files:** any file with a failed test, and any file that never reported, runs again in a process of its own. That run decides the result. If such a file passes alone, the run passes and says the file depends on, or disturbs, another file's state.

A file that only passes because of what another file left behind still passes in a shared run. CI, with a process per file, is what catches that.

## Verification and outcome

**Tested, same Mac, through `kite run test:ts`:** 175.6 s shared against 285.6 s with a process per file. Every file was decided in the shared run except the flaky one, which ran again alone as designed. After that test was fixed, two more shared runs took 173.9 s and 170.7 s, passed, and re-ran nothing.

**Tested, a four-file synthetic suite:** a file that fails only beside another passes after running alone; a real failure still fails; a file that exits the process early cannot hide the files after it.

**Not measured:** coding boxes, where `kite run check` runs this serially. Their gain is expected to be similar and is unproven.

## Coding-harness learning record

See [coding-agent lessons](coding-agent-lessons.md#serial-test-runs-share-a-process--11-november-2026).

## Follow-up and next iteration

- Read a coding job's check duration before and after.
- Re-record the shard weights, stale since journal 158.
- Remove the experimental flag's prefix once Chief runs on a Node line where it is stable.
