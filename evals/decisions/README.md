# Decision evals

Paired, statistically reported evaluations of small decision models (Jev on OpenRouter, Gemini 3.8 Flash as a small-LLM comparison) against Chief's current behaviour and a simple rule. This is the measurement harness for [issue #127](https://github.com/akhilvuputuri/chief-agent/issues/127). It answers one question per decision: is a decision model suitable here, and what does it gain?

```sh
npm run eval:decisions -- continuity            # paid: Jev and Flash, 3 runs per case
npm run eval:decisions -- routing --runs 3
npm run eval:decisions -- continuity --backends keep,rule   # free baselines only
```

Paid backends need `OPENROUTER_API_KEY` in the environment or `--env-file`. A full run of one decision costs well under $1. Reports are written to `results/<decision>-<time>.json` with every call, and a Markdown table is printed. The fixtures are fictional and synthetic, so reports contain no private data.

## Method

- **Paired.** Every backend answers the same cases, so even a small difference shows up.
- **Repeated.** Jev is not deterministic, so each paid backend answers each case three times. A case whose decision changes between runs is reported as unstable.
- **Tuned on one split, reported on the other.** A probabilistic backend's threshold is chosen on the tuning split only: the largest gain that still meets the safety bar (`--min-recall` or `--min-precision`, default 1.0). Every reported number is on the held-out split. Rules have no threshold and are reported as written.
- **Intervals.**
  - Proportions: 95% Wilson score intervals.
  - Gains: 95% percentile bootstrap intervals (4,000 resamples, fixed seed).
  - Differences between two backends: an exact two-sided McNemar test on the cases where they disagree.
- **Costs and latency.** Latency is the client-measured request time (p50 and p95). Cost is OpenRouter's reported `usage.cost`. Gains are also expressed per message, against production averages from the operational log (stated in each module).

## Decisions

| Decision     | Question                                                                        | Safety metric                                                    | Gain                                                             | Fixtures                                                                                   |
| ------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `continuity` | Does the latest message need the previous exchange?                             | Recall on follow-ups (a wrong drop loses context)                | Characters of the previous exchange not sent, per message        | 240 cases from 40 fictional conversations, split by conversation (144 tuning, 96 held-out) |
| `routing`    | Can one agent handle the whole message (a fast path past Chief's routing call)? | Precision of routed messages (a wrong route wastes an agent run) | Coordinator model calls saved, and net time and cost per message | The 181 picker scenarios relabelled for the post-#129 agents (105 tuning, 76 held-out)     |

Backends per decision:

- **`continuity`:** `keep` (today: always keep), `rule` (word cues and very short messages), `jev` (one Noul question), `flash` (JSON answer with confidence).
- **`routing`:** `chief` (today: Chief always routes), `rule` (the production word cues in `src/tool-domains.ts`, routing when they point at exactly one agent), `jev` (one Choice question over the agent catalogue plus `chief`), `flash`.

## Limits

- Labels come from one annotator, the developer, on synthetic messages. They test whether a backend can make the distinction, not how often each case occurs in real use.
- Routing gives a fast path only when all three runs agree. That is more conservative than a single production call.
- Production averages used to convert gains (a typical request's characters, a coordinator call's time and cost) come from a few days of one owner's traffic. They are stated where they are used.
