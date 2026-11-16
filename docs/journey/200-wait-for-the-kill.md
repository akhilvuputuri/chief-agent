# 200 — Why did one command lose its whole result to "Command descendant cleanup failed"?

Work date: 2026-11-16 (UTC). Written: 2026-11-16.
Status: tested; the Linux guard's new behaviour is verified only by CI's "Pi worker boundary" job. The first version was replaced after independent review. Not released: it needs a worker image built from it and pinned. Branch `coding-cleanup-window` (PR 500).

## User-visible problem and preceding iteration

In job `46463771` one coder command, `kite run check 2>&1 | grep -iE "error" | head; git status --short`, returned only "Command descendant cleanup failed; inspect before continuing". Its output was lost and the model had to run the check again. [Journal 199](199-two-commands-at-once.md) changed when the worker's Linux guard sweeps leftover processes (only when no command is running) and which ones (only outside the worker's own session). It kept the sweep's time window, and it recorded this error as not explained.

## Evidence

- **Measured on production (job `46463771`, old image):** one command returned only the cleanup error. Three earlier full check runs in the same box did not fail.
- **Measured on macOS, 4 of 4 runs:** after `head` exits on its tenth line, the shell exits while a test process started by the pipeline is still running in the command's process group. A full check that runs to the end leaves nothing.
- **Measured on Linux, CI run 43798516108, job 133072916065 (the reproduction commit `a81948a`, before the fix):** `SIGKILL to exit, ms (the old and current sweep wait about 100 x 1 ms): {"256 MiB":[18,18,16],"1024 MiB":[66,63,65],"2048 MiB":[127,129,129]}`, about 63 ms per GiB on the GitHub runner. The real guard then threw "Command descendant cleanup failed; inspect before continuing", and the smoke crashed on the unhandled rejection without naming the case.
  - **Inferred from the log's timestamps:** the error came about 2.1 s after the timing print. That fits both 1 GiB cases passing under the old guard and the 2 GiB grouped case throwing first.
  - **Margin:** 2 GiB beats the old window, about 110 ms, by only 15 to 35 ms. That is why the smoke now also has a 6 GiB case.
- **Read in the code (`coding_runtime_pi/native/process.c` at `eac08bf`):** `cleanup` SIGKILLed each foreign-session child, called `waitpid(pid, NULL, WNOHANG)`, slept 1 ms, and repeated for at most 100 passes. Then it threw if any foreign child was still listed.

## Diagnosis and alternatives

- **Mechanism.** A process killed with SIGKILL cannot be reaped until the kernel has freed its memory. At about 63 ms per GiB, a test process of a GiB or more outlives a window of roughly 100 passes of 1 ms plus the work of each pass. The window was ours and arbitrary; death after SIGKILL is certain.
- **What the command did (hypothesis for the production case, consistent with the macOS runs):** `head` exited, the writers upstream died of EPIPE and the shell exited, while a test process kept running in the command's group. `finish` killed the group, and the sweep then had the window to reap it. The size of that production process was not measured.
- **Alternatives rejected.**
  - A longer window, or a deadline: still a guess against a time that grows with memory. It is a symptom fix.
  - A cgroup per command: exact ownership, but the box does not delegate cgroups to the worker (journal 199's follow-up).
  - `waitpid(-1)`: journal 199 removed it, because it takes the exit status of children Node waits for.

## Implementation and review

- **`process.c` `cleanup`, current version.**
  - Each pass reads the worker's child list (and throws if it cannot be opened), SIGKILLs every child outside the worker's session, and reaps with `WNOHANG` whichever have already exited. It sleeps 1 ms and repeats, and it finishes when a pass lists no such child.
  - A killed process's children are re-parented to the subreaper before the killed process can be reaped, so a later pass lists and kills them while earlier ones are still dying.
  - There is no time limit. Waiting for the kernel to finish a kill is unbounded, and the heartbeat path below is the backstop.
  - The only bound counts generations: a pass that lists a pid the previous pass did not list. Passes that only wait for pids already killed do not count. After 100 generations the sweep fails loudly and names what survives. Failing to track the list (an allocation that fails) also fails loudly.
  - Unchanged: which processes are touched (foreign session only, each by its own pid, never `waitpid(-1)`), when the sweep runs (no command running), and both "Cannot list the worker's children" refusals. The safety property also stays: no descendant of a command survives once no command is running, and if that cannot be guaranteed the command fails loudly.
- **First version, replaced after review (commit `604e913`, review of head `c374893`).**
  - Each pass killed the listed children and then blocked in `waitpid(pid, NULL, 0)` on each before reading the list again. A grandchild becomes the worker's child only after its parent dies, so later generations were not killed until those blocking waits returned.
  - The reviewer named two cases where they return late or never. One is a process stuck in uninterruptible I/O: the worker freezes while killable leftovers of later generations keep running. The other is a traced zombie: the kernel shows it only to its tracer, so the parent's blocking wait sleeps until the tracer dies, and the tracer may be one of those later generations.
  - The old 1 ms loop handled both, because it killed the tracer on its next pass. The current loop keeps the old loop's shape and drops its time window.
- **Naming the survivor.** When the generation bound is passed, the error names up to four of them, as `pid (comm) state` from `/proc/<pid>/stat`, plus a count of the rest. `comm` is the text between the first `(` and the last `)`, with unprintable bytes replaced. The command line is never read, because it can carry what the command was given.
- **The executor (`coding_runtime_pi/src/workspace.ts`).** `finish` used to swallow the native error. The model still gets exactly "Command descendant cleanup failed; inspect before continuing", and the guard's message now travels as that error's `cause`.
- **Where an operator can see the cause: no channel exists today (finding, not changed).**
  - The worker's stdout and stderr are discarded: `src/boxes/coding-task.ts` spawns it with `stdio: ["ignore", "ignore", "ignore"]`, and `box-sandbox.ts` says its output is never kept.
  - The host's operational diagnostics exclude free-text errors (`src/coding/diagnostics.ts`).
  - `progress` carries owner-facing summary lines and changes the job's summary.
  - Stock Pi's bash tool rethrows the executor's error, and Pi's agent loop keeps only `error.message` for the tool result (`createErrorToolResult` in `pi-agent-core`). So the cause does not reach the stored session either.
  - So the cause reaches the tests and the security smoke, which print it, but not production. Carrying it further needs a decision on a channel; no new channel was invented here.
- **Gateway message (`src/coding/controller.ts`).** A job whose worker image no sandbox runs was paused with "…start a new coding job to continue". For a Pi job that is wrong: `coding_job_update` with `upgradeWorker` moves a paused job to the image new jobs use, keeping its saved work, and the job can then be resumed (`updateJob` and `RESTARTABLE`).
  - The pause now says so when the move is possible: a Pi job on a Pi host whose current image differs from the job's and is run by the sandbox.
  - Any other job keeps the earlier text. A legacy (non-Pi) job reaches the same line, and `upgradeWorker` refuses it ("Only a Pi coding job can change worker"), so "start a new coding job" stays true for it.
- **What the wait does to the worker.**
  - `cleanup` is a synchronous native call on the worker's main thread. While it waits, no JavaScript runs. The 20 s heartbeat is delayed by the wait. Bytes of in-flight HTTP requests (host requests, the model proxy stream) wait in the kernel and are handled afterwards. Their 130 s abort timers fire late, never early.
  - At the measured rate, a coding box's whole memory (16 GiB on `m7i.xlarge`, from `deploy/boxes/boxes.json`) is about one second. That is an extrapolation from the CI runner, not measured on a box. The heartbeat is lost only after 180 s.
  - **A process that cannot die.** A process stuck in uninterruptible I/O does not act on SIGKILL until it leaves that state, so the wait can last forever. Every other leftover is still killed on each pass while the worker waits, including those adopted later, and the ones that die are reaped. Only the stuck process and the worker's frozen event loop remain. Then the worker sends no heartbeat. The host's existing path (`controller.ts`, the 180 000 ms heartbeat check) pauses the attempt with "Worker heartbeat was lost before verified completion; saved work is retained", with cause `heartbeat_lost`. It marks cleanup pending, which closes the box, and the pause is eligible for the one automatic retry in a new box (`autoRetryOnce`).
  - **No deadline was added.** With a deadline, the guard would throw and leave the process listed. The final check of every later command in that box would list it again, so every command would fail with "inspect before continuing" until the box's lifetime ended. The unbounded wait instead hands the box to the heartbeat path, which replaces it and keeps the saved work.
- **Tests.**
  - `coding_runtime_pi/src/security-smoke.ts` (Linux, CI only) keeps the timing print. It runs eight leftover cases through the real guard:
    - processes of 1, 2 and 6 GiB left in the command's group, and detached daemons of the same sizes in sessions of their own. 6 GiB takes several times the old window to be reaped, on any runner;
    - a chain of 31 daemons, each in a session of its own;
    - a traced process (Python's `ctypes` calling `ptrace`) whose tracer is a later generation (a grandchild of the daemon, adopted only when its parent is killed) and never waits for it.

    A watchdog child in the worker's own session, which the guard never touches, kills the smoke after 600 s, because a frozen native call stops every timer. CI now runs the smoke under `docker run --init`, so the smoke is not PID 1, which ignores SIGKILL from inside its container. Each case prints "Leftover case passed: NAME (ms)" or "Leftover case FAILED: NAME: message (cause: guard message)". The smoke asserts the list of failures is empty only after every case has run.

  - `coding_runtime_pi/tests/executor-concurrency.test.ts` (any platform): a sweep that throws gives the unchanged model message with the guard's error as its cause, and the count of running commands is released.
  - `tests/coding-on-boxes.test.ts`: a Pi job on a retired image is told to move and resume. A legacy job, and a Pi job whose host image the sandbox does not run either, keep "start a new coding job".

## Verification and outcome

- **Locally (macOS):** `clang -Wall -Wextra -fsyntax-only` on `process.c` against Node 22.23.4's headers, with a stub `sys/prctl.h`, is clean. `executor-concurrency.test.ts` passed 6 of 6, and `coding-on-boxes.test.ts` passed 4 of 4. The native code cannot run on macOS.
- **First version (`604e913`, blocking wait) under the first smoke: run 43800175038, job 133078295754.** It passed all five cases of the first smoke:

  ```
  SIGKILL to exit, ms: {"256 MiB":[18,18,16],"1024 MiB":[65,61,66],"2048 MiB":[125,129,129]}
  Leftover case passed: 1024 MiB process left in the command's group (526 ms)
  Leftover case passed: 1024 MiB detached daemon in its own session (577 ms)
  Leftover case passed: 2048 MiB process left in the command's group (1051 ms)
  Leftover case passed: 2048 MiB detached daemon in its own session (1001 ms)
  Leftover case passed: chain of 31 daemons, each in its own session (56 ms)
  ```

- **Old guard (`process.c` from `eac08bf`) under the new smoke: temporary commit `45c4eb2`, run 43802667234, job 133086359474. It failed.** Every case after the first 2 GiB one fails in this run, because once one leftover survives, every later sweep finds it. So only the first failure says something about the old window. ptrace was permitted in the CI container, and the tracer case passes under the old loop, which kills the tracer on its next pass. The log:

  ```
  SIGKILL to exit, ms: {"256 MiB":[19,21,21],"1024 MiB":[73,76,78],"2048 MiB":[153,153,158],"6144 MiB":[458,468,472]}
  Leftover case passed: 1024 MiB process left in the command's group (699 ms)
  Leftover case passed: 1024 MiB detached daemon in its own session (702 ms)
  Leftover case FAILED: 2048 MiB process left in the command's group: Command descendant cleanup failed; inspect before continuing (cause: Command descendants remain)
  Leftover case FAILED: 2048 MiB detached daemon in its own session: Command descendant cleanup failed; inspect before continuing (cause: Command descendants remain)
  Leftover case FAILED: 6144 MiB process left in the command's group: Command descendant cleanup failed; inspect before continuing (cause: Command descendants remain)
  Leftover case FAILED: 6144 MiB detached daemon in its own session: Command descendant cleanup failed; inspect before continuing (cause: Command descendants remain)
  Leftover case FAILED: chain of 31 daemons, each in its own session: Command descendant cleanup failed; inspect before continuing (cause: Command descendants remain)
  Leftover case passed: traced process whose tracer is a later generation and never waits (257 ms)
  Tracer case ptrace attach: attached
  AssertionError [ERR_ASSERTION]: Leftover cases failed
  ```

- **First version (`process.c` from `604e913`) under the new smoke: temporary commit `aa443e5`, run 43803263803, job 133088189316. It froze on the tracer case**, the case after the chain, until the watchdog ended it. This confirms the reviewer's finding. This runner freed memory about twice as fast, about 28 ms per GiB. The log:

  ```
  04:20:19 SIGKILL to exit, ms: {"256 MiB":[9,10,8],"1024 MiB":[31,30,32],"2048 MiB":[61,58,61],"6144 MiB":[170,170,171]}
  04:20:27 Leftover case passed: chain of 31 daemons, each in its own session (55 ms)
  04:29:57 Security smoke froze for 600 s; killing it
  ##[error]Process completed with exit code 137.
  ```

  All six size cases passed before it.

- **Both temporary commits were removed from the branch** (force-pushed with lease). The current version's run on the final head is reported in PR 500.

- **Locally, `kite run check` (macOS):** exit 0. The main suite reported 1825 tests, 1824 passed, 0 failed and 1 skipped; the Pi package reported 54 of 54.
- **Not measured:** a production command whose leftover process is large; the reap time on a coding box rather than a GitHub runner; and whether the production error came from a large process or from something else that outlived the window.

## Coding-harness learning record

Updated in [coding-agent lessons](coding-agent-lessons.md).

## Follow-up and next iteration

- Decide where the guard's survivor message should reach an operator (see the finding above).
- Stock Pi's bash tool drops the command's streamed output when the executor rejects (`dist/core/tools/bash.js` rethrows the error without the text). If the guard ever fails again, the output is lost with it. Whether to keep the output in that case is open.
- After release, check that no coding job shows "Command descendant cleanup failed".

## Update, 16 November 2026: released, image built and pinned

Merged as `4da138b` (PR 500) at the reviewed head `f6e9494`; release run 43806415588 succeeded at 04:51 UTC and the gateway was healthy at `4da138b`. The worker image built from it (run 43805890191, `sha256:90cb1dcc…`) is pinned in `config/coding-pi.json` and `config/boxes.json`. The image pinned earlier the same day (`sha256:bfecdb52…`) stays listed as a previous image so a job moved to it is not paused again.

- **Review notes not yet acted on** (the second review approved with these): assert the traced-process case's attach status instead of only printing it; the bound counts passes that list a new process rather than tree depth, so a wide tree whose parents die at staggered times could reach it (it would fail loudly, not leak); the failure message can name a pid that the same pass already reaped; "several times the old window" for 6 GiB is about 1.6 times on the fastest runner seen (174 to 178 ms against about 110 ms); and the old loop did not handle a process stuck in I/O, it killed the others and failed loudly.
- **Still not measured:** a job on this image, and reap time on a coding box.
