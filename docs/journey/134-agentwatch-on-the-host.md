# 134 — Can agentwatch run next to Chief and see what was said?

Work date: 2026-10-29 (Singapore). Written: 2026-10-29.
Status: in progress. Measurement done; message capture in review; the host deployment follows in its own reviewed rollout.

## User-visible problem and preceding iteration

[Journal 133](133-implicit-redirect-feedback.md) made the owner's follow-up messages a `user_redirected` score, and agentwatch gained LLM judges that score sampled traces. Neither does anything for production yet:

- Production sets no export endpoint.
- Chief's spans carry no message text, so a judge has nothing to read.

The owner asked how meaning could be analysed without the text. Without it, the only signals are structure (tools, failures, timing, cost), labels computed inside Chief, and implicit signals. None of these can say whether an answer was right. The owner chose:

- to run agentwatch on the production host;
- to capture message content in detail;
- to publish agentwatch's image to GHCR;
- to keep traces for 90 days;
- to measure the redirect rules on real messages first.

## Evidence

**Measured, 29 October.** This was a read-only pass over production `conversation_inputs`, using the weekly review's read-only query path (`BEGIN READ ONLY … ROLLBACK`). Window: 13 September – 29 October 2026, with the released rules (`8db624b`).

- 185 owner follow-ups had a previous turn in the same thread; 142 came within six hours.
- 4 had none of the owner's words.
- 8 were flagged: 5 corrections, 2 retries and 1 rephrase. All 8 were real redirects on reading.
- Reading all 130 unflagged follow-ups (142 less 4 without owner words, less 8 flagged), about 8 were clear redirects the rules missed, and 3 more were borderline.
- **Estimate:** precision 8/8, recall about one half, so a true redirect rate of about 12–14% against the 6% the rules report.
- **Limits:** one reader, no second opinion, and a small sample.
- **Handling:** the extracted text stayed in a private scratch file on the operator's laptop, deleted after this entry. Only aggregates are recorded here.

The misses were of two kinds:

- **Repeats after Chief failed to do something:** "add … again", "try to add again", or that something still did not work. A short "…again" request is now a retry; the others need the structural signal (a follow-up after a failed or uncertain tool call), which agentwatch can already see in the trace's errors.
- **Pushback phrased as a question or a nudge:** a doubtful remark about the answer, asking why something stopped, restating a constraint the answer ignored. Text patterns cannot catch these; a classifier or a judge reading the text can.

**Tested:**

- `tests/otel-content.test.ts` covers the conversion to the conventions' message parts, images omitted, credentials scrubbed (including one at the cut), long values cut, and long histories keeping their newest messages.
- `tests/otel.test.ts` drives a real `Execution` with content on and off. With content on, the root, model and tool spans carry the expected messages, arguments and results, and the planted key is absent. With it off, none of the planted texts appear and no content attribute is set. Byte-limited batching and the byte-bounded queue are also tested.
- `tests/turn-feedback.test.ts` adds the two missed repeats from the measurement as retries, and two "…again" questions as not.

## Diagnosis and alternatives

- **Where agentwatch runs.** Options considered:
  - beside the gateway on the host;
  - pushing to the laptop;
  - a laptop job pulling from Postgres read-only;
  - a file drop;
  - a hosted service.

  The owner chose the host for live data. It needs a Compose service and a gateway variable, which the automatic release refuses by design, so it goes through a reviewed operator rollout, like other Compose changes.

- **Content format.** The GenAI conventions' opt-in attributes (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.tool.call.arguments` / `.result`) behind their standard variable. Any GenAI-aware viewer reads them, and agentwatch's judges and datasets already do.
- **Size.** Full input on every model call repeats the conversation, so each list is capped at 128,000 characters, keeping the newest messages. The exporter batches by bytes, because its old 256-span batches could exceed agentwatch's 16 MB request limit.

## Implementation and review

- [src/otel-content.ts](../../src/otel-content.ts): conversion, scrubbing and caps.
- [src/otel.ts](../../src/otel.ts): `runContent`, `modelContent`, content on the call hooks, and byte-aware batching and queue bounds.
- Hooks in [custom-agent.ts](../../src/custom-agent.ts), [execution.ts](../../src/execution.ts) and [agent.ts](../../src/agent.ts).
- The opt-in is read in [main.ts](../../src/main.ts).
- Design: [tracing](../tracing.md#message-content).

agentwatch's side is agentwatch#14: the image, published from `main` only after a smoke test, and `--retain-days`.

Independent review (Opus 5.5) of `59e527d` found nothing blocking. Its should-fix findings were corrected in the next commit:

- **Scrubbing ran after serialising, so key names were lost.** A `password` or `access_token` value under its key went out unchanged, as did Google `ya29.`, `AIza`, AWS and Slack tokens. Content now has its own scrubber, which works by key at any depth, also inside JSON text, and covers those shapes.
- **The "…again" rule fired on ordinary chat:** "thanks again", "never again", "see you again". It now needs an action verb.
- **Tool arguments were exported double-encoded** (`{"raw": "…"}`).
- **"Images are never sent" did not hold** for `data:` URLs in text or base64 in tool results. Both are now replaced.
- **Size estimates counted characters, not escaped UTF-8 bytes**, and one huge message could exceed its list's cap. Both are fixed.
- **Held content was bounded by entry count, not size.** It is now at most 32 MB in total.

Re-review of `3f7e1bf` found one blocking problem. The new base64 pattern backtracked quadratically on runs just under its length limit: 1.6 s per MB, run on the event loop when a tool result arrives. The next commit:

- starts a match only at a run's first character (a lookbehind; about 4 ms per MB);
- bounds every string before scrubbing;
- replaces content nested too deeply to walk with a placeholder instead of losing the span;
- drops "remind me again" from the retry verbs.

Smaller fixes:

- output messages carry `finish_reason`;
- the docs say which root output is shown and that the owner's email and calendar content is exported once content is on.

## Verification and outcome

Pending. Next:

- review and CI of this change;
- the rollout PR (Compose service, gateway variables, operator script);
- the operator run;
- a first real trace viewed through an SSH tunnel.

## Follow-up and next iteration

- A question to Jev, the classifier Chief already asks about effort and tools on every message: "does this redirect the previous answer?" question would catch pushback the patterns miss, for about $0.001 a message. It needs the owner's approval.
- A judge on real traces, once content flows (a paid model; the owner picks the model and the daily limit).
