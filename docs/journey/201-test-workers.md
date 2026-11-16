# 201 — Can a full test run in a coding box use all its CPUs?

Work date: 16 November 2026. Written: 16 November 2026.
Status: tested locally and timed on a CI machine held to three CPUs; not yet released. No coding box has run it.

## User-visible problem and preceding iteration

[Journal 197](197-one-test-file.md) stopped a coding job from running the whole suite seven times. One full run still belongs to every job, and in a box the TypeScript tests alone take 310.7 s of it, on one of the box's three CPUs. Coding boxes were kept serial by [journal 141](141-parallel-test-files.md), which left parallel runs there unmeasured.

## Evidence

**Measured, 16 November, GitHub's `ubuntu-latest` runner (AMD EPYC 9V74, 4 CPUs, 16 GB), every run held to three CPUs with `taskset -c 0-2` to match a box's `taskCpus`.** Five throwaway workflow runs on branches that were never merged; each line is one run of `kite run test:ts` unless it says otherwise. Serial time differed between runners from 295 s to 513 s, so only figures from the same workflow run are compared.

### A first try: one shared process per CPU, files split by the recorded weights

| Workflow run | Serial | 2 groups     | 3 groups     | 4 groups |
| ------------ | ------ | ------------ | ------------ | -------- |
| 43791552589  | 403 s  | 263 s        | 309 s, 263 s | 293 s    |
| 43794700747  | 295 s  | 227 s, 250 s | 260 s        | -        |

- In the second run the three groups took 101, 107 and 260 s, and total CPU time was the same as serial (388 s against 401 s). The work was not slower; one group had most of it.
- **The recorded weights were stale.** `tests/test-weights.json` gave the three groups 348, 354 and 355 s. Each file's own time in a shared process, measured on a laptop the same day, put 44, 104 and 46 s in them. `tests/coding-one-session.test.ts` is recorded at 12 s and took 44.5 s; it grew when the coding loop was rebuilt on 13 and 14 November.

### Where the time is

- **Temporary files on disk or in memory make no difference.** Serial runs with `TMPDIR` on disk took 307.7 s and 299.4 s, and in memory 310.5 s and 297.9 s (run 43803152950).
- **A few files hold most of the time.** In that run the 14 slowest of 157 files held about 180 s of 303 s, and `tests/coding-one-session.test.ts` alone 49.3 s.
- **One shared process uses more than one CPU.** A serial run used 524 s of CPU in 390 s (run 43807796942), about 1.3 CPUs. On three CPUs that leaves room for a little over twice the speed, not three times.

### One test file kept its process alive for three minutes

- **Measured, an Apple M4 laptop:** `tests/coding-one-session.test.ts` run alone finished its 32 tests at 41 s, and the process ended at 197 s, 204 s and 209 s in three runs. A probe in the test process showed one pending timer and no other work.
- Run one test at a time, three of the 32 left the process alive: the owner message steered into a coder run, and the two about asks.
- **Cause, shown by two changes:** the tests' worker client is made with an abort signal that nothing ever aborts, and with the worker's default three-minute allowance for a host outage. With that allowance set to 3 s, the two tests tried exited in 3.0 s and 5.0 s. With the signal aborted when each test ends, the whole file exits at 41.2 s. So a request is still being made when the test's server closes, and the client keeps retrying it.
- **Not identified:** which request is still in flight in those three tests, and whether the same is left behind at the end of a real job. With a hook on timers loaded, the file exited at 41 s, so the tool that would have named the request changed the timing.
- **What it cost a parallel run:** the group holding that file could not end before the three minutes were up. That is the 250–260 s group above.
- No other test file's process outlived its tests by more than 14 s, with six files running at a time on a loaded laptop.

### With that fixed: workers taking groups from a queue

**Measured, run 43807796942, the same machine throughout:**

| Run                                     | Elapsed      | CPU (user + system) |
| --------------------------------------- | ------------ | ------------------- |
| Serial                                  | 390 s, 428 s | 524 s, 559 s        |
| 3 workers, 6 groups (27 files a group)  | 197 s        | 542 s               |
| 3 workers, 10 groups (16 files a group) | 217 s        | 562 s               |
| 3 workers, 20 groups (8 files a group)  | 253 s, 251 s | 651 s, 646 s        |
| 3 workers, 40 groups (4 files a group)  | 304 s        | 811 s               |
| 2 workers, 20 groups                    | 278 s        | 624 s               |

- Six groups ran in about half the serial time, and used the CPU time a serial run does.
- **Starting a process costs about 7 s of CPU.** Forty groups used 287 s more CPU than serial and twenty used 127 s more. So fewer, larger groups are faster.
- **Before the lingering file was found,** the same queue took 251 to 456 s against a 513 s serial run (run 43798997613).
- All runs passed. In run 43791552589 the three- and four-group runs each ran five more tests than serial, which is one small file sent through a process of its own after failing in its group. Which file was not recorded.

## Diagnosis and alternatives

- **Workers taking groups from a queue (chosen):** the files are dealt round into two groups a worker, and each worker takes the next group when it finishes one. No recorded timing decides the split, so a file that grows cannot starve the others as it did above.
- **Split by recorded weights (rejected):** it was the first try, and the weights were wrong within five days of being recorded.
- **Many small groups (rejected):** better balanced, but each process costs about 7 s of CPU.
- **A process per file, several at a time, as CI runs (not measured on three CPUs):** it pays that start-up cost for each of 157 files.
- **Temporary files in memory (ruled out by the measurement above).**
- **A larger box (not explored):** more CPUs cost money, and that is the owner's decision.

## Implementation and review

- **`scripts/test-shard.mjs`:** a serial run of 24 or more files now uses several shared processes at once. `TEST_WORKERS` sets how many; the default is one per CPU, up to four, and `TEST_WORKERS=1` is the single shared process as before. Each group is a shared run with its own reruns, as in [journal 159](159-shared-process-test-runs.md). A group's report is printed whole when the group ends, and the last line says whether every group passed.
- **`tests/coding-one-session.test.ts`:** the worker client is aborted when each test ends.
- **Not changed:** CI, which runs a process per file in four shards. A named run of a few files stays in one process.

## Verification and outcome

**Tested, 16 November, an Apple M4 laptop on Node 22.23.4, this change, one run each:**

- `kite run check` passed in 183.6 s with the default of four workers: eight groups of test files, all passed, then the script tests, the Python suites and the Pi package. The same check took 315.7 s on the single shared process in journal 197, on an earlier commit and a differently loaded machine.
- `TEST_WORKERS=1 kite run test:ts` passed in 184.4 s (1,823 tests, 1 skipped): the single shared process still works, and alone takes as long as the whole check now does.
- `tests/coding-one-session.test.ts` run alone exits at 41.2 s, against 197 to 209 s before.
- The script's own tests cover the dealing of files, the worker count, and the queue: every group runs, no more than the workers at once, a slow group does not hold the others, each report is written whole, and one failed group fails the run.

**Not tested:** a coding box. Its CPUs are a limit set through Docker, not a list of CPUs as on the runner, and whether Node counts three CPUs there was not checked; with four it would start four workers on three CPUs.

## Follow-up and next iteration

- Read the next coding job's profile for the time of its full check.
- The request left in flight in the three tests is worth finding in the worker: it belongs to the coding loop.
- CI's shards are balanced by the same stale weights; its four test jobs took 91 to 137 s in one run today (run 43792064669). `scripts/update-test-weights.mjs` refreshes them.
