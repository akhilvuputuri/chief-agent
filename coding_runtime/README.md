# Chief coding runtime (Python)

An independently packageable Python 3.12+ worker for disposable execution. Chief stays in TypeScript and owns owner authentication, durable jobs, attempt fencing, OpenRouter request journals, provider price policy, provisioning, publication and Telegram updates. The worker owns cancellable subprocesses, Git artifacts, the coding tool loop, repository verification and fresh read-only review contexts. This boundary separates the product service lifecycle from repository execution and permits independent images and a later repository extraction.

The production adapter is `ChiefOpenRouter`: it submits OpenRouter-compatible messages to Chief using one attempt capability. Chief holds the provider key. The standalone `OpenRouter` adapter is available for separately authorised development clients; the sandbox never loads an OpenRouter API key. `deepseek/deepseek-v4.1-flash` is the configured coder; the reviewer remains `openai/gpt-6.1-sol`. Reasoning details and current tool arguments are preserved unmodified. History compaction removes complete old call groups.

## Development

Use Node 22 for Chief and Python 3.12+ for this package. From the repository root:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --require-hashes -r coding_runtime/requirements-dev.txt
npm ci
npm run check
npm run build
npm run format:check
```

`npm run check:coding` runs Ruff, strict mypy and offline unittest scenarios against the source package. Python tests include a real local Git/npm candidate and review, process cancellation, acknowledgement recovery, wire bounds, reasoning continuation and cross-language artifact identity. No external model or production credentials are needed. To install independently, use `python -m pip install --no-deps --no-build-isolation ./coding_runtime` after installing the hash-locked dependencies. Re-resolve locks deliberately with `uv pip compile` from the checked-in inputs; keep runtime, development and build locks in sync.

## Contract and sandbox

Assignments use `protocolVersion: 1` and the typed models in `protocol.py`. Worker endpoints are assignment, heartbeat, progress, checkpoint, finish and model; all writes are attempt-fenced. The worker requires an immutable root-owned package, Linux UID 1000 and `python -I`. The trusted launcher uses `setpriv`, drops all capabilities and sets no-new-privileges. Before loading credentials or repository code, ctypes sets Linux dumpability to zero. Commands receive a stripped environment and separate process groups. Linux subreaper adoption also terminates/reaps descendants that detach into new sessions. Repository commands are serialized; a separately owned output transport prevents inherited pipes from blocking timeout or cancellation. CI executes the same launcher and proves a same-UID command cannot read its parent environment.

The image includes Node/npm because Chief's target repository checks require them, plus the locked Python check dependencies so those scripts can validate Python changes. Target tests run in child processes; the worker's isolated interpreter does not import checkout code. Source commands cannot choose provisioning settings or publish remotely through host credentials.

See [the host lifecycle and activation runbook](../docs/coding.md). The default remains off. Existing Node-pinned jobs retain their launcher; switch the host runtime and image digest together after the Python image is published and independently verified. There is no migration, automatic task resumption or paid sandbox activation in this refactor.

## Fixed squad

Python 0.1.2 includes an opt-in leader/coder/reviewer supervisor with separate histories, fixed dispatch tools, shared budgets and typed acknowledged handoff checkpoints. Legacy jobs retain their old image/settings path. See [squad contract](../docs/coding-squad.md) for exact-artifact review gates, recovery and reviewed migration/image activation.

Python 0.1.3 adds job-scoped `logs_read` and preserves consumed tool allocation during automatic MR feedback recovery. Chief owns feedback, model preferences, publication witnesses and merge/release gates; no GitHub or production credentials enter the package. See [automation](../docs/coding-automation.md).
