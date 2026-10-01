# Shadow decisions

Shadow mode lets Chief try a decision model on real messages without changing anything the owner sees. For each foreground message, the host asks Jev what it would decide, in parallel with the turn, and records the prediction next to what actually happened. It is the live counterpart of the offline [decision evals](../evals/decisions/README.md) for [issue #127](https://github.com/akhilvuputuri/chief-agent/issues/127) ([journal 50](journey/50-decision-evals.md), [journal 51](journey/51-shadow-decisions.md)).

## What is shadowed

| Consumer     | Question                                                                                    | Would-be action                                    | What it is compared with                                                                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `continuity` | Does the latest message need the previous exchange? (Jev Noul)                              | `drop` below the threshold, else `keep`            | Today Chief always keeps it. The record also counts the turn's recall calls (`conversation_read`, `conversation_search`, `observation_read`). A private review joins on the run ID to see whether the reply relied on the previous exchange.                                                                  |
| `routing`    | Can one agent handle all of the message? (Jev Choice over the agent catalogue plus `chief`) | the agent, at or above the threshold, else `chief` | The agent types of the `agent_run` calls that actually ran in the turn, normalised to catalogue names (`core/email` counts as `email`). Refused, failed and never-dispatched calls are excluded. `agree` is true when the fast path would have matched Chief's own single delegation, or would have deferred. |
| `picker`     | No model call                                                                               | –                                                  | The optional domains the turn offered, the ones it used, and any loaded mid-turn. This shows whether the tool picker still earns its latency now that most tools live in agents.                                                                                                                              |

## Guarantees

- **No effect on the turn.**
  - The calls start once the turn's tools are chosen and run in parallel with the model.
  - Nothing awaits them, every failure is swallowed, and the record is written after the reply.
  - Background jobs are not shadowed.
  - One visible side effect: shadow charges are recorded in the run's provider charges, so they appear in the turn's cost usage and the Telegram usage view. A timed-out call stays at its $0.001 estimate.
- **Turns marked for analysis.** Predictions see only the turn's first message. Each record therefore says whether the turn was interrupted, its stop reason and how many messages it absorbed, so analysis can exclude turns where what happened no longer matches what Jev saw.
- **Same questions as the eval.** The questions, thresholds and model come from `config/decisions.json`, which the offline eval reads too, so live and offline numbers compare like for like. The thresholds are the ones tuned in journal 50: continuity 0.33 and routing 0.97.
- **What is sent to TypeSafe** (through OpenRouter, the same path as the tool picker):
  - the latest message (first 2,000 characters);
  - the previous user message (500) and reply (600) for continuity;
  - the last two turns (500 and 300) for routing;
  - the agent descriptions.

  Nothing from tool results, email or memories is sent.

- **Cost.** Two Jev calls per foreground message, about $0.00003 each. The charge is recorded in the turn's provider charges.

## Switches

Shadow mode follows the tool picker's switch. It runs only when `TOOL_PICKER=jev` (the default) and `OPENROUTER_API_KEY` is set, because it sends the same kind of data to the same provider. Setting `TOOL_PICKER=off` in the server environment stops both. Individual consumers are switched with `shadow.continuity`, `shadow.routing` and `shadow.picker` in `config/decisions.json`, which takes a release.

## Reading the data

- **Operational log (no message text):**

  ```sh
  npm run logs:cloudwatch -- decisions --since 24h
  ```

  This groups `decision.shadow` lines by consumer, prediction, actual agent and agreement, with average score, latency, cost, unused domains and mid-turn loads.

- **Private detail:** `events` rows of type `decision.shadow` in Postgres hold the full record: prediction, score, threshold, actual, delegated agent types, recall count, latency, cost and model.

## Interpreting

- **Routing.**
  - A prediction that names an agent Chief did not delegate to is a would-be wrong route.
  - A prediction of `chief` is never wrong; it only means no fast path.
  - Precision of the would-be routes is the number to watch before enabling the fast path.
- **Continuity.** Agreement cannot be read automatically, because Chief always keeps the context. Review a sample of would-be drops privately: did the reply use the previous exchange? A turn that called the recall tools is a hint, not proof.
- **Picker.** Many turns with unused offered domains and few mid-turn loads mean the picker adds latency for little.
