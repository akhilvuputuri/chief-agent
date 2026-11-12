# Pi acceptance workloads and oracles

What remains of the manual Pi verification campaign described in [the execution contract](../../docs/pi-runtime-verification.md). Nothing here launches paid work.

- `workloads.json` pins the acceptance workloads and their fixture source.
- `prepare-oracle.mjs` writes a selected independent oracle (from `oracles.ts.txt`) outside the candidate workspace. Grade only after the coding process has stopped, in a fresh workspace restored from its exact saved artifact.
- `metrics.mjs` summarises Pi session files; `node --test scripts/pi-acceptance/metrics.test.mjs` checks it.
- `results/` holds the recorded results of earlier runs.

The manual runner, model broker and provider helper were retired on 13 November 2026 ([journal 184](../../docs/journey/184-pi-native-anthropic-protocol.md)): they called models through the OpenRouter adapter and drove the OpenAI-shaped Pi proxy, both gone now that Pi speaks Anthropic's protocol to the host. A new paid run needs a runner on the direct Anthropic route.
