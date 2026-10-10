# Independent Pi coding runtime

A TypeScript library and CLI for repository learning, planning and explicitly approved builds. Pi 1.1.0 supplies the agent/tool loop, native model protocol implementation, sessions and compaction. This package has no Chief, Telegram, database, GitHub account or AWS dependency. Copy this directory to another repository and run the same install/build/check commands.

Planning uses a focused investigation pass: after 32 navigation operations or ten minutes, at the next settled turn boundary (three quarters of a shorter remaining time allocation). Then one report-only generation returns a complete source-grounded plan or a specific question about missing evidence. Checkpoints settle before the handoff. Invalid/ignored reporting pauses without authorizing implementation. The standalone default active allocation is 40 minutes; model/tool allocations remain 400/1,000. Clients may supply their own allocations.

## Setup

Use Node 22.19.0 or newer. The worker and CI pin 22.19.0. Install without dependency lifecycle scripts:

```sh
npm ci --ignore-scripts
npm run check
```

The development tests inject synthetic providers; they make no model API calls. Real inference requires your own explicitly configured development credentials. Keep keys outside repository files. The CLI reads `PI_RUNTIME_API_KEY` for model access and a separate stable private `PI_RUNTIME_STATE_KEY` (at least 32 characters) for signed task records. Both are removed from process environment before generated commands can run. State recovery requires retaining the signing key.

## CLI

```sh
node dist/cli.js start /path/to/repository "Fix the selected bug" --check "npm test" --state /private/task-state
node dist/cli.js run TASK_ID --state /private/task-state
node dist/cli.js status TASK_ID --state /private/task-state
node dist/cli.js approve TASK_ID PLAN_REVISION PLAN_HASH --state /private/task-state
node dist/cli.js run TASK_ID --state /private/task-state --local-execution
```

`start` clones the repository into a disposable workspace. It defaults to planning; `--mode learn` produces source-grounded findings without an approval plan. `--provider`, `--model` and `--base-url` configure an OpenAI-compatible service. The CLI defaults to OpenRouter and the current development coder choice; production clients supply their own pinned model settings.

`reply TASK_ID REVISION MESSAGE` revises scope and requires a new plan. `resume TASK_ID` explicitly resumes inspected interrupted work; it never starts automatically. `cancel TASK_ID` stops active work or prevents a ready task from running. Commands from another CLI process use signed cancellation requests. An interrupted runner lock is reconciled only when its process is gone.

The local execution flag is an explicit developer choice: generated code runs with that OS user's permissions. For untrusted source use the supplied Linux container or a caller-provided isolated executor. Working directory checks do not sandbox arbitrary shell commands. Mount only the selected source and this task's private state; never mount host credentials, SSH homes or the Docker socket. Use one private owner/task environment per container.

## Library

The public API is `CodingRuntime.start`, `run`, `inspect`, `approve`, `reply`, `resume` and `cancel`. `TaskStore` takes a private storage directory and signing key. Inject a `ModelFactory` and, for build mode, an explicit executor. `compatibleModel` delegates protocol conversion/streaming to Pi's native OpenAI-completions implementation; custom/synthetic factories are supported for testing.

Learn, plan and review expose read/grep/find/list and report. Build additionally exposes guarded editing/writing and a bounded shell tool. Project/global executable resources are not auto-discovered. Approved scope is retained in the system instructions, separate from compaction summaries. The record includes actual check receipts and a saved regular UTF-8 file artifact. Only passing checks produce build completion. Model reports do not grant approval or mark checks passed.

Tasks are signed atomic JSON records; Pi sessions are separate private JSONL files. Mutations use an exclusive runner lock. Model/tool/time allocations are retained on explicit resume; abruptly interrupted time is conservatively charged through inspection within the saved reservation because the precise process-exit time may be unavailable; compaction requests use the same model admission boundary. Session files and task records can contain private source, instructions and results; do not publish them or use them as permission authority. Build exporters currently support at most 100 regular UTF-8 changed files, 128,000 characters per file and 500,000 serialized artifact bytes. Unsupported artifacts stop visibly rather than being truncated.

## Container

Build from this directory with `docker build -t pi-runtime .`. It installs a Linux process guard, disables Node's inspector activation and runs as the non-root node user. The command executor strips environment, applies explicit time/output limits, terminates process groups and reaps detached descendants through the guard. The native guard must load before any credential/bootstrap input is read.

Source must be treated as untrusted: the container is the host boundary and must receive no unrelated private data. The guard prevents same-UID commands reading the runtime's initial environment/memory through proc. Persistent metadata signatures prevent a command from forging an approval record without the private signing key; they do not make local execution a host filesystem sandbox.

## Chief client

Chief's bridge lives outside this package in `src/coding/pi-worker.ts`. Chief retains owner-bound Telegram approval, task identity, model/provider policy, job lease, sandbox provisioning and draft publication. The bridge consumes the library API and maps to Chief's existing private task endpoints. Its native model facade frames completed Chief generations as compatible SSE; it does not claim live token streaming from the underlying provider.

The bridge uploads immutable encrypted Pi session entries separately from artifact checkpoints, so disposable workers do not lose acknowledged context. Existing Python code/images/jobs retain their original runtime selector. The new backend is independently selected for new tasks only; Pi artifacts are draft-only and do not inherit the Python squad's automatic merge authority.

## Evidence boundary

Synthetic tests exercise Pi's real tool execution, actual fixture checks, approval/state boundaries and host-adapter behavior. Linux CI exercises process privacy and detached descendant cleanup. A correct real-model task, production selection and independently accepted published changes require separate release/acceptance evidence; installing Pi alone does not establish quality or cost gains.
