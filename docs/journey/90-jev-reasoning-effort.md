# 90 — Reasoning effort chosen per message, raised as the turn grows

Work date(s): 2026-10-17. Written: 2026-10-17.
Status: released 17 October 2026 as `be3647e` (package 0.3.82). Jev picks the main model's reasoning effort per foreground message and can raise it mid-turn. Not yet measured on real messages.

## User-visible problem and preceding iteration

Every foreground message ran the main model at `medium` reasoning (`AGENT_REASONING_EFFORT`, fixed). A thank-you got the same reasoning as a multi-step plan, and a turn that turned out harder after a few failed tool calls could not think harder.

[Journal 88](88-shadow-accuracy.md) found Jev not yet safe for routing. While reviewing where else a cheap decision model fits, the owner chose reasoning effort: a wrong pick costs some quality or some tokens, not a wrong action. The owner asked for the switches to be logged, especially when Jev raises effort as a turn grows.

## Evidence

- **Tested only.** Mocked Jev and model transports, no production measurement yet.
- **Hypothesis:** `low` on simple messages shortens replies' reasoning time and lowers token cost, and `high` on hard turns improves them. Neither is measured.

## Diagnosis and alternatives

- **Jev choice question (chosen).** One question with three criteria, the same API and state as the tool picker. Thresholds keep `medium` unless Jev is fairly sure: 0.7 for `low`, 0.6 for `high`.
- **Folding the question into the tool picker's call.** Zero added latency. Rejected because the picker is the next candidate to turn off ([journal 88](88-shadow-accuracy.md)), and effort should not depend on it.
- **A word or length rule.** Rejected: length does not separate "thanks" from a short but hard request.
- **Letting the main model choose its own effort.** Not possible: effort is set per call, before the model sees the message.
- **Escalation.** Only upward, starting from model step 3, then every 3 steps, and after a new failed tool call. Asked while the step's tools run, so it rarely delays the next call. Lowering effort mid-turn was rejected: a turn that has needed several steps rarely becomes simpler.

## Implementation and review

- [src/effort.ts](../../src/effort.ts): `EffortPicker.decide` and the pure `shouldEscalate` policy.
  - Any HTTP error, timeout, invalid answer or exception keeps the current effort (`medium` at the start) and never throws.
  - Probabilities are kept only for the three efforts and rounded.
- [config/reasoning-effort.json](../../config/reasoning-effort.json): the question, criteria, thresholds and escalation schedule.
- [src/agent.ts](../../src/agent.ts): foreground turns start the decision alongside the tool picker and set `request.effort`.
  - An `escalateEffort` callback applies the policy, asks Jev with `turn_progress` and records each decision as `effort.decided`.
  - Background turns, responsibility investigations and child agents are unchanged.
- [src/custom-agent.ts](../../src/custom-agent.ts): effort is mutable within a turn. The loop counts tool calls, failed calls and distinct tool names, starts the escalation when the model requests tools, and applies a higher answer before the next model call.
  - `model.started` and `model.completed` record the effort of each call.
- [src/ops-log.ts](../../src/ops-log.ts): `effort.decided` lines (`kind`, `step`, `state`, `previousEffort`, `choice`, `score`, latency, cost) and `effort` on `model.completed`. No message text.
- [src/config.ts](../../src/config.ts), [config/runtime.json](../../config/runtime.json), [src/main.ts](../../src/main.ts): `EFFORT_PICKER` (`jev` default, or `off`). Compose does not pass it, so the file is authoritative.
- Tests: [tests/effort.test.ts](../../tests/effort.test.ts) covers:
  - thresholds, rounding and bounded state;
  - escalation progress and never lowering;
  - every failure path;
  - the escalation schedule;
  - a full foreground turn: starts `low`, escalates to `high` at step 3, stops asking once `high`, per-call effort recorded, log lines without text;
  - no picker meaning `medium`;
  - the log projection.
- [tests/runtime-config.test.ts](../../tests/runtime-config.test.ts) covers the new setting.
- Design: [reasoning effort](../reasoning-effort.md).
- **Independent review (Claude Opus 5.5) of `a768835`:** REQUEST CHANGES.
  - **Blocking, an outage:** the production image did not copy `config/reasoning-effort.json`, so the gateway would have failed to start on release.
    - Fixed in the Dockerfile.
    - `tests/dockerfile-config.test.ts` now checks that every config file under `src` is copied; it fails without the fix.
    - An unreadable effort config now disables the feature with `effort.config_failed` instead of stopping the gateway.
  - **Blocking, a late raise:** escalation after a failed tool call came one model call late, or never, because progress was captured before that step's tools ran. A failure now asks again when the step's tools finish, merged with any earlier answer. A full-turn test shows the recovering call runs raised.
  - **Non-blocking, all addressed:**
    - no question on a step that only finishes the turn;
    - a code comment overstated "never delays";
    - the counter rules are now documented;
    - follow-ups absorbed mid-turn are documented. They already reach Jev, because the escalation reads the request's current message.
- **Re-review of `c2d0a69`:** APPROVE.
- **Devin Review** of `c2d0a69` (a second signal):
  - It confirmed the startup fix.
  - It found that a follow-up absorbed mid-turn kept the first message's effort: a `low` "thanks" that absorbs a planning request stayed `low` until step 3.
  - **Fix:** absorbing a follow-up now asks Jev before the next model call. A full-turn test fails without it.
  - **Final-head re-review of `c5e5994`** (fix plus a merge of main): APPROVE.
  - Non-blocking note: a follow-up question sends the pre-turn history, not the message the turn started with. It is left for a later change.

## Verification and outcome

Tested locally after the review fixes: typecheck, 962 application tests, 51 script tests, the picker/context/decision eval tests, `check:pi`, build and format pass. `check:coding` needs `ruff`, which is not installed locally; hosted CI runs it. Not yet measured: the distribution of efforts on real messages, how often turns escalate and at which step, added latency with and without the picker, and any change in reply quality or cost.

### Release closure — 2026-10-17

- [PR 246](https://github.com/akhilvuputuri/chief-agent/pull/246) merged as `be3647e85dcac9de6b5d1b303ffef9ed1139b6dd` at the approved head `c5e5994`, after hosted CI and Devin passed.
- The [release run](https://github.com/akhilvuputuri/chief-agent/actions/runs/39027476521) succeeded. `npm run release:status` reports the exact commit deployed with startup health at 11:11 UTC.
- Sanitized logs show `gateway.started` for that release at 11:11:02 UTC, no `effort.config_failed` and no warn/error lines in the following 30 minutes. This is evidence that the image now carries `config/reasoning-effort.json`.
- No `effort.decided` line had appeared when this was recorded, so no live decision has been observed yet. First check: `npm run logs:cloudwatch -- event --event effort.decided --since 24h`.
- No tag created.

## Follow-up and next iteration

- After a week of use, report:
  - the applied-effort distribution;
  - escalation rate and step;
  - Jev latency on the critical path;
  - main-model reasoning tokens per effort.
- Check `low` turns that the owner corrected or that needed a retry.
- Tune thresholds or the schedule in the config file if `low` is too eager or escalations come too late.
- Include the turn's own first message in follow-up questions (review note on `c5e5994`).
