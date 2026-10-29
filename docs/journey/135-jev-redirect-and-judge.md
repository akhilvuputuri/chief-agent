# 135 — Can Chief catch the pushback its text rules miss, and can a model judge its answers?

Work date: 2026-10-30 (Singapore). Written: 2026-10-30.
Status: in review. Jev's redirect question is code-complete; the judge waits for agentwatch's key and a new image through an operator rollout.

## User-visible problem and preceding iteration

[Journal 134](134-agentwatch-on-the-host.md) measured the text rules on real messages. Every flag they raised was right, but they caught only about half of the redirects. The misses were mostly pushback phrased as a question or a nudge: a doubt about the answer, asking why something stopped, restating a constraint the answer ignored. That journal named two next steps, each a small paid model call, and the owner approved both on 30 October:

- a Jev question;
- an LLM judge on the traces now in agentwatch.

## Evidence

- **Tested** (`tests/effort.test.ts`):
  - the first effort decision asks the redirect question only when there is a previous reply;
  - escalations never ask it;
  - its probability is parsed and rounded;
  - an invalid or missing answer gives none and leaves the effort unchanged.
- **Tested** (`tests/turn-feedback.test.ts`): Jev's answer counts only where the rules found nothing, from the threshold up. A rules label, or "no owner words", stands as it is.
- **Tested** (`tests/otel.test.ts`): the probability is exported as a numeric `jev_redirect_probability` evaluation on the same span as `user_redirected`.
- **Measured, 30 October:** one live request with both questions, sent from inside the gateway container so the key never left it, returned HTTP 200 for two synthetic exchanges. It took 455 and 788 ms, under the effort decision's 1.5 s timeout, and cost about $0.000026 each. Jev's redirect probabilities were 0.59 for "But it's cloudy eh?" after a no-rain answer, the kind of miss journal 134 found, and 0.04 for "Thanks, and what about tomorrow?". That one data point moved the threshold from the planned 0.8 down to 0.5. It is a provisional start, to be set from the recorded probabilities.
- **Not measured:**
  - how well Jev separates pushback from new requests;
  - whether 0.5 is the right threshold;
  - what the extra question costs per decision.

  The recorded probabilities are meant to answer the first two once real messages arrive.

## Diagnosis and alternatives

- **Jev rather than a new model call.** Jev already answers an effort question before every foreground reply, with the message and the last two turns in its state. A second question in the same request costs at most a little more and adds no request, and the effort decision's 1.5 s timeout bounds it. A separate classifier call would double the requests.
- **A second opinion, not a replacement.** The rules were 8 of 8 right when they fired, so their labels stand. Jev decides only where they found nothing.
- **Recorded raw.** Without labelled data, the threshold is a guess. Exporting the probability lets agentwatch show its distribution against the rules' flags, and later against the judge's verdicts.

## Implementation and review

- [src/effort.ts](../../src/effort.ts): the optional `redirect` question and its parsing.
- [config/reasoning-effort.json](../../config/reasoning-effort.json): the question text and `apply: 0.5`.
- [src/turn-feedback.ts](../../src/turn-feedback.ts): `withJev`.
- [src/agent.ts](../../src/agent.ts): feedback is sent once the effort decision returns, and Jev is consulted only when the owner answers the latest exchange.
- [src/otel.ts](../../src/otel.ts): numeric evaluations and `jev_redirect_probability`.
- Design: [reasoning effort](../reasoning-effort.md#redirect-question), [tracing](../tracing.md#implicit-feedback).

Independent review (Opus 5.5) of `b65e4f7` found nothing blocking. Its should-fix findings were addressed in the next commit:

- **The two-question request shape was unverified.** If the provider had rejected it, every message would have fallen back to medium effort. It is now measured above.
- **Jev is shown the last turns of the owner's whole history,** so across threads, or after a proactive message, it could judge a different exchange from the one scored. `jevSawExchange` now requires the last turn Jev saw to be this thread's latest exchange: the same request and, after a second review, the same reply, so a reminder or job result delivered since doesn't count. The reply compared is the answer itself (`lastAnswerHere`), because any answer with structured parts is followed by a saved-details pointer, which is what `lastExchangeHere.reply` holds. That also fixes an older miss: after such an answer ended in a question, a plain "no" counted as a correction.
- **The wiring decision was untested.** It is now a tested pure function.

Smaller fixes:

- the docs no longer promise "within 1.5 s";
- the question's false case now names follow-ups that extend the reply to a new case.

## Follow-up and next iteration

- The judge: agentwatch#15 (conversations-only judges, OpenRouter cost), a rollout giving agentwatch the OpenRouter key and the new image, then a judge created through the API.
- After a week of messages, compare `jev_redirect_probability` with the rules' flags and the judge's verdicts, and set the threshold from that.
