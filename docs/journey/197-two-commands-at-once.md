# 197 — Why did two commands in one message stall the reviewer for three hours?

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

The deferral alone still leaves the sweep killing and reaping the worker's own children (`rg`, `git` through `execFile`) that happen to run when the last command finishes. So the native sweep also changes what it targets: every command starts in a session of its own (`detached` spawn calls `setsid`) and no process can join another session, so a child of the worker whose session differs from the worker's descends from a command. The worker's own children share its session and are never touched. Each target is reaped by its own pid, never with `waitpid(-1)`. A pid stays the worker's until the worker reaps it, so it cannot be reused between `getsid` and `kill`. A child whose session cannot be read is left alone, never reaped. The safety property is unchanged: no process started by a command outlives the last running command, and the sweep still throws when command descendants remain after it.

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
- **Only CI verifies:** the native guard's session rule on Linux, the security smoke and container smoke cases above, that the old guard would have hung them, and that the existing reaping and confinement assertions still hold with the new sweep.
- **Not measured:** a real job with parallel calls on a box after release.

## Follow-up and next iteration

- After release, check the first jobs whose turns request more than one call: each turn's tool results should arrive and no run should outlive its work.
- A cgroup per command would give exact ownership if the box ever delegates cgroups to the worker.
- Whether kite's store tolerates two installs at once remains open for the JS toolchain work.
