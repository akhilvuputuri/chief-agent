# 117 — Why did Chief drop dated monitoring, its own questions and stated preferences?

Work date(s): 2026-10-23. Written/revised: 2026-10-23.
Status: in review, on branch `fix/d-loops-memory`. Independent review: pending. Not merged or deployed. No live behavior has been observed yet.

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

**Monitoring.** The one-day window from journal 94 was sized for a card that is answered late, not for an event that is still days away. The card's own `expiresAt` is the best available date for the event or deadline. Chosen:

- Keep the card until one day after `expiresAt`. Mark it `due` from a day before that date.
- Keep a card without a date for seven days.
- Never keep a card more than 30 days after it expired.

A longer window made the supersession gap from journal 94 matter more. A never-confirmed concern proposed again gets a new id, so its old card would have stayed listed for days, even after the owner confirmed the new one. A later proposal with the same title (case-insensitive, trimmed) now also drops it. Two different concerns with the same title would hide the older card. This is accepted as rarer and less harmful than nudging about something already set up.

- **Rejected for now: parsing a date out of the title or outcome.** Free text is unreliable. A card without `expiresAt` falls back to seven days, which would have covered this incident's dates (hypothesis: whether that card had `expiresAt` set was not checked).
- **Deferred: a proactive nudge.** The scheduler (`schedule_create` reminders) runs only on the owner's explicit request. Journal 94 rejected re-sending expired cards because that sends unrequested messages. A host-created reminder for a concern the owner never confirmed would be a new kind of unprompted message. That needs the owner's decision. For now a due card is listed first with `due: true`, and the note tells Chief to mention it once when the owner next writes. If the owner does not write while it is due, nothing reminds them.

**Questions.** The saved conversation state already holds the reply and its thread, so there is no new storage. A question counts as answered once a later owner message in the same thread has been handled by a completed turn. This rule was chosen because:

- the message being handled now does not clear the question it may be answering;
- a message in another topic does not clear it.

Any completed message in the same thread clears it, whether or not it was an answer. Telling an answer from a change of subject would need a model judgment or a host-side tracker. This version does not try. Its gain is mainly across topics, and across turns where the owner writes elsewhere.

- **Rejected: `runtime_runs.stop_reason` alone.** It has the reason but not the question text or the thread. `pending_reply` has all three.
- **Rejected: listing `awaiting_approval` pauses.** Their cards are already tracked elsewhere.

**Memory.** This is a behavior gap, not a missing capability. Chief can already save with `memory_set`. Chosen: one instruction sentence. When the owner states a durable preference or fact that is not saved yet, Chief ends its answer with one short offer ("Want me to remember that you prefer X?"), calls `memory_set` only after a yes, and does not repeat a declined offer.

- **Rejected: a host-side pending-suggestion record.** The owner's yes arrives as the next message, with the offer in the previous exchange. The prompt is size-sensitive ([101](101-lean-coordinator-prompt.md)), so the rule is one sentence.
- **Not added: an approval card for `memory_set`.** A text yes is enough for a memory the owner can see and replace. The rule depends on the model following the instruction (hypothesis). Nothing in the host blocks a save without a yes, as before.

## Implementation and review

- `src/open-loops.ts`:
  - **Expired monitoring cards** follow the retention above, with a `CROSS JOIN LATERAL` that casts `expiresAt` only when it looks like an ISO date. Each card carries `endsAt` and `due`. Order: due first, then the earliest end date.
  - **`questions`**: up to three from the last three days, read from `conversation_contexts`. Each has a host `awaiting` label, the date, the thread, the reply's message id (for `conversation_read`), and an excerpt.
  - **`questionExcerpt`** collapses whitespace and keeps at most 200 characters, ending at the reply's last question mark. A long reply that closes with a question therefore shows the question.
  - **The note** marks `excerpt` as data alongside `workerText` and `title`. It also says how to treat `due` cards and unanswered questions.
  - Excerpts go into the model context only. The host does not log them, and traces record only each context key's size.
- `src/context.ts`: the memory-offer sentence follows "Use memories only for explicit facts/preferences."
- Tests:
  - `tests/open-loops.test.ts`:
    - the monitoring test is rewritten for seven-day undated retention and same-title supersession;
    - a new test covers dated cards: a future date stays, the date arriving or just passed is `due`, a date past the grace period drops, and any card past 30 days drops;
    - a new test covers questions, using the real `saveConversationState`. A question is listed. A running message in the same thread and a completed one in another thread do not clear it. A completed reply in the same thread does. Old questions and `awaiting_approval` pauses are left out;
    - an excerpt test.
  - `tests/tool-domains.test.ts` pins the memory-offer sentence.
- Design docs: [context management](../context-management.md#open-loops), [responsibilities](../responsibilities.md) and [agents](../agents.md).

Independent review: pending.

## Verification and outcome

- **Tested** (local, PGlite): `tests/open-loops.test.ts` 15/15, `tests/tool-domains.test.ts` 17/17. Also passing: `conversation-control` 13/13, `context-continuity` 33/33, `steering-loop` 13/13, `steering-inbox` 17/17, `responsibilities` 32/32, `telegram-feeds` 7/7, `spending` 3/3 and `topic-routing` 6/6. `npx tsc --noEmit -p .` passes.
- **Not measured:**
  - whether Chief mentions a due card, re-asks an open question, or offers to remember a preference;
  - the cost of the slightly longer instructions. The instructions sit in the cached prefix, so the change costs one cache rewrite per deployment.
- **Live acceptance after release:**
  - a lapsed dated monitoring card is mentioned when its date arrives;
  - an unanswered question appears in a later status answer;
  - a stated preference draws one offer, and is saved only after a yes.

## Follow-up and next iteration

- **A proactive, owner-visible reminder** when a lapsed card's date arrives. It needs the owner's approval of that kind of message, and could reuse the reminder scheduler.
- **Telling an answer from a change of subject** before clearing a question.
- **A stable proposal identity for monitoring cards,** to replace the title match.
- **Letting the owner dismiss a lapsed card.** It now stays listed until its date or the bound passes.
