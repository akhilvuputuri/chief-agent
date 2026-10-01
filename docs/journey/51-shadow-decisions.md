# 51 — Shadow decisions: Jev on real messages, with no effect on the reply

Work date(s): 2026-10-01. Written/revised: 2026-10-01.
Status: released `d434bc7` on 1 October 2026. Tested with mocked transports; production data is accumulating.

## User-visible problem and preceding iteration

[Journal 50](50-decision-evals.md) measured Jev offline on two decisions using developer-written cases. The owner asked to add shadow mode wherever it does not affect behaviour, so real use produces comparison data. That is the blind check for the offline labels, and it gives real-traffic rates. Memory relevance is deferred by the owner's choice. Email triage is left for an owned model (#128), because it would send mail content to a third party.

## Evidence

- **Tested only.** `tests/shadow.test.ts` covers:
  - the exact question, state shape and thresholds sent to Jev;
  - every failure (HTTP error, invalid answer, network, timeout) resolving as a failed prediction;
  - a turn that completes while Jev is still blocked, with the record written only after release;
  - the record's join with what Chief did: a single delegation, a full agent ID normalised to its alias, several delegations, refused and never-dispatched calls excluded, and an interrupted turn marked;
  - the picker row's offered, used, unused and loaded-later domains;
  - a log line without message text.
- `npm test` passes 536 TypeScript tests, 21 context-eval tests and 15 decision-eval tests.
- No production numbers yet.

## Diagnosis and alternatives

- **Chosen: start after tool selection, record after the reply, never await.**
  - Starting at message receipt would race the history load. Starting after the turn would add Jev's latency to nothing useful.
  - Recording after the reply lets the record include what Chief actually did.
- **Chosen: two Jev requests, not one combined request.**
  - Each uses exactly the eval's state shape. A combined state would show Jev different inputs and weaken the comparison with journal 50.
  - Both run in parallel and cost about $0.00003 each.
- **Chosen: questions and thresholds in `config/decisions.json`, read by both the runtime and the eval.** They cannot drift apart.
- **Chosen: the picker check needs no model.** It compares the domains offered with the domains used, from events and calls the turn already records.

## Implementation and review

- `src/shadow.ts`:
  - `ShadowDecisions.start` sends the two Jev requests;
  - `record` joins them with the turn's `agent_run` types and recall-tool count;
  - `recordPickerCheck` covers the picker.
- `src/agent.ts` starts shadow calls for foreground turns and records them after `turn.responded`, without awaiting. `src/main.ts` enables shadow mode when `OPENROUTER_API_KEY` is set.
- `config/decisions.json` holds the shared questions and thresholds, and is copied into the image by the `Dockerfile`. The eval (`evals/decisions/continuity.py` and `routing.py`) now reads the same file.
- **Logs.** `src/ops-log.ts` projects `decision.shadow` with consumer, prediction, actual agent, score, agreement, latency, cost and, for the picker, domain counts; no message text. `scripts/cloudwatch-logs.mjs` adds a `decisions` query.
- **Docs.** [Shadow decisions](../shadow-decisions.md) is the runbook. `docs/operational-logs.md` has a new row.
- **Independent review (Opus 5.5, first revision) requested changes.** It confirmed the turn is unaffected (every path is caught and nothing is awaited) and that the questions, state shapes, thresholds and catalogue match the eval. The data had gaps:
  - delegations that never ran were counted;
  - full agent IDs caused false disagreements;
  - interrupted turns and turns with several messages were not marked;
  - continuity log lines had no outcome;
  - there was no runtime switch;
  - the join was untested;
  - three doc statements were inaccurate.
- **Fixes:**
  - only successful `agent_run` calls count, normalised through the registry aliases;
  - records carry `interrupted`, `stopReason` and `messages`;
  - continuity logs `recalled` instead of a meaningless actual;
  - shadow mode follows the `TOOL_PICKER` switch;
  - join tests are added;
  - the docs are corrected, including the cost side effect.
- Independent review of the fixes: pending.

## Follow-up and next iteration

- **After about one to two weeks of normal use:**
  - routing: the precision of would-be routes against Chief's own delegations;
  - continuity: the share of would-be drops, and a private review of a sample;
  - picker: unused offered domains against mid-turn loads.
- **Then** enable continuity first, behind a switch, and fast-path routing after it.
- **News relevance** is the next shadow consumer: rank bulletin items with Jev and compare with the owner's 👍/👎.
