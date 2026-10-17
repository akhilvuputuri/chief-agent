# Reasoning effort per message

Chief's main model runs every foreground message at one reasoning effort. Before this change that was always `medium`. Now TypeSafe's Jev decision model picks `low`, `medium` or `high` for each foreground message, and can raise it while a turn grows. See [journal 90](journey/90-jev-reasoning-effort.md).

## How it decides

- **At the start of a message.** [src/effort.ts](../src/effort.ts) asks Jev one choice question. It sends the latest message (first 2,000 characters) and the last two turns (500 and 300 characters), the same state as the tool picker. The question and the three criteria live in [config/reasoning-effort.json](../config/reasoning-effort.json).
- **Applying the pick.**
  - Jev's `low` applies only at probability 0.7 or above.
  - Its `high` applies at 0.6 or above.
  - Anything else, or any failure, is `medium`, the earlier fixed effort.
- **As the turn grows.**
  - When the model asks for tools, Jev is asked again, starting at model step 3 and then every 3 steps, and at once after a new failed tool call.
  - The escalation adds `turn_progress`: steps, tool calls, failed tool calls, distinct tool names and the current effort. It never sends arguments or results.
  - A scheduled question is asked when the step's tools start; a question after a failure is asked when that step's tools finish, so the call that recovers already uses its answer. The answer applies from the next model call.
  - Effort only rises within a turn, and once it is `high` Jev is not asked again. A step that only calls `finish_turn` asks nothing, since no model call follows.
  - Counts: `tool_calls` and `tools_used` count every requested call except `finish_turn`, including ones later refused. `failed_tool_calls` counts calls that ended failed, including validation errors and repeated-failure refusals. Calls skipped because newer input arrived are not failures.
  - A follow-up absorbed mid-turn replaces the message Jev sees from the next question on. It does not trigger a question of its own.
- **Scope.**
  - Foreground messages only.
  - Background jobs, responsibility investigations and child agents keep their own effort: `medium`, or what Chief passes to `agent_run`.

## Latency and cost

- **Start of a message.** The first question starts when the turn's earlier turns are known and is awaited only after the request is built. It runs alongside the tool picker's call (median about 0.6 s), so it adds little while the picker is on. With the picker off, it can add up to its 1.5 s timeout, typically about 0.45 s.
- **Escalation.** Scheduled questions run while the step's tools execute, so they delay the next model call only when the tools finish first. A question after a failed tool call starts when the tools finish, so it delays the recovering call by Jev's latency (typically about 0.45 s, at most the 1.5 s timeout).
- **Cost.** Each question costs about $0.00002–0.00004, recorded in the run's provider charges.
- **Model price.** `high` costs more main-model reasoning tokens than `medium`; `low` costs fewer. No dollar cap is added.

## Startup

If `config/reasoning-effort.json` cannot be read, the gateway logs `effort.config_failed` and runs without the effort picker (every turn `medium`) instead of failing to start. The production image copies the file. A test checks that every config file the gateway reads is copied into the image.

## Switch

`EFFORT_PICKER` in [config/runtime.json](../config/runtime.json): `jev` (default) or `off`. Production Compose does not pass the name, so the file is authoritative and a change takes effect on the next release. `off` keeps every turn at `medium`. Stopping all message traffic to Jev also needs `TOOL_PICKER=off` and `SHADOW_DECISIONS=off`.

## Reading the logs

- `effort.decided`, one line per decision:
  - `kind` is `initial` or `escalation`;
  - `step` is the model step it was asked at (0 for the start);
  - `state` is the effort applied;
  - `previousEffort` is the effort before an escalation;
  - `choice` and `score` are Jev's own pick and its probability;
  - also `latencyMs`, `costUsd`, `model` and `errorCode`.
- `model.completed` lines carry `effort`, so each call shows the effort it ran at. The `model.started` event in Postgres records it too.
- Private detail: `events` rows of type `effort.decided` also hold Jev's probability for each effort.

Example: how often each effort was applied, and how often a turn escalated.

```sh
AWS_PROFILE=chief-logs npm run logs:cloudwatch -- event --event effort.decided --since 24h
```

## What would change the policy

- Replies at `low` that the owner corrects, or that need a second attempt.
- Escalations that arrive too late to help.
- Turns that end at `medium` after a failed tool call.

Thresholds and the escalation schedule are in the config file, so tuning them is a reviewed config change.
