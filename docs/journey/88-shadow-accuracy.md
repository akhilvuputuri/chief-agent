# 88 — Measuring Jev's accuracy, not only its fast path

Work date(s): 2026-10-14 to 2026-10-15. Written: 2026-10-15.
Status: released 15 October 2026 in the `1ec8c4d` deployment (package 0.3.77). Shadow records keep Jev's own routing pick, and shadow mode has its own switch. A private backfill on 16 October measured routing accuracy on 44 turns: Jev finds the right agent but over-routes turns Chief handles itself; no threshold tested raised precision on this sample, so the fast path stays off.

## User-visible problem and preceding iteration

[Journal 51](51-shadow-decisions.md) released shadow decisions on 1 October. They were meant to show whether Jev, a cheaper and faster decision model, would decide the way Chief does today; matching closely enough is the case for using it. After two weeks the owner asked for the verdict. The data could not give one for routing, and the picker check gave a clear but separate answer.

## Evidence

**Measured, 1–14 October 2026, sanitized CloudWatch `decision.shadow` lines, 14 daily windows.** No message text was read.

- **Coverage.** 38 foreground turns from 1 to 12 October, all shadowed. 15 picker-only turns in the window predate the release at 10:49 UTC on 1 October. No traffic on 2–4 October or after 12 October. 76 Jev calls, none failed or timed out, about 0.4–0.5 s each off the reply path, about $0.0025 in total.
- **Routing at threshold 0.97.** Jev proposed a fast path in 2 of 38 turns: one matched Chief's single delegation, one named a single agent where Chief used several. Chief itself delegated the whole turn to one agent in 16 of 38 turns (13 `daily`, 2 `calendar`, 1 `library`), the ceiling for any fast path.
- **Continuity at threshold 0.33.** 14 of 38 turns (37%) would have dropped the previous exchange. 12 of the 14 made no recall call in the real turn; 2 made one or two. 3 of the 24 kept turns made recall calls. Correctness needs a private review.
- **Picker.** The picker is awaited before the model call. `tools.picked` latency over the window: median 602 ms, p95 888 ms, one 1.5 s timeout in 60 picks. In 24 of 38 turns none of the offered domains was used, 3 turns were offered none, 11 used at least one; 2 turns loaded a domain mid-turn.

## Diagnosis and alternatives

- **Routing accuracy was not measurable.** Below the threshold the record stored `chief` and discarded Jev's own pick. Its `score` is the probability of whatever Jev chose, which may itself be `chief`, so scores cannot be compared across turns. `agree` counts every `chief` prediction as agreement, so it measures harm avoided at 0.97, not accuracy. 36 of 38 turns therefore said nothing about whether Jev picks the agent Chief picks.
- **Continuity has no automatic ground truth.** Chief always keeps the previous exchange, so every drop differs from current behaviour by construction. Whether a drop was harmless needs the reply judged privately; recall calls are a hint only.
- **Shadow mode was tied to the picker.** It followed `TOOL_PICKER` because both send the same kind of data to the same provider. Acting on the picker finding (turning the picker off) would also have stopped the measurement.

Alternatives considered:

- Lowering the routing threshold in production to collect more fast-path predictions. Rejected: it changes nothing else in the record, and the score alone cannot pick a threshold.
- Replaying past turns offline. Still useful for an immediate sample (owner-authorized private inspection), but it does not replace recording the pick on live turns.

## Implementation and review

- [src/shadow.ts](../../src/shadow.ts): routing predictions keep `choice` (Jev's own pick, before the threshold) and `probabilities` (Jev's probability for each offered candidate and `chief`, rounded to four places; any other key is dropped). Records are `version: 2` and add `choice`, `matched` (did Jev's own pick equal what Chief did; `several` never matches) and `probabilities`. The picker check adds `picker`: `jev` when Jev chose the first message's domains in that run, `cues` when the word cues did (picker off, failed, timed out or backing off). It is read from the run's `tools.picked` event, not the configured mode, so a failed pick is not counted as Jev's.
- Docs: stopping all message traffic to Jev now needs both `TOOL_PICKER=off` and `SHADOW_DECISIONS=off`; [configuration](../configuration.md), [shadow decisions](../shadow-decisions.md), [context management](../context-management.md) and `.env.example` say so, and the stale note that the picker switch needs a Compose rollout is corrected.
- [src/ops-log.ts](../../src/ops-log.ts): `decision.shadow` lines add `choice`, `matched` and, for the picker check, `picker`. Per-candidate probabilities stay in Postgres.
- [src/config.ts](../../src/config.ts), [config/runtime.json](../../config/runtime.json), [src/main.ts](../../src/main.ts): new behaviour setting `SHADOW_DECISIONS` (`jev` or `off`, default `jev`). Shadow mode runs when it is `jev` and an OpenRouter key is set, independent of `TOOL_PICKER`. Compose does not pass the name, so the file is authoritative in production.
- [scripts/cloudwatch-logs.mjs](../../scripts/cloudwatch-logs.mjs): the `decisions` summary also groups by `picker`, `choice` and `matched`.
- Tests: [tests/shadow.test.ts](../../tests/shadow.test.ts) covers the kept pick below the threshold, probability filtering and rounding, `matched` against `agree` for single, several, Chief-only, below-threshold and failed predictions, who chose the picker's domains, and the log projection. [scripts/cloudwatch-logs.test.mjs](../../scripts/cloudwatch-logs.test.mjs) asserts the `decisions` query grouping. [tests/runtime-config.test.ts](../../tests/runtime-config.test.ts) covers the new setting and its independence from `TOOL_PICKER`.
- **Independent review (Claude Opus 5.5) of `941d6a2`:** APPROVE, no blocking findings. Non-blocking findings, all fixed in the next revision:
  - turning `TOOL_PICKER` off no longer stops all traffic to Jev, and no doc said so;
  - `picker` recorded the configured mode, so a failed or timed-out pick counted as Jev's; it is now derived from the run;
  - tests did not cover a wrong pick below the threshold, a wrong pick on a several-agent turn, or the `decisions` query;
  - the query description in the design doc was stale.
- **Re-review of `ed0e710`:** APPROVE. One cosmetic note, added to the design doc: for messages longer than Jev sees, the cues are added to Jev's pick, so `jev` is approximate there.
- Main was then merged (journal index conflict only) and the package moved to 0.3.77. **Final-head re-review of `a81229e`:** APPROVE, no findings.
- **Devin Review** (on `941d6a2`, a second signal): the picker label followed the configured mode, fixed in `ed0e710`. It also noted that domains Jev picked in the previous hour stay held after the picker is switched off (existing behaviour, `src/agent.ts` held domains). Not changed here: the first hour of `cues` records after switching the picker off should be excluded from a picker comparison.

The data sent to TypeSafe and the per-message cost are unchanged. Turning the picker off is deliberately not part of this change.

## Verification and outcome

Tested: `npm run typecheck`, 935 application tests, 51 script tests (after the review fixes), the picker/context/decision eval unit tests, `check:pi`, build and format pass locally. Locally, the coding-benchmark fixture test fails identically on unchanged main, and `check:coding` cannot run without `ruff`; hosted CI runs both.

Not yet measured: routing accuracy. It needs released records with `choice`.

### Release closure — 2026-10-15

- [PR 234](https://github.com/akhilvuputuri/chief-agent/pull/234) merged as `fff41bb8cb67aab5cee587740ac7f7f8a980fe88` at the approved head `a81229e`, after hosted CI and Devin passed.
- Its own [release run](https://github.com/akhilvuputuri/chief-agent/actions/runs/38717317786) correctly refused to deploy: main had already moved to `1ec8c4d` (PR 236, docs only).
- The [release of `1ec8c4d1ffe8b506903c7b4dacfe93cffc6c63a7`](https://github.com/akhilvuputuri/chief-agent/actions/runs/38719275433), which contains this change, succeeded. `npm run release:status` reports the exact commit deployed with startup health at 10:22 UTC.
- Sanitized logs show `gateway.started` for that release at 10:21:54 UTC. Its `config.loaded` line does not list `SHADOW_DECISIONS` among environment overrides, so production reads `jev` from `config/runtime.json`.
- No `decision.shadow` line from the new release had appeared when this was recorded, so no `version: 2` record has been observed yet. First check: `npm run logs:cloudwatch -- decisions --since 24h` shows `choice` and `matched` on routing lines.
- No tag created.

## Routing backfill — 2026-10-16

**Measured, owner-authorized private inspection.** All 44 shadowed routing turns from 1 to 15 October: the 38 analysed above, 4 more `version: 1` turns from 13–15 October before the release, and 2 live `version: 2` turns were exported read-only from Postgres over the operator connection into an owner-only scratch file. Each turn's first message and earlier turns were rebuilt the way `recentTurns` builds them and replayed through the released `ShadowDecisions` routing question, which now keeps Jev's pick. 44 calls, none failed, $0.002 in total. The export was deleted after the analysis; only these aggregates are kept.

Limitations:

- The agent catalogue was rebuilt from today's descriptions, restricted by date to the agents that existed (11 types on 1 October, 14 from 5 October; `IBKR_PORTFOLIO` and `GATHERING_RUNTIME` are on in production). The catalogue offered at the time is not stored.
- Earlier turns come from stored conversation history and may differ slightly from what Jev saw live.
- **Replay fidelity:** the 2 live `version: 2` picks and the 2 earlier fast-path picks were reproduced. Scores were similar but not identical: the live `library` fast path (0.97, matched) replayed at 0.95, just under the threshold. So the 0.97 row below is sensitive to replay noise at a sample of one or two turns.
- 44 turns is a small sample.

**Measurement fix in the analysis.** The shadow record calls a turn `several` whenever Chief made more than one delegation, even when every call went to the same agent. Counting repeated calls to one agent as that agent moves one turn from `several` to `daily` and one to `web`. The figures below use the corrected count; `src/shadow.ts` still records the uncorrected one.

| What Chief did         | Turns | Jev's own pick                                                                 |
| ---------------------- | ----- | ------------------------------------------------------------------------------ |
| Delegated to one agent | 18    | the same agent 16, `chief` 2, never a wrong agent                              |
| Answered itself        | 23    | `chief` 13; an agent 10 (`daily` 4, `web` 2, `calendar` 2, `news` 1, `jobs` 1) |
| Used several agents    | 3     | a single agent 2, `chief` 1                                                    |

Overall, Jev's pick matched Chief on 29 of 44 turns.

Fast path at a threshold, i.e. Jev picks an agent with at least this probability (uncorrected `several`; the correction changes each row by at most one turn):

| Threshold | Fast-path turns | Matched Chief |
| --------- | --------------- | ------------- |
| any       | 28 (64%)        | 15 (54%)      |
| 0.7       | 18 (41%)        | 13 (72%)      |
| 0.9       | 7 (16%)         | 5 (71%)       |
| 0.97      | 1 (2%)          | 0             |

Higher thresholds remove good and bad routes at about the same rate. Requiring continuity to say the message stands alone (score below 0.33 or 0.5) also did not raise precision: it blocked good routes as often as bad ones, and scored some context-dependent follow-ups as standalone.

**Private review of the 13 wrong agent picks** (categories only). These are the turns where Jev picked an agent that did not match Chief, using the uncorrected record: the "any" row below, 28 agent picks minus 15 matches. With the corrected count there are 15 mismatches: these 13, less the repeated-`daily` turn (which then matches), plus 3 `chief` picks: 2 on single-agent turns and 1 on a several-agent turn. A `chief` pick means no fast path, so those 3 were not reviewed.

- **Would have worked (3):** a quick public lookup that Chief split across web and research; the repeated-`daily` turn above; one borderline lookup that ignored an earlier answer in the conversation.
- **Capabilities only Chief has (6):** saving links to Reader and coding-job requests. No agent covers them, and Jev picked `daily`, `news`, `web` or `jobs`.
- **Context-dependent follow-ups (3):** short replies that only make sense with the previous exchange. Agents cannot see the conversation.
- **Partial (1):** an image plus a web task where Jev picked only the media agent.

**Conclusion (measured on this sample):** Jev is good at "which agent" and poor at "does this need an agent at all". The fast path should stay off. The likely lever is the `chief` criterion in `config/decisions.json`: it does not mention Reader saves, coding jobs or short follow-ups to the previous exchange (it mentions "earlier conversations", which is about recalling past conversations), and those cover 9 of the 13 wrong picks. That is a hypothesis; tuning the wording on these same 44 turns would overfit, so it needs fresh turns or a held-out set.

## Follow-up and next iteration

- **Accuracy report.** Live records now carry `choice`; repeat the threshold table on new turns.
- **Backfill.** Done on 16 October; see above.
- **`several` counting.** Record repeated delegations to one agent as that agent in `src/shadow.ts`.
- **`chief` criterion.** Revise the routing description to cover Reader saves, coding jobs and conversation follow-ups, then measure it on turns it was not tuned on.
- **Picker.** Trial `TOOL_PICKER=off` in `config/runtime.json` now that shadow mode no longer depends on it; compare reply latency and mid-turn loads.
- **Continuity.** Privately review the would-be drops, starting with the two that made recall calls.
