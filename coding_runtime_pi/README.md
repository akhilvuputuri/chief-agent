# Independent Pi coding runtime

A TypeScript library and CLI for repository learning, planning and explicitly approved builds. Pi 1.1.0 supplies the agent/tool loop, native model protocol implementation, sessions and compaction. This package has no Chief, Telegram, database, GitHub account or AWS dependency. Copy this directory to another repository and run the same install/build/check commands.

Planning uses a focused investigation pass: after 32 navigation operations or ten minutes, at the next settled turn boundary (three quarters of a shorter remaining time allocation). Then at most two final turns return a complete source-grounded plan or a specific question about missing evidence. Checkpoints settle before the handoff. Advertised planning definitions remain stable, while tool admission permits only report execution in finalization. A valid settled plan ends immediately; failed/truncated responses cannot trigger native post-run compaction recovery. One format correction is permitted after a definite tool/admission rejection or completed nonempty prose. Provider failure, truncation and cancellation are not retried. Repeated prose-only endings pause after the bounded correction. Invalid/ignored reporting pauses with a concrete retained-investigation explanation without authorizing implementation. The standalone default active allocation is 40 minutes; model/tool allocations remain 400/1,000. Clients may supply their own allocations.

## Setup

Use Node 22.19.0 or newer. The worker and CI pin 22.23.4 (its bundled undici 6.29.1 fixes a fetch hang on corrupt gzip bodies, journal 126). Install without dependency lifecycle scripts:

```sh
lockstep ci --ignore-scripts
lockstep run check
```

The development tests inject synthetic providers; they make no model API calls. Real inference requires your own explicitly configured development credentials. Keep keys outside repository files. The CLI reads `PI_RUNTIME_API_KEY` for model access and a separate stable private `PI_RUNTIME_STATE_KEY` (at least 32 characters) for signed task records. Both are removed from process environment before generated commands can run. State recovery requires retaining the signing key.

## CLI

```sh
node dist/cli.js start /path/to/repository "Fix the selected bug" --check "lockstep test" --state /private/task-state
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

### Complete report documents

Reports have a versioned content identity and a shared 32,000-character document bound, separate from a 4,000-character status summary (questions: 2,000). Full accepted documents are retained; approval binds the exact complete plan. Long approved plans and reviewer findings are read with `read_document` in 4,000-code-unit pages, preserving Unicode boundaries and original offsets. Every required page must be read in each fresh attempt before edits/commands/final reports. Documents remain available after compaction. Host-supplied immutable evidence may contain up to 500,000 characters per document (at most four caller documents), matching the bridge’s existing patch bound. Evidence remains paged at 4,000 code units; model-written report bounds are unchanged. Definite invalid reports receive a bounded formatting correction and precise retained-draft failure feedback; explicit recovery continues reporting without repeating repository investigation. Unknown provider outcomes and uncertain writes are not replayed.

The Chief bridge uses Pi's selected-model context metadata. Its 179,000-byte request envelope is a separate transport bound, and its configured output ceiling remains 16,000 tokens. An artificial 40k model window previously caused native output clamping before final planning; using model metadata preserves the actual capacity while native pre-send envelope recovery still bounds requests. Unknown models retain the compatible adapter's conservative fallback unless the caller provides their context capacity.

## Opt-in terminal HTTP recovery

`compatibleModel` accepts `terminalHttpRecovery: { attemptId }` only for hosts implementing the authenticated failure-receipt protocol. Direct provider connections leave it disabled. The adapter intercepts only its configured completion URL and requires a strict call/attempt-bound receipt for terminal HTTP 429, 500, 502, 503 or 504. A generic error, error prose or facade HTTP 409 is insufficient.

One additional generation is allowed per logical request in the current invocation, including summary requests. A cancellable one-second delay and fresh durable model admission consume the existing allocation. The serialized model payload stays identical except for a new call UUID; `x-runtime-retry-of` identifies its parent to the host. The original failure never enters the tool loop, and ordinary SDK retries remain disabled. A second failure stops. Unknown billing is retained even when another inference succeeds.

The host must independently validate the same failed parent/payload, active attempt, owner access, remaining model/time allocation and one-child bound. It must preserve both journals and issue no eligible receipt for cancellation, timeout, disconnect, incomplete/malformed output, lost acknowledgement or persistence failure. Runtime/store replacement cannot reconstruct an automatic retry; paused work still requires explicit recovery. Summary replacement retains its normal validation and single-commit boundary. This source behavior remains a candidate until reviewed image activation; repository tests do not establish paid reliability.
