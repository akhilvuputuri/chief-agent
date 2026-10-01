# 52 — Topics in the private chat: filing output and a first step by topic

Work date(s): 2026-10-01. Written/revised: 2026-10-01.
Status: phase 1 released `03a1ef4` (1 October 2026); live acceptance pending. Phase 2 implemented and tested; not yet deployed.

## User-visible problem and preceding iteration

Chief has one rolling private chat. Scheduled output shares that chat with the owner's own conversation: the news bulletin from [journal 42](42-news-bulletin.md) and stock alerts. The owner asked whether "sub-chats" could reduce the clutter. A research report on Telegram sub-chats (1 October, outside the repo) found that Telegram now supports topics inside a bot's private chat ("threaded mode", Bot API 9.3 on 31 December 2025 and 9.4 on 9 February 2026). It recommended an outbound-first pilot with a fixed set of topics and one shared memory.

On 1 October the owner turned on Threaded Mode for the production bot. Chief then turned on "Disallow users to create new threads" through the BotFather Mini App, at the owner's request. Without that switch, every message typed outside a topic creates a new topic.

## Evidence

- **Reported (research):**
  - A send without `message_thread_id` lands in General, with no error.
  - `message_thread_id=1` is rejected, so General must be addressed by leaving the id out.
  - A deleted topic fails sends with "message thread not found".
- **Tested:** `tests/telegram-topics.test.ts` has 11 tests:
  - concurrent first sends create one topic, and the id is reused after a restart;
  - with threaded mode off, `TELEGRAM_TOPICS=off`, or failed creation, sends go to General;
  - a deleted topic is recreated and the send is retried once, while other errors are not retried;
  - every part of a long answer goes into the topic;
  - an inbound topic message gets its reply and typing indicator in the same topic, while General stays plain;
  - a closed topic sends to General, and a topic is used even if recording its id fails;
  - two sends that find the topic deleted recreate it once;
  - approval cards follow the topic;
  - turning threaded mode on later is picked up without a restart;
  - a failed lookup sends to General rather than creating a duplicate topic.
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
- a topic whose id failed to record is remembered in the process, so it is not duplicated;
- a failed lookup sends to General rather than creating a duplicate topic.

Documented rather than changed:

- a follow-up that joins a running reply is answered in the topic of the message that started the run.

## Phase 2: the Email topic as the first step

The owner asked for the whole feature rather than waiting for shadow data.

- **Mechanism.** After [journal 49](49-coordinator-agents.md), Chief's first model call for a domain request usually only calls `agent_run`. For a message typed in the Email topic, the host makes that call itself, through a new `AgentRequest.firstCall`. It is journaled and dispatched exactly like a model-made call, so history, approvals and memory are unchanged. Chief's first model call sees the agent's report and writes the reply.
- **Scope narrowed during design.** At first the plan was all three topics. Reading the agent definitions showed that the News and Markets agents manage bulletin and alert _settings_, while questions typed in those topics usually need the web agent. Those topics only add a hint to Chief's context. Shadow routing data can justify widening this later.
- **Saving, not measured live.** Phase 2 saves one main-model call per eligible message. The offline estimate is about 4.2 s and $0.02 per saved call, as an upper bound ([journal 50](50-decision-evals.md)).
- **Topics up front.** The owner should be able to write in Email before anything is posted there, so all three topics are now created at startup.
- **Tested:**
  - `tests/topic-routing.test.ts`:
    - which messages are eligible (Email only; no images, long messages, background work or unavailable agent);
    - an end-to-end turn in which the email agent runs before Chief's single model call, `agent_run` is journaled as a successful call, and `route.first_call` is recorded;
    - a General message on the next turn takes the ordinary path.
  - `tests/telegram-topics.test.ts`:
    - topics are created up front and threads map back to topics;
    - inbound messages record `topic` in the input metadata.

- **Independent review (Opus 5.5): approved.** Fixed before merge:
  - if newer input is absorbed before the first step, the step is dropped, so the email agent never works on a superseded message (covered by a test that fails without the fix);
  - messages under three words take the ordinary path, and the docs now state the trade-off for small talk;
  - the synthetic message has `content: null`, matching what the model adapter produces;
  - `file` mode keeps the topic hint;
  - one topics helper is shared by the inbound handler and scheduled sends.

## Verification and outcome

Typecheck and the full suite pass.

### Release closure, phase 1 — 2026-10-01

[PR #135](https://github.com/akhilvuputuri/chief-agent/pull/135) merged as `03a1ef4e09b92a61a2a0a663ea143d03bc28add7`. Release run 36857469977 succeeded. CloudWatch shows the gateway logging that commit from 11:48 UTC, with no warn or error lines in the following minutes. No topic had been created yet, because phase 1 creates each topic on its first send.

Live acceptance after deploy:

1. The next news bulletin creates a **News** topic and appears in it.
2. A message typed in that topic is answered there.
3. A message typed in General is answered in General.

## Follow-up and next iteration

- Phase 2 live acceptance: a question typed in the Email topic is answered there, and its run shows `route.first_call`.
- Widen first steps to other topics only if the routing shadow data supports it.
- Possible further topics: Jobs or background results.
- After 1–2 weeks, check whether the owner mutes topics and whether General feels cleaner.
