# 117 — Why did Chief drop dated monitoring, its own questions and stated preferences?

Work date(s): 2026-10-23. Written/revised: 2026-10-23.
Status: released in `fdb88c7` (PR 311, version 0.3.98) on 23 October 2026; live acceptance pending. Independent review: approve with nits on `c69597f` and `584f54f`; the delta review of `f635abb` and `2d1f466` approved, and its two coverage nits are fixed. No live behavior has been observed yet.

## User-visible problem and preceding iteration

[Journal 94](94-open-loops-context.md) added `openLoops` to each foreground turn's context: coding jobs that wait on the owner, and monitoring confirmation cards that expired unanswered in the last day. A private production review of 14–21 October found three more things that waited on the owner and were lost:

- **A dated monitoring card dropped out after a day.** The owner had asked Chief to watch a family member's return flight. The confirmation card expired unconfirmed and left open loops 24 hours later. The flight date passed on 20 October with no mention.
- **Chief's own clarifying questions were dropped.** When Chief paused a turn to ask the owner something and the owner moved on, nothing carried the question beyond the next exchange in that thread.
- **Stated preferences were never saved.** Chief saved a memory only when explicitly told to remember something.

## Evidence

- **Measured,** from the private production review (14–21 October 2026), under the owner's authorization. Only aggregates appear here.
  - 1 monitoring card for a dated event lapsed unconfirmed. It dropped out of open loops before its date, and the date passed without a mention.
  - The owner had 7 saved memories, 6 of them in one category (career profile). In that week, 2 durable preferences the owner stated were not saved.
  - At least one Chief question that ended a turn waiting on the owner was never answered and never raised again. The review did not count them.
- **Code-confirmed at `9fc5ecc`:**
  - `openLoops` listed an expired monitoring card only while `expires_at > now() - 1 day`, whatever the dates in its spec.
  - A monitoring spec has one date field: `expiresAt`, the end of monitoring. A `date` end condition requires it. There is no separate event-date field.
  - A turn that ends with `finish_turn` reason `awaiting_user` saves its reply as `conversation_contexts.pending_reply` (`question`, `askedIn` thread, `reason`). The runtime context carried only the newest one, as `pendingReply` and `lastExchangeHere`. Any later turn replaced it.
  - `memory_set` is a core coordinator tool with no approval step. Plugin agents can never be granted it. The instructions said only "Use memories only for explicit facts/preferences."

## Diagnosis and alternatives

**Monitoring.** The one-day window from journal 94 was sized for a card that is answered late, not for an event that is still days away. The card's own `expiresAt` is the end of monitoring, not the event date. It is used as a proxy for the event date because it is the only date in the spec (hypothesis: that Chief sets it near the event). If monitoring was set to end after the event, `due` starts late. Chosen:

- Keep the card until one day after `expiresAt`. Mark it `due` from a day before that date.
- Keep a card without a date for seven days.
- Never keep a card more than 30 days after it expired.

A longer window made the supersession gap from journal 94 matter more. A never-confirmed concern proposed again gets a new id, so its old card would have stayed listed for days, even after the owner confirmed the new one. A later card with the same title (case-insensitive, trimmed) now also drops it, but only when:

- that card was confirmed, or is pending and was delivered, so a denied or undelivered proposal does not hide it; and
- it ends no earlier than the older card, or either has no `expiresAt`, so a same-titled card for an earlier date (another trip) does not hide a later one.

Two different concerns with the same title and compatible dates would still hide the older card. This is accepted as rarer and less harmful than nudging about something already set up. If the owner corrects a concern to an earlier date, the newer card ends earlier and does not hide the stale later-dated card, which stays listed, and may show as due, until its own date plus a day.

- **Rejected for now: parsing a date out of the title or outcome.** Free text is unreliable. A card without `expiresAt` falls back to seven days, which would have covered this incident's dates (hypothesis: whether that card had `expiresAt` set was not checked).
- **Deferred: a proactive nudge.** The scheduler (`schedule_create` reminders) runs only on the owner's explicit request. Journal 94 rejected re-sending expired cards because that sends unrequested messages. A host-created reminder for a concern the owner never confirmed would be a new kind of unprompted message. That needs the owner's decision. For now a due card is listed first with `due: true`, and the note tells Chief to mention it once when the owner next writes. If the owner does not write while it is due, nothing reminds them.

**Questions.** The saved conversation state already holds the reply and its thread, so there is no new storage. A question counts as answered once a later owner message in the same thread has been handled by a completed turn. This rule was chosen because:

- the message being handled now does not clear the question it may be answering;
- a message in another topic does not clear it.

Any completed message in the same thread clears it, whether or not it was an answer. Telling an answer from a change of subject would need a model judgment or a host-side tracker. This version does not try. In a single-thread chat, the newest question is already in context through `pendingReply` and `lastExchangeHere`, and the owner's next message there clears it from open loops. So the gain is mainly across topics: a question asked in one topic stays listed while the owner writes in others. Whether this would have caught the observed case is unknown: the review's aggregates do not say which thread the question was in, or whether the owner wrote in that thread again.

- **Rejected: `runtime_runs.stop_reason` alone.** It has the reason but not the question text or the thread. `pending_reply` has all three.
- **Rejected: listing `awaiting_approval` pauses.** Their cards are already tracked elsewhere.
- **Limitation:** `pending_reply.question` is saved cut to 3,000 characters, so a question after that point in a long reply is not in the excerpt.

**Memory.** This is a behavior gap, not a missing capability. Chief can already save with `memory_set`. Chosen: one instruction sentence. When the owner states a durable preference or fact that is not saved yet, Chief ends its answer with one short offer ("Want me to remember that you prefer X?"), calls `memory_set` only after a yes, and does not repeat a declined offer.

- **Rejected: a host-side pending-suggestion record.** The owner's yes arrives as the next message, with the offer in the previous exchange. The prompt is size-sensitive ([101](101-lean-coordinator-prompt.md)), so the rule is one sentence.
- **Not added: an approval card for `memory_set`.** A text yes is enough for a memory the owner can see and replace. The rule depends on the model following the instruction (hypothesis). Nothing in the host blocks a save without a yes, as before.

## Implementation and review

- `src/open-loops.ts`:
  - **Expired monitoring cards** follow the retention above, with a `specEnd` SQL expression that casts `expiresAt` only when it looks like an ISO date. Each card carries `endsAt` and `due`. Order: due first, then the earliest end date, then the most recently expired. With more than three cards, an undated or later-dated one can be left out.
  - **`questions`**: the newest three from the last three days, read from `conversation_contexts`, so an older fourth is left out. Each has a host `awaiting` label, the date, the thread, the reply's message id (for `conversation_read`), and an excerpt.
  - **`questionExcerpt`** collapses whitespace and keeps at most 200 code points, including the ellipsis, ending at the reply's last question mark. A long reply that closes with a question therefore shows the question.
  - **The note** marks `excerpt` as data alongside `workerText` and `title`. It also says how to treat `due` cards and unanswered questions.
  - Excerpts go into the model context only. The host does not log them, and traces record only each context key's size.
- `src/context.ts`: the memory-offer sentence follows "Use memories only for explicit facts/preferences."
- Tests:
  - `tests/open-loops.test.ts`:
    - the monitoring test is rewritten for seven-day undated retention and same-title supersession;
    - a new test covers the narrowed same-title rule: a newer card for an earlier date, a denied one and an undelivered one leave the older card listed; a confirmed later-ending one and an undated delivered one hide it;
    - a new test covers an undated card hidden by a newer delivered dated one, and another owner's same-titled card leaving this owner's listed;
    - a new test covers dated cards: a future date stays, the date arriving or just passed is `due`, a date past the grace period drops, and any card past 30 days drops;
    - a new test covers questions. Each fixture turn is recorded as the agent records it: the triggering owner input (completed, received before the state is saved), Chief's reply message, and the state from the real `saveConversationState`. A question is listed with its `replyId`. A running message in the same thread, a completed one in another thread and another owner's completed message in the same thread do not clear it. A completed reply in the same thread does. Old questions, `awaiting_approval` pauses, a reply still pending delivery and another owner's question and card are left out;
    - an excerpt test.
  - `tests/tool-domains.test.ts` pins the memory-offer sentence.
- Design docs: [context management](../context-management.md#open-loops), [responsibilities](../responsibilities.md) and [agents](../agents.md).

Independent review (Opus 5.5) of `c69597f` and `584f54f`: approve with nits.

- **The question tests were weak.** All 15 tests still passed when the reviewer removed `i.received_at > x.created_at`, replaced `i.user_id=x.user_id` with `true`, or dropped the pending-delivery exclusion. The fixtures now record the triggering input and the reply message, and add another owner's records and a pending reply.
- **The same-title match was too broad.** A denied, undelivered or earlier-dated card hid an older one. Narrowed as described above.
- **`expiresAt` was called the event date.** It is the end of monitoring, used as a proxy; the wording is corrected.
- **Nits:** the excerpt could reach 201 code points, the 3,000-character truncation and the three-item limits were undocumented, and the dates and fixture text are made consistent and generic.

Mutation check after the fixes, each applied to `src/open-loops.ts` on its own and then restored: removing `i.received_at > x.created_at`, `i.user_id=x.user_id` (as `true`), the pending-delivery exclusion, `i.state='completed'`, the same-title status and delivery condition, or the same-title end-date condition each fails exactly one test. Widening the owner filter of the cards query fails two tests, and of the questions query one.

Delta review (Opus 5.5) of `f635abb` and `2d1f466`: approve. It ran 13 mutations of `src/open-loops.ts`: 10 failed a test, 2 survived and 1 was harmless (a mutation that depends on `run_id`, which is a per-run UUID). The 2 survivors were coverage gaps in correct code, recorded as nits:

- removing the clause that lets a newer dated card hide an undated older one;
- removing `b.user_id=a.user_id`, so another owner's same-titled card could hide this owner's.

A new test covers both: an undated card hidden by a newer delivered dated one, and another owner's later same-titled card that leaves this owner's card listed. Each of the two mutations now fails that test.

## Verification and outcome

- **Tested** (local, PGlite), after the review fixes: `tests/open-loops.test.ts` 17/17 (after the delta-review nits; 16/16 before), `tests/tool-domains.test.ts` 17/17 and `context-continuity` 33/33; `npx tsc --noEmit -p .` passes. On the first revision, also passing: `conversation-control` 13/13, `context-continuity` 33/33, `steering-loop` 13/13, `steering-inbox` 17/17, `responsibilities` 32/32, `telegram-feeds` 7/7, `spending` 3/3 and `topic-routing` 6/6.
- **Not measured:**
  - whether Chief mentions a due card, re-asks an open question, or offers to remember a preference;
  - the cost of the slightly longer instructions. The instructions sit in the cached prefix, so the change costs one cache rewrite per deployment.
- **Live acceptance after release:**
  - a lapsed dated monitoring card is mentioned when its date arrives;
  - an unanswered question appears in a later status answer;
  - a stated preference draws one offer, and is saved only after a yes.

### Release closure — 2026-10-23

- **Merged.** [PR 311](https://github.com/akhilvuputuri/chief-agent/pull/311) as `fdb88c79e644d037bb93ae0030dd742a527e1a87`, version 0.3.98.
- **Heads.** Delta review approved `2d1f466`. The coverage nits (`baaa8f3`), Devin's wording fix (`e843b6f`) and the merge of main (`5b3ee34`, the merged head) were checked by the coordinator; CI and Devin passed on the merged head.
- **Review.** Independent review (Claude Opus 5.5): approve with nits, then approve after stronger tests (13 mutations checked). Devin found that the note said a due card's date "has arrived" when it may be a day away; fixed before merge.
- **Release.** The [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/39939022244) succeeded and `release:status` recorded the exact commit deployed with startup health passing at 10:31 UTC on 23 October. No migration. CloudWatch showed no warn or error lines from 08:42 to 15:42 UTC on 23 October.
- **Not yet observed.** Chief mentioning a due card, re-raising an unanswered question across topics, and making a memory offer in live conversation.

## Follow-up and next iteration

- **A proactive, owner-visible reminder** when a lapsed card's date arrives. It needs the owner's approval of that kind of message, and could reuse the reminder scheduler.
- **Telling an answer from a change of subject** before clearing a question.
- **A stable proposal identity for monitoring cards,** to replace the title match.
- **Letting the owner dismiss a lapsed card.** It now stays listed until its date or the bound passes.
