# 52 — Topics in the private chat: filing scheduled output, phase 1

Work date(s): 2026-10-01. Written/revised: 2026-10-01.
Status: implemented and tested. Not yet deployed.

## User-visible problem and preceding iteration

Chief has one rolling private chat. Scheduled output shares that chat with the owner's own conversation: the news bulletin from [journal 42](42-news-bulletin.md) and stock alerts. The owner asked whether "sub-chats" could reduce the clutter. A research report on Telegram sub-chats (1 October, outside the repo) found that Telegram now supports topics inside a bot's private chat ("threaded mode", Bot API 9.3 on 31 December 2025 and 9.4 on 9 February 2026). It recommended an outbound-first pilot with a fixed set of topics and one shared memory.

On 1 October the owner turned on Threaded Mode for the production bot. Chief then turned on "Disallow users to create new threads" through the BotFather Mini App, at the owner's request. Without that switch, every message typed outside a topic creates a new topic.

## Evidence

- **Reported (research):**
  - A send without `message_thread_id` lands in General, with no error.
  - `message_thread_id=1` is rejected, so General must be addressed by leaving the id out.
  - A deleted topic fails sends with "message thread not found".
- **Tested:** `tests/telegram-topics.test.ts` has 10 tests:
  - concurrent first sends create one topic, and the id is reused after a restart;
  - with threaded mode off, `TELEGRAM_TOPICS=off`, or failed creation, sends go to General;
  - a deleted topic is recreated and the send is retried once, while other errors are not retried;
  - every part of a long answer goes into the topic;
  - an inbound topic message gets its reply and typing indicator in the same topic, while General stays plain;
  - a closed topic sends to General, and a topic is used even if recording its id fails;
  - two sends that find the topic deleted recreate it once;
  - approval cards follow the topic;
  - turning threaded mode on later is picked up without a restart.
- **Not yet observed:** behaviour on the live bot. In particular, that `createForumTopic` succeeds in the owner's private chat with user-created topics disallowed.

## Diagnosis and alternatives

- **Private-chat topics, not a forum supergroup.** A supergroup brings in group security: other members, invite links and admin rights. Chief's allowlist accepts only private chats.
- **Outbound filing first.** It is the lowest-risk use. Each topic can be muted separately on the phone, and nothing about routing or memory changes. Phase 2 would send a message typed in a topic straight to that domain's agent. The routing shadow data from [journal 51](51-shadow-decisions.md) can judge whether that is worth it.
- **Parcels has no topic yet.** Parcel updates have no scheduled push today. They arrive inside answers.
- **Fail open to General.** A missing topic must never lose a bulletin or an alert.

## Implementation and review

See [topics in the private chat](../telegram-topics.md): `TelegramTopics`, a thread-aware `Chat` target in views, and inbound thread pass-through. Thread ids are stored as `telegram.topic` events under a stable run id per topic. A first draft used a new table, but that migration would have needed an operator rollout, and until that ran it would block every other session's automatic release. Avoiding it keeps this app-only. **Independent review (Opus 5.5): approved on the first head and again on the fixes**, with six low-severity points. Fixed:

- a newly created topic is used even if recording its id fails, so that send still uses the new topic instead of General;
- any other 400 rejection about a topic, such as a closed topic, falls back to General instead of losing the message;
- concurrent recoveries of a deleted topic create one new topic;
- the typing indicator is sent with an explicit thread and caught, because grammY's helper copies `message_thread_id` even for General messages.

**Devin review** raised the same points, plus two more that were fixed:

- an "off" threaded-mode answer is checked again after ten minutes;
- a topic whose id failed to record is remembered in the process, so it is not duplicated.

Documented rather than changed:

- a follow-up that joins a running reply is answered in the topic of the message that started the run.

## Verification and outcome

Typecheck passes and the new tests pass. Live acceptance after deploy:

1. The next news bulletin creates a **News** topic and appears in it.
2. A message typed in that topic is answered there.
3. A message typed in General is answered in General.

## Follow-up and next iteration

- Phase 2: a message typed in a topic goes straight to that agent, with the general router as fallback.
- Possible further topics: Jobs or background results, and Email.
- After 1–2 weeks, check whether the owner mutes topics and whether General feels cleaner.
