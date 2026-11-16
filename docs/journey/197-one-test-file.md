# 197 — Why did a small coding job spend 40 minutes on tests?

Work date: 16 November 2026. Written: 16 November 2026.
Status: tested locally; not yet released. No coding job has run with it.

## User-visible problem and preceding iteration

The first real job on the rebuilt coding loop ([journal 193](193-rebase-backstop-limits.md)) made a two-file change: one line of source and its tests. Its coder took 40 minutes. Chief told the owner that most of that was waiting on test runs, at roughly 7.5 minutes for a full suite, and the owner asked why it was so slow.

[Journal 159](159-shared-process-test-runs.md) made a serial test run share one process and left coding boxes unmeasured. [Journal 177](177-toolchain-speed-and-scope.md) lists them as not measured.

## Evidence

**Measured, 16 November, job `46463771` (coder on Sonnet 5.5, reviewer on Opus 5.5), from `scripts/coding-job-profile.sql` ([journal 194](194-coding-job-profile.md)) and one read-only query over the job's stored calls.** The time between one model call and the next is the time its command took, plus a few seconds of model time.

| Call                 | Command, in order                                       | Seconds |
| -------------------- | ------------------------------------------------------- | ------- |
| Coder, first round   | `kite run check`, then `kite run test`                  | 675     |
| Coder                | `kite run test`                                         | 309     |
| Coder, second round  | `kite run check`, then `kite run test`                  | 794     |
| Coder, before "done" | `kite run check`                                        | 603     |
| Reviewer             | `kite test tests/links.test.ts`, to run that file alone | 314     |

- **The coder's run took 40.1 minutes over 13 model calls.** The four calls above took 2,381 s, which is 39.7 minutes. Every other call took 2 to 11 s.
- **The TypeScript suite ran six times in the coder's run (inferred).** This is worked out from which commands each call ran and how long the call took; no record counts suite runs. `kite run check` runs `kite test`, so `kite run check` followed by `kite run test` runs every test twice. The coder did that in two of its rounds, and a failing test stops each chain only after the TypeScript tests have run.
- **The reviewer's command ran the whole suite.** Node reported 1,806 tests in 310.7 s. The run then failed, because the file name reached the last command of the `test` script instead of the test runner.
- **One file alone took 8.3 s in the box.** In the coder's first round a test in `tests/links.test.ts` failed, and the shared run sent that file through a process of its own: 36 tests in 8.3 s, by node's report.
- **The serial TypeScript suite takes 310.7 s in a box**, against 170.7–175.6 s on an Apple laptop (journal 159). This is the first measurement in a box. The box gives the task three CPUs (`taskCpus` in `config/boxes.json`), and a serial run uses one.
- **Not explained:** the coder's last command ended with the worker's error "Command descendant cleanup failed" after 603 s. That call's time may include a wait that is not test time.

## Diagnosis and alternatives

Two things of ours made the job run the suite seven times.

- **There was no way to run one test file.** `scripts/test-shard.mjs` took no file names and always ran every file. `kite test NAME` looked as if it would, and did not: `test` was a chain of three commands, and Kite, like npm, adds the name to the end of the chain.
- **The instructions did not say what `kite run check` covers.** `AGENTS.md` listed it without saying it runs every test. The worker's prompt says to run the tests, "including the full suite", before reporting done. The coder ran both.

A third cause is left for the next change: a full run in a box uses one of its three CPUs.

- **Named test files (chosen):** `kite test tests/links.test.ts` builds and runs those files alone. This is the command the reviewer guessed.
- **Say what the check covers (chosen):** `AGENTS.md`, which Pi loads whole for coder and reviewer, now says that `kite run check` includes every test, and to run named files while working and the whole check once.
- **A limit on test runs or on a command's time (rejected):** it would hide the cost and stop a job that needs the run.
- **Tell agents to call `tsx --test` on a file (rejected):** it works, but skips the build, and the natural guess would still run everything.
- **Several shared processes at once in a box (next):** it needs a measurement on a machine like a box first. Coding boxes are serial because of the crash in [journal 123](123-faster-checks.md), which [journal 141](141-parallel-test-files.md) left untested in boxes.

## Implementation and review

- **`scripts/test-shard.mjs`:** file names on the command line select the files to run. A name that is not one of the files a full run would run is refused with exit status 2, so a mistyped name cannot pass by running nothing. `TEST_SHARD` with names is refused. One exported step, `selectFiles`, decides what a run covers, and is tested for names, a shard and every file.
- **`scripts/test.mjs` (new):** `kite test` now runs this. Without names it runs the same three steps as before: the build, the TypeScript tests and the other suites. With names it checks them, then runs the build and those files. A step ended by a signal ends the run with the same signal.
- **`AGENTS.md`:** two lines under Checks, as above. They also say that `kite run format:check` is separate and still needed.
- **Not changed:** the worker's prompt (`coding_runtime_pi/src/runtime.ts`), which tells the coder to run the tests, "including the full suite", before reporting done. A change to it reaches jobs only through a new worker image. CI is unchanged: it calls `kite run test:ts` with a shard.

**Review (Claude Opus 5.5), `06b038a`: changes requested.** The reviewer tried the scripts with odd names, shards and a missing `kite`, and found the old steps, order and exit statuses kept. Two things were wrong:

- `AGENTS.md` called `kite run check` "the whole check". It does not run `format:check`, so an agent told to run fewer commands could skip it. The line now lists what the check covers and says the format check is separate.
- The index row compared a laptop's 5 s with a box's 310 s. It now gives the box's own 8 s.

Also from that review: the script test no longer depends on the caller's `TEST_SHARD`; a test now shows that names limit the run; a name is checked before the build; a signal is passed on; and this entry says which figures are inferred.

## Verification and outcome

**Tested, 16 November, an Apple M4 laptop on Node 22.23.4, this change:**

- `kite test tests/links.test.ts` built and ran that file alone: 34 tests passed, in 5.2 s and 4.6 s of wall time in two runs on a quiet machine, build included. The reviewer's run took 19.0 s while another full test run was using the same laptop.
- `kite test tests/nope.test.ts` was refused with exit status 2, and so was a name given together with `TEST_SHARD`.
- `kite run check` passed in 315.7 s: 1,804 TypeScript tests (1,803 passed, 1 skipped) in 218.5 s by node's report, 80 script tests, the Python suites and the Pi package's 43 tests. This is one run, and it is not comparable with journal 159's timings, which are of `kite run test:ts` alone on an earlier suite.
- The script's own tests cover a named file, a mistyped name, a name with a shard and the steps `kite test` runs.

**Not tested:** a coding job. Whether a coder and a reviewer now run named files and one full check will show in the next job's profile.

## Follow-up and next iteration

- Read the next coding job's profile: how many times the suite ran, and how long the tests-or-build calls took.
- Measure several shared processes at once on a machine like a box, and use them there if they hold up.
- The "descendant cleanup failed" error at the end of a 603 s command is unexplained and belongs to the worker.
