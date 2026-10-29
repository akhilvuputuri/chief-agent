# 133 — Can Chief tell which answers missed without the owner rating them?

Work date: 2026-10-29 (Singapore). Written: 2026-10-29.
Status: released in `bc4c5c0`. When trace export is on, the owner's next message after a turn becomes a `user_redirected` score on that turn's trace. Production sets no endpoint, so nothing leaves the host there.

## User-visible problem and preceding iteration

Issue #323 phase 4 planned answer-quality scores from Telegram 👍/👎 reactions ([journal 131](131-otel-trace-export.md#follow-up-and-next-iteration)). The owner declined (reported, 29 October): they use Chief as a user and will not rate or classify answers. When an answer misses, they say "try again" or "do something else", correct it, or ask again in other words. Those messages are the signal, and nothing has to change in how the owner talks to Chief.

Chief already detects part of this. The nightly learner ([journal 130](130-nightly-learner.md)) marks a turn `pitfall` when the owner's next message within six hours is a correction (`isCorrection` in `learning.ts`). That runs once a night, only for turns at least a day old, and writes to `learning_reviews`, so it never reaches a trace viewer, and it has no notion of "do something else" or a rephrase.

## Evidence

- Tested: [tests/turn-feedback.test.ts](../../tests/turn-feedback.test.ts) covers:
  - retry phrases;
  - corrections, including acknowledgements ("No worries") and a plain "no" answering a reply that asked a question;
  - a rephrase against a same-subject follow-up that must not count;
  - attached quotes and forwards being ignored.
- Tested: [tests/otel.test.ts](../../tests/otel.test.ts) drives real `Execution` runs on PGlite and checks:
  - the evaluation names the earlier turn's trace ID and root span ID;
  - only the first message after a turn counts;
  - child runs, unknown runs and turns older than six hours are not scored;
  - a label outside the fixed shape is dropped;
  - the root span carries `gen_ai.conversation.id`;
  - nothing is sent without a logs endpoint.
- Measured on a laptop, synthetic: three runs exported with real `fetch` to agentwatch (`11921b4`).
  - The turn followed by "try again" received `user_redirected` = 1 with label `retry`.
  - The turn followed by "thanks, that's great" received 0.
  - The last turn, never answered, received no score.
  - All three appeared in one session, `thread.0`.
- Not measured: how often each rule fires on the owner's real messages, or how often it is wrong. The rephrase threshold (60% shared content words, at least four each) is a guess checked only against the test cases.

## Diagnosis and alternatives

- **Text patterns, no model.** Every foreground turn already pays for two Jev decisions (effort and tools). A third question there ("does this redirect the previous answer?") would probably catch rephrases better, but it adds a paid call per message, and no measurement yet says the patterns are not good enough. Reusing `isCorrection` keeps one definition of a correction for the learner and for telemetry.
- **A score on the earlier turn, not on the current one.** The redirect says something about the answer it follows. `gen_ai.evaluation.result` log records name a trace and span, which is how the GenAI conventions attach an evaluation to finished work, and agentwatch already stores them as scores.
- **Which earlier turn.** Telegram's reply target when the owner used it, otherwise the last delivered exchange in the same thread. Both come from `conversationState`, which every foreground turn already computes, so detection adds no query.
- **`false` as well as `true`.** Recording "answered and not redirected" gives the redirect rate a denominator. Turns the owner never answered get nothing, since silence is not approval.
- **In memory, not in Postgres.** The exporter remembers the last 200 finished root runs. A restart loses them, so the first message after a restart scores nothing. That avoids a migration for telemetry that is off in production.

## Implementation and review

- [src/turn-feedback.ts](../../src/turn-feedback.ts): `redirectOf` and `isRephrase`.
- [src/otel.ts](../../src/otel.ts):
  - `turnFeedback` and `runConversation`;
  - an evaluation queue in `OtlpExporter`, sent to the logs endpoint after the queued spans;
  - `encodeEvaluations` and `logsEndpoint`.
- [src/agent.ts](../../src/agent.ts): calls both hooks right after `conversationState`.
- [src/main.ts](../../src/main.ts): resolves the logs endpoint. If only that endpoint is invalid, spans still export and only feedback is off (`OTEL_LOGS_ENDPOINT_INVALID`).
- Design: [tracing](../tracing.md#implicit-feedback).

Independent review (Opus 5.5) of `275997e` found nothing blocking. Its should-fix findings were corrected in the next commit, with each counterexample added as a test:

- **Retry fired on ordinary requests.** "add another one for Tuesday", "what other options do I have…", "I want to build it from scratch" and "do it again next week" all counted as retries, so the redirect rate would have read high. Now:
  - a retry must open the message;
  - "another one" and "again" count only as a short message;
  - a time or extension word ("next week", "too") rules a retry out;
  - "from scratch" was dropped;
  - "retry", "regenerate" and "try once more" were added.
- **A one-word change counted as a rephrase.** "…Hyderabad tomorrow morning and evening" after "…today…", and "…about orders" after "…about returns", both did. A single swapped word, or a change only in dates, days and numbers, is now a new request. The threshold rose from 60% to 70%.
- **Forwards and uncaptioned photos scored `false`.** They have none of the owner's words, so they now score nothing.
- **A reply to an older message broke "first message only".** The turn before it stayed scorable by the owner's second message. Now the reply passes over it.

Nits fixed:

- detection runs inside `turnFeedback`'s catch, so it cannot fail a turn;
- background runs no longer take places in the 200-turn memory;
- queue overflow is documented under `abortedCount`.

Re-review of `469197c` approved it. Two further should-fix findings were corrected in the next commit:

- **Single digits were dropped before the number rule saw them.** As a result, "a table for 2" after "for 4" counted as a rephrase. Single digits now count as content words.
- **The extension guard was undone by the correction step.** "Thanks, try again later if it fails" and "Try again tomorrow morning" were labelled `correction` by the learner's pattern. A request for another attempt that comes with a time or an extension now ends as "not a redirect" before the correction step. The learner's own definition is unchanged.

Nits from that round were also addressed. A short retry ("another one") must now be the whole message, so "Another idea: add a reminder…" is no longer a retry. The wording about forwards was corrected: the turn before a forward gets no score, and does not wait.

A third review of `804a5cf` found that the extension guard had become too broad. It dropped real corrections that mention a time: "That's wrong, try again for Friday" and "you missed the meeting tomorrow, try again" both scored no redirect. It also dropped complaints containing "too" ("try again, that's too long"). The next commit applies the reviewer's tested fix:

- an attempt with a time or an extension is still a correction if the rest of the message is one;
- "too" is an extension only at the end of the message;
- "try a different approach" is a retry.

A fourth review of `c32ef8f` approved it, with one slip: a final "too" followed by punctuation ("…for mum too!") was not an extension. It was fixed in `8db624b`, which the reviewer approved at that exact commit.

Recorded as limits, not changed:

- "redo" without a time or extension stays a correction, as in the learner;
- a retry verb followed by a new object ("retry the payment for the bill") still counts as a retry;
- "too long, shorter please" is not detected;
- interrupted turns are not scored;
- a reply to an older message is not checked for a rephrase.

## Verification and outcome

`npx tsx --test tests/turn-feedback.test.ts tests/otel.test.ts tests/learning*.test.ts` passes 34 of 34, and `tsc --noEmit` passes. On `275997e`, the full local `kite run check` passed 1,365 of 1,367 tests. The failure was the corrupt-gzip test, which needs Node 22.23.4 ([journal 126](126-fetch-hygiene-and-node.md)); the laptop has 22.15. Hosted CI passed every job on `275997e`. Results for the reviewed fix commit are recorded on the PR.

### Release closure — 2026-10-29

[PR 355](https://github.com/akhilvuputuri/chief-agent/pull/355) merged at the approved head `8db624b` as `bc4c5c09e077eb22bd32ee2c1f295c6de730e941`. Hosted CI passed every job on `8db624b`. The [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/40845451244) deployed that exact commit at 09:01 UTC on 29 October and reported `{"deployed": "bc4c5c0…", "healthy": true}`.

No endpoint is configured in production, so `turnFeedback` and `runConversation` return at once there, and no evaluation leaves the host. That the feedback works is shown only by the tests and the synthetic run above.

## Follow-up and next iteration

- Measure the rules on real messages before trusting the rate. The cheapest test is a read-only count over recent `conversation_inputs` that reports only aggregates per rule, plus the owner reading a handful of flagged pairs on the laptop. Both need owner approval.
- An LLM judge on sampled traces in agentwatch (#323 step 3, agentwatch side) needs message content, which Chief's spans deliberately omit. Whether to export content to a local collector is the owner's decision.
- Production export still waits on where a collector runs ([journal 131](131-otel-trace-export.md#follow-up-and-next-iteration)).
