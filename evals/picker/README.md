# Tool picker eval

Measures the tool-group picker: for each labelled message, Jev (the model in
`config/tool-picker.json`) answers one yes/no question per tool group, and the
pick rule chooses which groups to load. The eval reports how often the needed
groups are loaded (recall), fully covered calls, extra groups loaded, the tool
schema characters that would be sent (and their share of the full tool list),
run-to-run stability, latency, cost and per-scenario misses.

```sh
npm run eval:picker
npm run eval:picker -- --runs 1 --split held-out
```

Other options: `--concurrency`, `--floor`, `--timeout`, `--seed`, `--out`,
`--env-file`. The key comes from `OPENROUTER_API_KEY` or the env file and is
never printed. Reports go to `eval-results/picker-<UTC time>/` (`report.json`,
`report.md`). The run fails (exit 1) when pooled recall is below the floor
(default 0.97) or any call failed; exit 2 means no key.

Cost is about $0.00008 per call, so about $0.04 for 3 runs of all 174
scenarios.

`scenarios.json` is synthetic: written and labelled by the developer, not taken
from production traffic. `tuning` scenarios may guide changes to the questions
or thresholds; `held-out` ones should only be used to check them.

Run by hand, not in CI. The offline contract tests (no network) are:

```sh
python3 -m unittest discover -s evals/picker -p 'test_*.py'
```

`picker.py` is the reference for the request and pick rule; the TypeScript
runtime must match it (`pick-cases.json`, `request-golden.json`).
`sizes.ts` prints each group's schema size (`npx tsx evals/picker/sizes.ts`).
