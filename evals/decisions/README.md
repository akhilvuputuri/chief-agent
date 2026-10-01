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
- **One call per message, as in production.** Each call is scored on its own. `--runs 3` repeats every case to add samples and to show the spread between runs. Results are never averaged into a consensus that production would not have.
- **Failures take the safe path.** A failed call counts as keeping the context (continuity) or leaving the message to Chief (routing), exactly as the runtime would fall back.
- **Tuned on one split, reported on the other.** A probabilistic backend's threshold is chosen from tuning calls only: the largest gain that still meets the safety bar (`--min-recall` or `--min-precision`, default 1.0). In routing, ties go to the higher, more conservative threshold. Every reported number is on held-out calls. Rules have no threshold and are reported as written.
- **Margin and sensitivity.** Continuity reports the lowest follow-up probability in tuning and in held-out, and what the threshold and held-out recall become if the single tuning label that sets the threshold is removed.
- **Intervals.**
  - 95% bootstrap intervals that resample whole clusters: a conversation in continuity, a case's repeated calls in routing. Cases from the same conversation are not independent.
  - Differences between two backends: an exact two-sided McNemar test on per-case correctness, where a case is right when most of its calls are.
- **Costs and latency.** Latency is the client-measured request time (mean, p50 and p95). Cost is OpenRouter's reported `usage.cost` per decision. A paid backend that reports no cost shows as unknown, never as zero.
- **Traceable reports.** Each report records the git revision and a content hash of the harness and fixtures.

## Decisions

| Decision     | Question                                                                        | Safety metric                                                    | Gain                                                             | Fixtures                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `continuity` | Does the latest message need the previous exchange?                             | Recall on follow-ups (a wrong drop loses context)                | Characters of the previous exchange not sent, per message        | 240 cases from 40 fictional conversations, split by conversation (144 tuning, 96 held-out). Standalone messages come from a separate pool per split, so no message appears in both. |
| `routing`    | Can one agent handle the whole message (a fast path past Chief's routing call)? | Precision of routed messages (a wrong route wastes an agent run) | Coordinator model calls saved, and net time and cost per message | The 181 picker scenarios relabelled for the post-#129 agents (105 tuning, 76 held-out)                                                                                              |

Backends per decision:

- **`continuity`:** `keep` (today: always keep), `rule` (word cues and very short messages), `jev` (one Noul question), `flash` (JSON answer with confidence).
- **`routing`:** `chief` (today: Chief always routes), `rule` (the production word cues in `src/tool-domains.ts`, routing when they point at exactly one agent), `jev` (one Choice question over the agent catalogue plus `chief`), `flash`.

## Limits

- **Labels.** One annotator, the developer, labelled synthetic messages. The evals test whether a backend can make the distinction, not how often each case occurs in real use. Fixture mixes (for example half follow-ups) are a design choice, not a traffic estimate.
- **Held-out pool written after a first run.** The held-out continuity standalone messages were written after the first run had shown which messages Jev got wrong. They are new and separate from tuning, but that order is a possible source of bias. Shadow-mode traffic is the blind check.
- **Debatable routing label.** `t-none-8` ("latest news on the Fed rate decision") is labelled `web`: the news agent manages the bulletin and does not look up news.
- **Different inputs for the rule.** The routing rule sees only the message, as the production cues do. Jev and Flash also see up to two prior turns.
- **Proxies for saved calls.** Routing converts saved calls into time and money with the mean of all main-model calls over a few days before #129. A coordinator call whose only job is `agent_run` is probably shorter, so those savings are upper estimates.
