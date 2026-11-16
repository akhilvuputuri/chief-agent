# 200 — Why did one command lose its whole result to "Command descendant cleanup failed"?

Work date: 2026-11-16 (UTC). Written: 2026-11-16.
Status: tested; the Linux guard's new behaviour is verified only by CI's "Pi worker boundary" job. Not released: it needs a worker image built from it and pinned. Branch `coding-cleanup-window` (PR 500).

## User-visible problem and preceding iteration

In job `46463771` one coder command, `kite run check 2>&1 | grep -iE "error" | head; git status --short`, returned only "Command descendant cleanup failed; inspect before continuing". Its output was lost and the model had to run the check again. [Journal 199](199-two-commands-at-once.md) changed when the worker's Linux guard sweeps leftover processes (only when no command is running) and which ones (only outside the worker's own session). It kept the sweep's time window, and it recorded this error as not explained.

## Evidence

- **Measured on production (job `46463771`, old image):** one command returned only the cleanup error. Three earlier full check runs in the same box did not fail.
- **Measured on macOS, 4 of 4 runs:** after `head` exits on its tenth line, the shell exits while a test process started by the pipeline is still running in the command's process group. A full check that runs to the end leaves nothing.
- **Measured on Linux, CI run 43798516108, job 133072916065 (the reproduction commit `a81948a`, before the fix):** `SIGKILL to exit, ms: {"256 MiB":[18,18,16],"1024 MiB":[66,63,65],"2048 MiB":[127,129,129]}`, about 63 ms per GiB on the GitHub runner. The real guard then threw "Command descendant cleanup failed; inspect before continuing" in the first leftover cases. The smoke crashed on the unhandled rejection, so which case failed first is not recorded.
- **Read in the code (`coding_runtime_pi/native/process.c` at `eac08bf`):** `cleanup` SIGKILLed each foreign-session child, called `waitpid(pid, NULL, WNOHANG)`, slept 1 ms, and repeated for at most 100 passes. Then it threw if any foreign child was still listed.

## Diagnosis and alternatives

- **Mechanism.** A process killed with SIGKILL cannot be reaped until the kernel has freed its memory. At about 63 ms per GiB, a test process of a GiB or more outlives a window of roughly 100 passes of 1 ms plus the work of each pass. The window was ours and arbitrary; death after SIGKILL is certain.
- **What the command did (hypothesis for the production case, consistent with the macOS runs):** `head` exited, the writers upstream died of EPIPE and the shell exited, while a test process kept running in the command's group. `finish` killed the group, and the sweep then had the window to reap it. The size of that production process was not measured.
- **Alternatives rejected.**
  - A longer window, or a deadline: still a guess against a time that grows with memory. It is a symptom fix.
  - A cgroup per command: exact ownership, but the box does not delegate cgroups to the worker (journal 199's follow-up).
  - `waitpid(-1)`: journal 199 removed it, because it takes the exit status of children Node waits for.

## Implementation and review

- **`process.c` `cleanup`.** Each pass reads the worker's child list, SIGKILLs every child outside the worker's session, and then waits for each to be reaped: a blocking `waitpid(pid, NULL, 0)` on its own pid, retried on `EINTR`. `ECHILD` means nothing of it is left to reap. The pass then reads the list again. All are killed before any is waited for, so the kernel frees their memory at the same time. A dying process's children are re-parented to the subreaper before the dying process can be reaped, so the next read lists them. A pass is a generation of descendants, not a millisecond, and the 1 ms sleep is gone.
  - The 100-pass bound stays only as a loud failure for a process tree that forks new generations faster than they are killed. A real command's descendants are not 100 generations deep.
  - Unchanged: which processes are touched (foreign session only, each by its own pid, never `waitpid(-1)`), when the sweep runs (no command running), and both "Cannot list the worker's children" refusals. The safety property also stays: no descendant of a command survives once no command is running, and if that cannot be guaranteed the command fails loudly.
- **Naming the survivor.** When the final check still finds a foreign child, the error names up to four of them, as `pid (comm) state` from `/proc/<pid>/stat`, plus a count of the rest. `comm` is the text between the first `(` and the last `)`, with unprintable bytes replaced. The command line is never read, because it can carry what the command was given.
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
- **What the blocking wait does to the worker.**
  - `cleanup` is a synchronous native call on the worker's main thread. While it waits, no JavaScript runs. The 20 s heartbeat is delayed by the wait. Bytes of in-flight HTTP requests (host requests, the model proxy stream) wait in the kernel and are handled afterwards. Their 130 s abort timers fire late, never early.
  - At the measured rate, a coding box's whole memory (16 GiB on `m7i.xlarge`, from `deploy/boxes/boxes.json`) is about one second. That is an extrapolation from the CI runner, not measured on a box. The heartbeat is lost only after 180 s.
  - **A process that cannot die.** A process stuck in uninterruptible I/O does not act on SIGKILL until it leaves that state, so the wait can last forever. Then the worker sends no heartbeat. The host's existing path (`controller.ts`, the 180 000 ms heartbeat check) pauses the attempt with "Worker heartbeat was lost before verified completion; saved work is retained", with cause `heartbeat_lost`. It marks cleanup pending, which closes the box, and the pause is eligible for the one automatic retry in a new box (`autoRetryOnce`).
  - **No deadline was added.** With a deadline, the guard would throw and leave the process listed. The final check of every later command in that box would list it again, so every command would fail with "inspect before continuing" until the box's lifetime ended. The unbounded wait instead hands the box to the heartbeat path, which replaces it and keeps the saved work.
- **Tests.**
  - `coding_runtime_pi/src/security-smoke.ts` (Linux, CI only) keeps the timing print. It runs five leftover cases through the real guard: a 1 GiB and a 2 GiB process left in the command's group, a 1 GiB and a 2 GiB detached daemon in a session of its own, and a chain of 31 daemons, each in a session of its own. Each case prints "Leftover case passed: NAME (ms)" or "Leftover case FAILED: NAME: message (cause: guard message)". The smoke asserts the list of failures is empty only after every case has run.
  - `coding_runtime_pi/tests/executor-concurrency.test.ts` (any platform): a sweep that throws gives the unchanged model message with the guard's error as its cause, and the count of running commands is released.
  - `tests/coding-on-boxes.test.ts`: a Pi job on a retired image is told to move and resume. A legacy job, and a Pi job whose host image the sandbox does not run either, keep "start a new coding job".

## Verification and outcome

- **Locally (macOS):** `clang -Wall -Wextra -fsyntax-only` on `process.c` against Node 22.23.4's headers, with a stub `sys/prctl.h`, is clean. `executor-concurrency.test.ts` passed 6 of 6, and `coding-on-boxes.test.ts` passed 4 of 4. The native code cannot run on macOS.
- **CI's "Pi worker boundary" job, run 43800175038, job 133078295754, on `604e913` (the fix):** passed. The log shows the same reap times as before the fix, and all five leftover cases pass through the real guard. The times per case include starting the process and filling its memory.

  ```
  SIGKILL to exit, ms: {"256 MiB":[18,18,16],"1024 MiB":[65,61,66],"2048 MiB":[125,129,129]}
  Leftover case passed: 1024 MiB process left in the command's group (526 ms)
  Leftover case passed: 1024 MiB detached daemon in its own session (577 ms)
  Leftover case passed: 2048 MiB process left in the command's group (1051 ms)
  Leftover case passed: 2048 MiB detached daemon in its own session (1001 ms)
  Leftover case passed: chain of 31 daemons, each in its own session (56 ms)
  ```

  The same cases made the guard throw in run 43798516108 on the reproduction commit.

- **Locally, `kite run check` (macOS):** exit 0. The main suite reported 1825 tests, 1824 passed, 0 failed and 1 skipped; the Pi package reported 54 of 54.
- **Not measured:** a production command whose leftover process is large; the reap time on a coding box rather than a GitHub runner; and whether the production error came from a large process or from something else that outlived the window.

## Coding-harness learning record

Updated in [coding-agent lessons](coding-agent-lessons.md).

## Follow-up and next iteration

- Decide where the guard's survivor message should reach an operator (see the finding above).
- Stock Pi's bash tool drops the command's streamed output when the executor rejects (`dist/core/tools/bash.js` rethrows the error without the text). If the guard ever fails again, the output is lost with it. Whether to keep the output in that case is open.
- After release, check that no coding job shows "Command descendant cleanup failed".
