# 50 — Where small decision models pay off: a paired eval harness for issue #127

Work date(s): 2026-10-01. Written/revised: 2026-10-01.
Status: measured offline on synthetic fixtures. Nothing in the runtime has changed.

## User-visible problem and preceding iteration

[Issue #127](https://github.com/akhilvuputuri/chief-agent/issues/127) proposed trying small decision models (Jev) at more selection points in Chief. The owner's aim is to engineer and measure fractional gains, and they need statistics that hold up. Chief has one user and about 10 decisions a day, so production traffic alone cannot produce a defensible comparison. [Journal 37](37-jev-tool-picker.md) built the first Jev consumer, the tool-domain picker. [Journal 49](49-coordinator-agents.md) then moved domain tools into agents, which leaves that picker four small domains to choose from. This entry measures two new decisions instead.

## Evidence

**Measured, offline, 1 October 2026.**

- Both evals ran on held-out fixtures, with every backend answering every case three times.
- Thresholds were tuned on a separate tuning split under a safety bar of 100% (no wrong drops, no wrong routes on tuning).
- Models: `typesafe/jev-1.13-20260917` and `google/gemini-3.8-flash` (low reasoning), both through OpenRouter.
- Reports: `evals/decisions/results/continuity-20261001-1100.json` and `routing-20261001-1108.json`, which include every call.

### Decision 1: does the latest message need the previous exchange?

Chief always sends the previous exchange today. Dropping it for a standalone message saves its characters, but dropping it for a follow-up loses context. Data: 96 held-out cases (48 follow-ups and 48 standalone), from 16 fictional conversations not used for tuning.

| Backend          | Recall on follow-ups (95% CI) | Standalone dropped (95% CI) | Characters saved per message (95% CI) | Share of a typical request | p50 / p95        | $ per 1,000 |
| ---------------- | ----------------------------- | --------------------------- | ------------------------------------- | -------------------------- | ---------------- | ----------- |
| Keep (today)     | 100% (92.6–100)               | 0%                          | 0                                     | 0%                         | –                | 0           |
| Rule (word cues) | **79.2%** (65.7–88.3)         | 87.5% (75.3–94.1)           | 1,747 (1,245–2,265)                   | 3.2%                       | –                | 0           |
| **Jev**          | **100%** (92.6–100)           | 89.6% (77.8–95.5)           | 1,983 (1,408–2,611)                   | 3.6%                       | **309 / 409 ms** | **$0.020**  |
| Flash            | 100% (92.6–100)               | 91.7% (80.4–96.7)           | 1,976 (1,415–2,593)                   | 3.6%                       | 1,846 / 3,025 ms | $0.277      |

- **Differences between backends** (exact McNemar):
  - Jev versus keep: p = 2.3 × 10⁻¹³.
  - Jev versus rule: p = 0.027.
  - Jev versus Flash: p = 1, with 1 against 2 discordant cases.
- **Jev's mistakes were all on the safe side.** All five standalone messages it kept were same-domain new topics, for example "add TSLA with a 6% alert" right after a watchlist question. It dropped all 32 cross-topic messages. Two held-out cases changed between runs.
- **The rule is unsafe.** It dropped 10 of the 48 follow-ups.

### Decision 2: fast-path routing to one agent

After #129, every domain request costs a coordinator model call whose only job is to call `agent_run`. A confident decision could start the agent directly. Data: 76 held-out messages (the picker scenarios relabelled for the post-#129 agents), of which 50 could be routed to one agent.

| Backend              | Routed (wrong) | Precision (95% CI)  | Coverage of routable (95% CI) | Coordinator calls saved per 100 messages (95% CI) | Net time per message | Net $ per 1,000 messages | p50 / p95        |
| -------------------- | -------------- | ------------------- | ----------------------------- | ------------------------------------------------- | -------------------- | ------------------------ | ---------------- |
| Chief (today)        | 0              | –                   | 0%                            | 0                                                 | 0                    | 0                        | –                |
| Production word cues | 28 (**12**)    | 57.1% (39.1–73.5)   | 32.0%                         | 21.1                                              | –                    | –                        | –                |
| **Jev**              | 19 (**0**)     | **100%** (83.2–100) | 38.0% (25.9–51.8)             | **25.0** (15.8–35.5)                              | **−716 ms** (saved)  | **$5.17 saved**          | 334 / 456 ms     |
| Flash                | 10 (0)         | 100% (72.2–100)     | 20.0% (11.2–33.0)             | 13.2 (6.6–21.1)                                   | +1,381 ms (slower)   | $2.24 saved              | 1,934 / 4,256 ms |

- **How net time and cost are worked out.** They use production averages for a coordinator call, 4.2 s and $0.0208 (from the `model.completed` log, 25–30 September, n = 203, before #129). Jev's own latency is subtracted from every message, whether it is routed or not.
- **Wrong routes.** Net figures are before wrong-route costs, which were zero for Jev and Flash.
- **Differences between backends** (exact McNemar):
  - Jev versus Chief: p = 3.8 × 10⁻⁶.
  - Jev versus Flash: p = 0.023, with 11 against 2 discordant cases.
- **Threshold and runs.** A route needs the three runs to agree, at Jev confidence ≥ 0.96. That is stricter than a single production call would be.

## Diagnosis and alternatives

- **Jev suits both decisions.** It matched a small LLM on continuity and beat it on routing, at about a sixth of the latency and a tenth of the cost or less. Its ~0.3 s is the only price, and both decisions pay it back:
  - continuity saves characters on about half of messages;
  - routing saves a 4.2 s call on a quarter of them.
- **Rules alone are not safe here.** They are fast, but the word cues lost follow-ups (79% recall) and misrouted 43% of their routes. Rules remain the fallback when Jev is unavailable, not the primary decision.
- **Flash is the wrong tool for a per-message gate.** It is accurate but 1.8–1.9 s at p50, and Gemini rate-limited the eval at concurrency 6. Those 429s were retried with backoff so they did not count as errors.
- **What these numbers do not show.** How often each case occurs in real use, and whether answers improve, are not measured. A dropped previous exchange is still reachable through the exchange index and `conversation_read`, and a fast-path route still ends with Chief writing the reply.

## Implementation and review

- `evals/decisions/`:
  - `run.py` is the paired runner. It tunes on one split and reports on the other.
  - `stats.py` has the Wilson, bootstrap, McNemar and percentile functions.
  - `backends.py` is the Jev decisions client and the Flash JSON client, with retries on 429 only.
  - `continuity.py` and `routing.py` are the two decisions.
  - `cues.ts` runs the production word cues for the routing rule.
  - `fixtures/gen_*.py` build the fixtures.
  - `test_decisions.py` has 12 offline tests and runs in `npm test`.
  - `README.md` documents the method and its limits.
- Command: `npm run eval:decisions -- <decision>`. Paid; both full runs together cost under $2.
- Independent review: pending.

## Follow-up and next iteration

- **Wire both decisions into the runtime in shadow mode.** Log Jev's would-be decision next to today's behaviour, without changing what Chief sends. Then enable each behind a switch: continuity first (its gain is free of extra model calls), then fast-path routing.
- **Keep the measurement going.** The same fixtures will judge any change to the questions, thresholds or model version, and judge Laya (#128) against Jev.
- **Retire or keep the original picker?** That should be its own run of this harness on the four domains it still covers.
