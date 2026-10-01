# 50 — Where small decision models pay off: a paired eval harness for issue #127

Work date(s): 2026-10-01. Written/revised: 2026-10-01.
Status: measured offline on synthetic fixtures. Nothing in the runtime has changed.

## User-visible problem and preceding iteration

[Issue #127](https://github.com/akhilvuputuri/chief-agent/issues/127) proposed trying small decision models (Jev) at more selection points in Chief. The owner's aim is to engineer and measure fractional gains, and they need statistics that hold up. Chief has one user and about 10 decisions a day, so production traffic alone cannot produce a defensible comparison. [Journal 37](37-jev-tool-picker.md) built the first Jev consumer, the tool-domain picker. [Journal 49](49-coordinator-agents.md) then moved domain tools into agents, which leaves that picker four small domains to choose from. This entry measures two new decisions instead.

## Evidence

**Measured, offline, 1 October 2026.**

- **Models:** `typesafe/jev-1.13-20260917` and `google/gemini-3.8-flash` (low reasoning), both through OpenRouter.
- **One call per message, as in production.** Each call is scored on its own. Every case ran three times to add samples and show the spread between runs.
- **Thresholds** were tuned on tuning calls only, under a safety bar of 100% (no wrong drops or wrong routes on tuning).
- **Intervals** resample whole conversations (continuity) or whole cases (routing). When there were no failures, a Wilson interval over those clusters is used instead.
- **Reports:** `evals/decisions/results/continuity-20261001-1126.json` and `routing-20261001-1134.json`, with every call, the git revision and a hash of the harness.

### Decision 1: does the latest message need the previous exchange?

Chief always sends the previous exchange today. Dropping it for a standalone message saves its characters, but dropping it for a follow-up loses context. Data: 96 held-out cases (48 follow-ups, 48 standalone) from 16 conversations not used for tuning, giving 288 calls per paid backend. Standalone messages come from a separate pool per split, so no message is in both, and 78 of the 96 held-out messages are unique.

| Backend          | Recall on follow-ups (95% CI) | Standalone dropped (95% CI) | Characters saved per message (95% CI) | Share of a typical request | Mean / p95       | $ per 1,000 |
| ---------------- | ----------------------------- | --------------------------- | ------------------------------------- | -------------------------- | ---------------- | ----------- |
| Keep (today)     | 100% (80.6–100)               | 0%                          | 0                                     | 0%                         | –                | 0           |
| Rule (word cues) | **79.2%** (64.6–91.7)         | 83.3% (70.8–93.8)           | 1,629 (1,197–2,081)                   | 3.0%                       | –                | 0           |
| **Jev**          | **100%** (80.6–100)           | 89.6% (81.2–95.8)           | 1,983 (1,307–2,829)                   | 3.6%                       | **343 / 459 ms** | **$0.020**  |
| Flash            | 100% (80.6–100)               | 93.1% (86.8–98.6)           | 2,016 (1,350–2,849)                   | 3.7%                       | 2,212 / 4,036 ms | $0.271      |

- **Run to run:** Jev's recall was 100% in all three runs, and its drop rate was 89.6% in each.
- **Differences between backends** (exact McNemar on per-case majority correctness):
  - Jev versus keep: p = 2.3 × 10⁻¹³.
  - Jev versus rule: p = 0.011.
  - Jev versus Flash: p = 0.5, with 0 against 2 discordant cases.
- **Where Jev was wrong:** every standalone message it kept was a same-domain new topic, such as "add TSLA with a 6% alert" right after a watchlist question.
- **Sensitivity.** Jev's threshold (0.33) is set by one tuning label, "great, can you remind me to check my account next friday" (p = 0.34), which is arguably debatable. Without that label the threshold rises to 0.70, and held-out recall falls to **97.9%** (one lost follow-up). Flash is more fragile: 93.8%. The lowest held-out follow-up probability for Jev is 0.42, so there is a margin of 0.09 above the threshold.
- **Intervals:** the 80.6% lower bound on recall reflects only 16 independent conversations, even though no follow-up was lost.

### Decision 2: fast-path routing to one agent

After #129, every domain request costs a coordinator model call whose only job is to call `agent_run`. A confident decision could start the agent directly. Data: 76 held-out messages (the picker scenarios relabelled for the post-#129 agents), of which 50 could be routed to one agent. That gives 228 single calls per paid backend.

| Backend              | Threshold | Routed calls (wrong) | Precision (95% CI)  | Coverage of routable (95% CI) | Coordinator calls saved per 100 messages (95% CI) | Net time per message | Net $ per 1,000 messages | Mean / p95       |
| -------------------- | --------- | -------------------- | ------------------- | ----------------------------- | ------------------------------------------------- | -------------------- | ------------------------ | ---------------- |
| Chief (today)        | –         | 0                    | –                   | 0%                            | 0                                                 | 0                    | 0                        | –                |
| Production word cues | –         | 28 (**12**)          | 57.1% (39.3–75.0)   | 32.0%                         | 21.1                                              | –                    | –                        | –                |
| **Jev**              | 0.97      | 52 (**0**)           | **100%** (82.4–100) | 34.7% (22.0–48.0)             | **22.8** (14.0–32.9)                              | **611 ms saved**     | **$4.71 saved**          | 347 / 449 ms     |
| Flash                | 0.98      | 25 (0)               | 100% (74.1–100)     | 16.7% (8.0–26.7)              | 11.0 (5.3–18.0)                                   | 1,701 ms added       | $1.79 saved              | 2,162 / 3,277 ms |

- **Run to run:** Jev's precision was 100% in each of the three runs, which routed 17, 18 and 17 held-out cases.
- **Differences between backends** (exact McNemar on per-case majority of correct fast paths):
  - Jev versus Chief: p = 7.6 × 10⁻⁶.
  - Jev versus Flash: p = 0.023, with 11 against 2 discordant cases.
- **Net time and cost.** A saved call is valued at the mean of all main-model calls (4.2 s and $0.0208, from the `model.completed` log, 25–30 September, n = 203, before #129). Jev's own mean latency and cost are then subtracted from every message. A coordinator call that only calls `agent_run` is probably shorter, so these savings are upper estimates.
- **Thin margin.** On tuning, single calls at 0.96 made 3 wrong routes out of 118; 0.97 is the lowest threshold with none (0 of 106).

## Diagnosis and alternatives

- **Jev suits both decisions.** It matched a small LLM on continuity and routed twice as many messages correctly, at about a sixth of the latency and a tenth of the cost or less.
  - For routing, Jev's ~0.35 s cost is paid back: on these fixtures it saves a coordinator call on about a quarter of messages.
  - For continuity, the gain is characters, not time. Jev adds ~0.35 s to every message unless it runs alongside context assembly, which is how it should be wired.
  - How often each case occurs in real use is not measured. The fixture mixes are a design choice.
- **Rules alone are not safe here.** They are fast, but the word cues lost follow-ups (79% recall) and misrouted 43% of their routes. Rules remain the fallback when Jev is unavailable, not the primary decision.
- **Flash is the wrong tool for a per-message gate.** It is accurate but around 2 s per call. Its confidences are coarse: 349 of its 543 routing answers say exactly 0.95, so tuning had to require 0.98 to stay safe. Gemini also rate-limited the eval; 429s were retried with backoff so they did not count as errors.
- **What these numbers do not show.**
  - Whether answers improve.
  - How Jev behaves on real, rather than written, messages.

  A dropped previous exchange is still reachable through the exchange index and `conversation_read`, and a fast-path route still ends with Chief writing the reply. Shadow mode will measure real traffic.

## Implementation and review

- `evals/decisions/`:
  - `run.py` is the paired runner. It tunes on one split and reports on the other; `--rescore <report>` re-scores saved calls without new requests.
  - `stats.py` has the Wilson, bootstrap, cluster bootstrap, McNemar and percentile functions.
  - `scoring.py` holds the shared per-call helpers.
  - `backends.py` is the Jev decisions client and the Flash JSON client, with retries on 429 only.
  - `continuity.py` and `routing.py` are the two decisions, each with its own scoring.
  - `cues.ts` runs the production word cues for the routing rule.
  - `fixtures/gen_*.py` build the fixtures.
  - `test_decisions.py` has 15 offline tests and runs in `npm test`.
  - `README.md` documents the method and its limits.
- Command: `npm run eval:decisions -- <decision>`. Paid; both full runs together cost under $2.
- **Independent review (Opus 5.5, first revision) requested changes.** The arithmetic matched the records, but:
  - routing's "0 wrong routes" depended on requiring three calls to agree, while savings assumed one call;
  - continuity's threshold rested on one label;
  - held-out standalone messages repeated tuning ones, and intervals ignored clustering;
  - some fixture rates were presented as traffic.
- **Fixes:**
  - every call is scored on its own;
  - failures take the safe path;
  - routing ties go to the conservative threshold, with candidates from tuning only;
  - each split has its own standalone pool;
  - intervals resample conversations, with a Wilson-over-clusters fallback;
  - the report shows margins and sensitivity, an unknown cost is never shown as zero, and each report carries a harness hash;
  - the claims are reworded.

  Both decisions were rerun, and the earlier reports are replaced.

- Independent review of the revision: pending.

## Follow-up and next iteration

- **Wire both decisions into the runtime in shadow mode.** Log Jev's would-be decision next to today's behaviour, without changing what Chief sends. Then enable each behind a switch: continuity first, running Jev alongside context assembly; then fast-path routing.
- **Keep the measurement going.** The same fixtures will judge any change to the questions, thresholds or model version, and judge Laya (#128) against Jev.
- **Retire or keep the original picker?** That should be its own run of this harness on the four domains it still covers.
