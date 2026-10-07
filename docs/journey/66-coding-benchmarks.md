# 66 — Measuring coding repairs independently of squad approval

Work dates: 7–8 October 2026. Status: implementation under review; no paid trials.

## User-visible problem and preceding iteration

The [coding automation milestone](64-coding-automation.md) established dispatch, artifact review and guarded publication. Mocked/runtime contract tests and startup health did not establish a real coding task success rate. The requested next step is a Chief-first benchmark with a small public comparison slice.

## Evidence and choice

Source inspection at freshly fetched main `0e714880d989edfe89d11de2ead95ec45846513f` found file reading, coder shell execution, separate role contexts and fixed npm candidate checks. Reviewer content search, precise edit tools, full test-log retrieval and an evaluation-only inference path remain opportunities. These are observed interface limitations; their impact on success rate has not been measured. Adding RAG first would not resolve missing baseline evidence.

The first pack uses six small seeded component regressions in frozen Chief TypeScript/Python modules, with four immutable public task selections from SWE-bench Verified/Multilingual. Choosing a narrow offline pack permits deterministic fixture validation before spending on model trials. It does not resume the older deferred runtime-evaluations checkpoint, claim full-repository coverage or implement model-weight training.

## Implementation and review

[The benchmark guide](../../evals/coding/README.md) defines task export, complete-file candidate submission, isolated Docker grading, run identity and experiment rules. Only the broken source and prompt are exported. Evaluator-owned target and preservation assertions stay outside the agent workspace. Missing/invalid candidates, timeouts and infrastructure failures remain visible in the denominator. Ordinary exit zero does not establish assertion completion. Container checks use an immutable amd64 image, no network, non-root execution, read-only mounts and bounded resources. Failed cleanup is an infrastructure error.

The public lock records dataset revisions, parquet hashes, base commits and task IDs selected before any model run. Public evaluator execution/environment validation remains pending. The live squad is not yet wired to these fixtures; its fixed Chief checkout/npm verification and publication path must not be used for these trials.

## Verification and outcome

Synthetic local measurement, 8 October: all six seeded bases failed their target assertions and passed preservation assertions; all six reference sources passed both groups (24 assertion-group processes). This validates fixtures, not coding-agent performance. Nine offline runner/fixture tests passed initially. Real local Docker validation then rejected all six seeded candidates and accepted all six reference candidates (24 fresh assertion-group containers); an additional early-exit candidate was rejected. The pinned amd64 image ran under Apple Silicon emulation. The first full repository check exposed copied TypeScript fixture files being picked up by the existing eval typechecker; storing immutable source bytes as `.txt` fixed that without changing source content. The subsequent run hit local IPC sandbox restrictions; a permitted rerun is pending. No production logs, private user data, model calls or paid sandboxes were used.

Independent exact-head review and hosted checks remain pending. No live coding acceptance, model/provider quality, token/cost benefit or production benchmark deployment is claimed. The dataset is public development material, not a hidden holdout; the next iteration should add real multi-file Chief issues and keep an untouched holdout outside agent-visible source.

## Follow-up

Build the evaluation-only inference adapter around the existing Python loop/OpenRouter adapter, with no publisher, case-specific visible checks, clean source snapshots and restricted network. First compare tools/context changes with models fixed, then model-role configurations with harness fixed. Record repeated trials, actual provider usage and failures; score Chief and public tasks separately. Compare reviewer false approvals and a matched-allocation single-agent baseline later.
