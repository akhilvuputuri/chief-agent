# 199 — Why did two commands in one message stall the reviewer for three hours?

Work date: 2026-11-16 (UTC). Written: 2026-11-16.
Status: tested locally on a model of the old guard and on macOS without the guard; the Linux guard's new behaviour is verified only by CI's "Pi worker boundary" job. Not released. Branch `coding-parallel-commands-hang`.

## User-visible problem and preceding iteration

The first real coding job on the rebuilt loop, a one-function change, took 6 h 15 min and five boxes. [Journal 182](182-pi-tools-and-prompt-as-shipped.md) removed the forced sequential tool execution, so Pi runs every tool call of one assistant message at once, and it moved checkpoints to batch boundaries so that the workspace snapshot never overlaps a tool. It did not look at the Linux process guard, which still assumed that only one command ever runs.

The same job's coder also opened by asking the owner "Approve this plan?" with buttons, after the owner had already tapped Start.

## Evidence

- **Measured on production, 15 November 2026 (job `46463771`, the orchestrator's read-only investigation):**
  - The coder finished in 40 minutes. The reviewer made ten calls in six minutes, then its run made no progress for the rest of the box's three-hour lifetime. The job continued in a new box; the reviewer made a few calls and the same happened for a second three hours. In the third box it approved in one call.
  - Both stalls began immediately after an assistant turn that requested two `bash` tool calls in the same message; every other turn in the job requested one.
  - The second stalled turn's two commands were a `grep` and a `sed -n` on one file. The first stalled turn's commands carried model-set timeouts of 600 s and 60 s and still never returned.
  - About 5.3 hours of box time were lost, and 27 cache-warming calls were made while nothing ran.
  - The coder's first act was a `report` of kind `ask` asking the owner to approve a plan.
- **Read in the code (`origin/main` at `d64685db`):**
  - `coding_runtime_pi/src/workspace.ts` `localExecutor`: each command is spawned `detached` (its own session and process group). When its `exit` arrives, `finish` kills its process group and calls `cleanup()`.
  - On the Linux worker `cleanup` is the native function in `coding_runtime_pi/native/process.c`, passed in by `src/coding/pi-worker.ts` (the worker is a child subreaper). Its comment says "All commands are serialized": it reads `/proc/<worker>/task/<worker>/children`, sends SIGKILL to every child of the worker, and reaps with `waitpid(-1, …, WNOHANG)` until no child remains.
  - `pi-agent-core` runs a message's tool calls in parallel unless a tool is `sequential` (journal 182); no tool is.
  - The worker holds several `localExecutor` instances at once: the session's tools, the worker's git (`git-home`), the review copy's git and the reviewer's tools.
  - Pi's custom `grep` (`tools.ts`) spawns `rg` from Node directly, not through the executor, in the worker's own session. `runtime.ts` runs `git` through `execFile` the same way.
  - `coding_runtime_pi/src/security-smoke.ts` and `scripts/pi-cli-container-smoke.mjs` ran one command at a time; the native guard is installed only on Linux, so no local test ever ran it.
  - The coder's project context is the repository's `AGENTS.md`, whose workflow section tells development agents to get plans approved. The coder's role text said nothing about Start.
- **Tested locally (macOS, Node 22.23.4):** a unit test that models the old native `cleanup` (kill every live child's process group and drop its `exit`, as `waitpid(-1)` taking the status does) hung three of five cases against the old `localExecutor`: two commands at once in either order, three at once across two executors, and a command stopped by its timeout or cancelled while a sibling ran. All five pass with the change.

## Diagnosis and alternatives

**Mechanism (inferred from the code and consistent with every measured detail; not reproduced on the production box):** with two commands running, the first to exit runs `cleanup`. It SIGKILLs the other command's shell and reaps it inside native code with `waitpid(-1)`. libuv reaps each child by its own pid, so it never sees that exit, Node never emits `exit` for that child, its `finish` never runs and its promise never settles. Pi's tool batch waits for every call, so the turn never ends. A model-set timeout cannot help: the timer kills the process group (already dead) and waits for the same `exit`. The box's lifetime was the only thing that ended the run. The same kill-all also hits `rg` from the `grep` tool, and `git` from the worker or the runtime, whenever a command finishes while they run.

What "belongs to a command" can mean on Linux, for processes that escaped its process group (a double-forked daemon re-parented to the subreaper worker):

- **Its process group or session alone.** A daemon that calls `setsid` leaves both, so killing only those would let a daemon outlive its command. Rejected as the only rule; each command still kills its own process group at exit, as before.
- **Descendants found by walking `/proc` from the command's root before it exits.** A process can fork and its parent exit between two walks, and the root's `exit` is the moment we learn it ended, after its children may have been re-parented. Racy without a freeze. Rejected.
- **A cgroup per command.** Exact, but needs a writable delegated cgroup in the box and the container smoke's `--cap-drop=ALL` user; not available to the worker today. Rejected for now.
- **Defer the kill-everything sweep to when no command runs.** A process-wide count of running commands across every `localExecutor`; each command still kills its own process group when it exits; the sweep runs only when the count reaches zero. Chosen: it is the smallest change and is correct for every case listed in the task. While a sibling runs, a daemon left by a finished command may stay alive until the sibling finishes; it can do nothing a still-running command could not do anyway (same user, same box), and the sibling's own adopted processes are never killed under it.

The deferral alone still leaves the sweep killing and reaping the worker's own children (`rg`, `git` through `execFile`) that happen to run when the last command finishes. So the native sweep also changes what it targets: every command starts in a session of its own (`detached` spawn calls `setsid`) and no process can join another session, so a child of the worker whose session differs from the worker's descends from a command. The worker's own children share its session and are never touched. Each target is reaped by its own pid, never with `waitpid(-1)`. A pid stays the worker's until the worker reaps it, so it cannot be reused between `getsid` and `kill`. A child whose session cannot be read is left alone, never reaped. What changed in the safety property: the sweep no longer kills or reaps anything in the worker's own session, which the old sweep did. A process started by a command still cannot outlive the last running command, and the sweep still throws when command descendants remain after it; but a process the worker itself starts outside the executor, and anything that process leaves behind, is no longer swept. That is safe only if nothing the worker runs outside the executor can start a program the model chose; see the update below for the case review found and its fix. (Corrected 16 November 2026: this sentence first said "The safety property is unchanged", which was wrong when written: `baseFile` and `start()` ran `git` outside the executor with the repository's own configuration.)

**Why every command's promise settles now (by construction, not by a timer):** once `spawn` returns, libuv emits either `error` (the process did not start) or `exit` (it started and libuv reaped it), and both call `finish`, which settles the promise exactly once. libuv reaps a child only by that child's pid; the only other reaping in the process is the sweep, which runs while the count is zero, that is after every command's `exit` has already been delivered, and which reaps only processes outside the worker's session, so never a shell Node waits for. A kill that fails changes nothing: `process.kill(-pid)` failing falls back to `child.kill`, which is silent on ESRCH; a process that is already gone was reaped by libuv, which emits its `exit`; SIGKILL cannot be caught or ignored. The count is shared through `globalThis`, so a second copy of the module would still share it. It is raised only after `spawn` returns, so a synchronous throw from `spawn` cannot leave it raised.

**The plan question:** the coder followed the repository's `AGENTS.md`, written for development agents working with the owner directly. In this flow the owner's Start is the approval and no plan step exists. The coder's role text now says so in one sentence and limits `ask` to decisions that are genuinely the owner's.

## Other places that assumed one command or one tool at a time

- **Fixed:** `rg` from the `grep` tool and `git` through `execFile` (worker session children) were killed and reaped by the old sweep; the session rule above protects them.
- **Safe, with reasons:**
  - Pi's truncated-output files in the per-run `outputs` directory (`TMPDIR`): Pi names each `<prefix>-<16 random hex>.log` and opens it with `wx` (`utils/output-files.js`), so concurrent calls never share a file. `TMPDIR` is set per run, and the worker runs one role at a time (`active` in `pi-worker.ts`; `CodingRuntime.run` refuses a second run).
  - Checkpoints: Pi awaits the extension hook at turn end, after the whole batch; the existing test "parallel tool calls overlap and checkpoints wait for the whole batch" covers it.
  - Task saves from concurrent `tool_execution_start` events: `TaskStore.save` orders saves of one task (journal 182) and writes a random temporary name.
  - `edit` and `write` on one file: Pi's tools wrap our operations in its per-path `withFileMutationQueue`.
  - The review seal's before/after walks and the reviewer's fixed `review` path: the seal runs before and after `runRole`, never while the reviewer's commands run, and only one reviewer exists.
  - Tool homes: concurrent commands share `HOME`, as two shells of one user do; nothing in the executor writes there itself.
- **Not verified:** two `kite` installs at once sharing one `KITE_STORE`. Whether kite locks its store was not examined here (kite is owned by the JS toolchain work); two installs into the same `node_modules` would conflict with any package manager.

## Implementation and review

- `coding_runtime_pi/src/workspace.ts`: a process-wide count of running commands; `finish` runs `cleanup` only when the count reaches zero. The settle argument above is in the function's comment.
- `coding_runtime_pi/native/process.c`: `cleanup` kills and reaps only children whose session differs from the worker's, each by its own pid.
- `coding_runtime_pi/src/runtime.ts`: the coder's role text gains one sentence: the owner has started the job, there is no plan approval, ask only for a decision that is genuinely the owner's.
- Tests:
  - `coding_runtime_pi/tests/executor-concurrency.test.ts` (runs everywhere): a fake guard with the old kill-all-and-reap behaviour; two commands in either order, three across two executors with a slow one, timeout and cancellation while a sibling runs, sequential commands still swept after each, a failed spawn not counted.
  - `coding_runtime_pi/tests/runtime.test.ts`: the coder's built system prompt carries the new sentence.
  - `coding_runtime_pi/src/security-smoke.ts` (Linux, real guard): two commands at once through the tool and git executors in both orders; three with a slow one; a daemon left by one command while a sibling runs, gone once none runs, while the sibling's own adopted process survives to finish its work; timeout and cancellation while a sibling runs; a worker child in the worker's session surviving the sweep with its exit status intact. The existing privacy and detached-daemon assertions are unchanged.
  - `scripts/pi-cli-container-smoke.mjs` (Linux, real guard, real Pi through the standalone guarded CLI): after the existing daemon and check turns, a turn with two `bash` calls in one message and a turn with three, a slow one and a daemon among them, then a check that the daemon is gone; each result must carry its own output and exit code. The run must now take exactly six model calls.

## Verification and outcome

- **Ran locally:** the new unit test failed three of five cases against the old executor (each "never settled") and passed five of five after the change. A copy of the container smoke that runs the unguarded CLI on macOS instead of Docker, with the daemon replaced by a dead pid, passed: Pi ran the two- and three-call turns and returned each call's own result. The native file passed a `-fsyntax-only -Wall -Wextra` compile against Node's headers with a stub `sys/prctl.h`; it was not built or run.
- **Only CI verifies:** the native guard's session rule on Linux, the security smoke and container smoke cases above, and that the existing reaping and confinement assertions still hold with the new sweep. CI runs only the new guard; that the old guard hangs these cases rests on the local model test above. (Corrected 16 November 2026: this line first listed "that the old guard would have hung them" among what CI verifies, which was wrong when written.)
- **Not measured:** a real job with parallel calls on a box after release.

## Follow-up and next iteration

- After release, check the first jobs whose turns request more than one call: each turn's tool results should arrive and no run should outlive its work.
- A cgroup per command would give exact ownership if the box ever delegates cgroups to the worker.
- Whether kite's store tolerates two installs at once remains open for the JS toolchain work.

## Update, 16 November 2026: repository configuration and the worker's session

> **Update, 16 November 2026:** the independent review of PR 497 (head `fd96698d`) confirmed the hang fix and found one escape the session rule opened, plus a guard that reported success without looking.

- **Found in review (reported, then reproduced locally here):** `runtime.ts` read the reviewer's base `AGENTS.md` with `git -c core.hooksPath=/dev/null show <base>:AGENTS.md` through `execFile`, and `start()` checked the base with `git cat-file -e`, both in the workspace and both outside the executor. They read the repository's own `.git/config`, which the coder's or reviewer's shell can write. In a repository set up as a partial clone with one blob missing, the `show` lazy-fetches the blob through the configured `core.sshCommand`, so a program the model chose ran as a child of the worker, in the worker's session. A daemon it double-forks is adopted by the worker in that session, and the new sweep skips it for the life of the box. The new unit test's control case shows `show` running the configured program on macOS; a manual run of the Linux smoke's fixture on macOS left a daemon, which was then killed by hand.
- **Fix:** both reads now go through the task's own executor (detached, counted, swept) and through the workspace's private git directory, the one the snapshot already uses (journal 193): the repository's objects as alternates, a configuration written afresh, hooks, fsmonitor, home ignore and attribute files off. No repository configuration is read, so no promisor remote, `core.sshCommand`, filter, external diff, pager, alias, fsmonitor or credential helper can run. The base file is read with `cat-file blob` (no filter or text conversion) into a file in the private directory, so its exact bytes are kept. A missing blob now reads as no `AGENTS.md`, since no promisor applies.
- **Guard that could not look:** `cleanup` treated a children list it could not open as "nothing remains" (this predates journal 199). It now throws when the first open or the final check cannot open the list. The security smoke asserts the list is readable in the box.
- **Audit of every program the worker or runtime starts outside `localExecutor`:**
  - `runtime.ts` `baseFile` and `start()`'s `git cat-file`: fixed as above; nothing in `coding_runtime_pi/src/runtime.ts` spawns a program now.
  - `tools.ts` `grep`: `rg` with the environment `PATH` and `LANG` only, so no `RIPGREP_CONFIG_PATH` and no configuration file is read (`rg` reads one only from that variable). Its arguments are fixed flags, plus the model's glob and context number as separate values after their flags, the pattern after `--` and a path checked by `Workspace.path`; the options that make `rg` run other programs (`--pre`, `--search-zip`, `--hostname-bin`) are never passed. Workspace `.ignore` and `.gitignore` files only filter which files are read. It runs in the worker's session, as before.
  - `cli.ts`: `git clone` and `git rev-parse` of a repository the operator names, in the operator's own unguarded CLI process, before any session exists; not the box worker.
  - `src/boxes/coding-task.ts`: spawns the worker itself.
  - `security-smoke.ts`: test-only children.
  - `src/coding/pi-worker.ts`: every program it starts goes through `localExecutor` (the `initial`, `worker` and review-copy executors), so anything git starts there is detached, counted and swept like a command. Its git still reads the repository's own configuration in places: the clone and rebase run on a fresh clone made in this box before any model command; the review seal's `git ls-files -v -z` reads no blob, with hooks and fsmonitor off; the review copy's `git clone --no-local` runs `upload-pack` in the coder's repository, where git 2.39 (the box's Debian git) can lazy-fetch through a promisor remote the coder configured. These are a program the model could choose running in the swept path, which gives it nothing its own commands do not already have, but not "no repository-configured program runs". Moving them to private git directories was not done here.
- **Tests:** `coding_runtime_pi/tests/repository-config.test.ts` (any platform): the hostile fixture runs its program when read the old way; `committedFile` and `hasCommit` run nothing; a reviewer `start` and `run` run nothing and both reads go through the executor in the private directory (this case failed against the previous `runtime.ts`); exact bytes are kept, including a byte that is not UTF-8. `security-smoke.ts` (Linux, CI only): the same fixture whose `core.sshCommand` starts a detached daemon; the read must not run it, and if anything ran, the daemon must be gone once no command runs.

## Update, 16 November 2026: released, image built and pinned

Merged as `5ef1f8b` (PR 497) at the reviewed head `3457c94`; release run 43796810592 succeeded and the gateway was healthy at `5ef1f8b`. CI's "Pi worker boundary" job ran the new Linux cases on that head and passed. The worker image built from `5ef1f8b` (run 43796246445, `sha256:bfecdb52…`) is pinned in `config/coding-pi.json` and `config/boxes.json`, with no previous image listed.

- **Open job.** Job `46463771` keeps the previous image in its settings. It is waiting for the owner and has not started publishing, so `coding_job_update` with `upgradeWorker` moves it to this image before it continues.
- **Still not measured:** a real job with two commands in one turn on a box.
- **Found while reading the same job's trace, not explained:** one single command (a full `kite run check`, about ten minutes) returned only "Command descendant cleanup failed; inspect before continuing", so its output was lost. Three earlier full runs in the same box did not fail. The guard gives killed processes about 100 passes of one millisecond to leave the worker's child list, and this change kept that window. Whether the window is the cause is a hypothesis; a reproduction on Linux is in progress.
