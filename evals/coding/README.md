# Coding benchmark pack v1

This is a development benchmark for Chief's coding harness. It is separate from the general assistant evals and the deferred `feature/runtime-evaluations` branch. It has **six runnable Chief component repair tasks** and a **four-instance public comparison lock**. It makes no model-quality claim and performs no model calls, provisioning, publication or merge.

The Chief cases are intentionally seeded regressions in exact source snapshots from `0e714880d989edfe89d11de2ead95ec45846513f`. They are small component tasks, not historical incident replays or full-repository feature tasks. The source hash, mutation and independent evaluator tests are versioned. Frozen source files retain the repository's MIT license. An exported agent workspace contains only the broken module and task description, with no Git history, solution or grader.

| Chief task                  | Language   | Required repair                                              |
| --------------------------- | ---------- | ------------------------------------------------------------ |
| `chief-format-surrogate`    | TypeScript | Keep emoji intact across Telegram message chunks             |
| `chief-format-entities`     | TypeScript | Clip/rebase formatting entities at chunk boundaries          |
| `chief-routing-owner`       | TypeScript | Preserve the originating topic for owner work                |
| `chief-routing-retired`     | TypeScript | Redirect queued retired Updates destinations to logical Main |
| `chief-protocol-unicode`    | Python     | Match the host's UTF-16 artifact limits                      |
| `chief-protocol-duplicates` | Python     | Reject ambiguous duplicate artifact paths                    |

All ten selected tasks are **development** cases. Publicly committed gold sources/tests cannot be called a secret holdout. Do not train or tune on a future holdout; create that separately from newly reported issues, freeze it before experiments, and keep it outside agent-visible repositories. Six simple, related cases cannot estimate general engineering competence.

## Offline use

Use the repository's Python development environment (including locked Pydantic dependencies), Node 22 and Git. No keys or `.env` are needed.

```sh
npm run eval:coding -- list
npm run eval:coding -- validate
npm run eval:coding -- prepare chief-format-surrogate /tmp/chief-format-task
```

`validate` runs only reviewed bundled sources and their fixed mutations on the local machine. For each task it proves: broken target fails, broken regression checks pass, reference repair passes both groups. This is **fixture validation**, not an agent score. `npm test` includes the offline fixture and grading-boundary tests.

`prepare` requires a nonexistent output directory and never overwrites a workspace. Give only that exported directory to the coding agent in a disposable sandbox. Do not point the agent at `evals/coding`, the full Chief Git history, the frozen upstream commit, the reference source or these grader files. Disable repository/network lookup during the trial; otherwise the original public solution is readily available. The exporter itself does not provision or enforce the agent's sandbox.

### Candidate format and isolated grading

Save one JSON object per line. Chief candidates use complete file contents, matching the Python runtime's artifact representation. This format is deliberately distinct from SWE-bench's patch predictions.

```json
{
  "instance_id": "chief-format-surrogate",
  "files": { "src/telegram-format.ts": "<complete candidate file>" }
}
```

Only the case's one editable source path is accepted; evaluator tests and extra files cannot be submitted. Missing predictions remain in the six-task denominator. Run one configuration/trial per report. Example configuration (replace the harness SHA with the actual tested commit):

```json
{
  "harness_sha": "0e714880d989edfe89d11de2ead95ec45846513f",
  "models": {
    "leader": "deepseek/deepseek-v4.1-flash",
    "coder": "deepseek/deepseek-v4.1-flash",
    "reviewer": "openai/gpt-6.1-sol"
  },
  "effort": "high",
  "limits": { "ms": 900000, "models": 40, "tools": 100 },
  "trial": 1
}
```

Start Docker and explicitly pull the digest in `run.py` once with `docker pull --platform=linux/amd64 IMAGE`; grading never pulls automatically. This is the existing amd64 worker image with Node, Python and Pydantic. Apple Silicon requires Docker amd64 emulation. It contains a worker entrypoint, but the grader overrides it and never starts that worker.

```sh
npm run eval:coding -- grade predictions.jsonl config.json eval-results/coding-trial-1.json
```

Create the output parent directory first. Reports cannot overwrite an existing result. Each assertion group runs in a fresh non-root, network-disabled, read-only container, without credentials or a Docker socket. Only a temporary candidate directory and trusted graders are mounted read-only. Memory, CPU, processes and wall time are bounded; the runner attempts forced cleanup even after a CLI timeout. Only reviewed bundled fixture validation can run locally: there is no local-candidate execution flag. Treat the trusted grader source/host and Docker engine as trusted. Containers and ordinary test assertions do not make arbitrary adversarial code perfectly safe or prove immunity to test gaming.

A task is `resolved` only when **both target and regression checks pass**. Reports distinguish unresolved tests, invalid candidates, missing predictions, timeouts and infrastructure errors. Docker setup errors must not be presented as model failures or silently removed from the denominator. The report records candidate hashes, suite/pack identity, grader image, supplied harness/model settings and a unique run ID. These settings describe the submitted experiment; the offline grader cannot attest which model produced a file. Token usage, cost and latency must come from the eventual inference runner, not be inferred from grading time. Grading consumes no model allocation or dollars.

## Public slice

`public-slice.json` pins dataset commits, parquet SHA-256s, instance IDs, original base commits, test identifiers and problem hashes. Selection was fixed before any model run: lexicographically first instance for each of four preselected repositories. The reference patches are not vendored.

| Dataset                | Repository | Instance              |
| ---------------------- | ---------- | --------------------- |
| SWE-bench Verified     | requests   | `psf__requests-1142`  |
| SWE-bench Verified     | Flask      | `pallets__flask-5014` |
| SWE-bench Multilingual | axios      | `axios__axios-4731`   |
| SWE-bench Multilingual | Vue        | `vuejs__core-11589`   |

Use the dataset revision in the lock to download the test parquet, verify its byte hash, and select those IDs. Validate the gold/broken environment using the **official evaluator** before any paid trial. Preserve dataset/repository licenses when fetching or redistributing source. Python tasks come from [Verified](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified); JavaScript/TypeScript tasks come from [Multilingual](https://www.swebench.com/multilingual.html). This tiny convenience slice is not a representative leaderboard score, and environment readiness has not been verified here.

Public candidates use [SWE-bench's official prediction format and Docker evaluator](https://www.swebench.com/SWE-bench/guides/evaluation/): `instance_id`, `model_name_or_path`, `model_patch`. Run each dataset separately against its pinned local data. Freeze the evaluator commit and image/environment identities before the first run; do not silently resolve an unpinned latest dataset. Use a **new run ID for every configuration and trial** because the official evaluator caches by run ID and instance. Keep public and Chief scores separate. This milestone records the public slice; it does **not** implement a public dataset downloader or run the official evaluator.

## Experiments and next boundary

The live squad still assumes Chief's repository and fixed npm checks. This pack does **not** wire the live leader/coder/reviewer loop into a benchmark mode. Do not submit these tasks through production coding: it could publish changes, exposes upstream history, and does not isolate evaluator artifacts. A separate disposable inference adapter must use the existing Python loop/OpenRouter adapter, model/tool/time allocations and provider price filters; it must never use production publication credentials. Supply case-specific visible checks, keep gold/grader material outside the agent workspace, and retain bounded call/tool traces and actual usage. Public tasks additionally need their own install/test recipes.

Start with the same model assignments and repeated trials on this pack. Change one factor at a time: tools/context handling with models fixed; then coder/reviewer assignments with harness fixed. Compare resolved/total, per-case regressions, infrastructure failures, timeouts, actual usage and wall time. Three trials per configuration are a reasonable initial diagnostic, not statistical proof. Later compare the squad against a single-agent baseline at matched allocations, and independently measure reviewer false approvals/rejections using known good/bad candidates. Operational cancellation/resume/permissions tests remain a separate suite, not extra coding successes.

Here, “tuning” initially means prompts, tools, context handling and model assignments. Training model weights requires a separate licensed training set/trajectory pipeline and untouched evaluation set; the benchmark is not automatically training data. Add real multi-file Chief feature/issue tasks and an untouched holdout after this small suite establishes the evaluation path. RAG should be tested against the same frozen tasks only after basic file/search/edit/test feedback is reliable.
