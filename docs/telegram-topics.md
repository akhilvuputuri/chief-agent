# Topics in the private chat

Telegram's threaded mode (Bot API 9.3 and 9.4) adds topics to a bot's private chat. Chief uses it in three ways:

- scheduled output goes to its own topic;
- a message typed in a topic is answered in that topic;
- a message typed in the **Email** topic goes straight to the email agent.

General stays the main conversation, and Chief keeps one shared conversation and memory across all topics. See [journal 52](journey/52-telegram-topics.md).

## Setup

In the @BotFather Mini App, open My bots → Chief → Bot Settings → Threads Settings, and turn on both:

- **Threaded Mode.** Turns topics on.
- **Disallow users to create new threads.** Without this, every message the owner types outside a topic creates a new topic.

The `/mybots` text menu does not show these switches. They are only in the Mini App.

`TELEGRAM_TOPICS` applies only when `getMe().has_topics_enabled` is true:

- `auto` (the default) creates the topics at startup, files scheduled output into them, tells Chief which topic a message came from, and sends Email-topic messages to the email agent first;
- `file` does the same, except for the first step;
- `off` sends scheduled output to General.

Replies always follow the topic of the incoming message. Production Compose does not pass this variable yet, so production always uses `auto`. There, the switch is BotFather's Threaded Mode.

## Behaviour

| What                                       | Where it goes                                            |
| ------------------------------------------ | -------------------------------------------------------- |
| Daily news bulletin                        | **News** topic                                           |
| Stock price alerts                         | **Markets** topic                                        |
| Reply to a message typed in a topic        | Same topic, including progress, views and approval cards |
| Reply to a message typed in General        | General                                                  |
| Message typed in the **Email** topic       | Email agent first, then Chief's reply (see below)        |
| Message typed in News or Markets           | Chief, told which topic it came from                     |
| Daily briefings, routines, background work | General (unchanged)                                      |

- **Topic creation.** Chief creates each topic the first time it sends there, then records the thread id as a `telegram.topic` event. No migration is needed: each owner and topic has a stable run id, so the lookup uses the existing run index, and the newest row wins. Concurrent first sends share one creation.
- **Deleted topic.** If the owner deletes a topic, the next send fails with "message thread not found". Chief then records the id as gone (a row with a null `threadId`), creates the topic again and retries that send once. Concurrent recoveries share one new topic. Any other 400 rejection about the topic, such as a closed topic, retries that send once in General and keeps the stored topic. All other errors are not retried.
- **Falling back to General.** Sends go to General in any of these cases: threaded mode is off, `TELEGRAM_TOPICS=off`, the threaded-mode check fails (a failed check is retried on the next send), the stored id cannot be read, or creation fails. If creation succeeds but recording the id fails, the process remembers the id, so later sends reuse the topic instead of creating a duplicate. A topic problem never blocks a delivery, though errors that are not about the topic (for example, the bot being blocked) still fail as before.
- **Changing the BotFather switch.** An "on" answer from the threaded-mode check is kept until restart. An "off" answer is checked again after ten minutes, so turning Threaded Mode on needs no restart, but turning it off takes effect on the next restart. When it is off, Telegram itself stops showing topics.
- **Follow-ups during a running reply.** If a message joins a run that is already in progress, the answer goes to the topic of the message that started the run.
- **Addressing General.** Telegram rejects `message_thread_id=1`, so `inThread()` leaves the id out for General.

## Topic as the first step (phase 2)

Chief is a coordinator: for a domain request, its first model call usually does nothing but call `agent_run`. For a message typed in the Email topic, the host makes that call itself. The run starts with `agent_run({type: "email", objective: <the owner's message>, context: <topic and previous exchange>})`, and Chief's first model call already sees the agent's report. That saves one main-model call per message that Chief would have delegated anyway. The [decision eval](journey/50-decision-evals.md) priced a saved call at about 4.2 s and $0.02, as an upper estimate.

- **Same record as a model-made call.** The call is journaled like any other (`runtime_calls`, checkpointed history), so approvals, `conversation_read` and later turns see an ordinary delegation. `route.first_call` records that the host made it.
- **Chief still answers.** It writes the reply from the report. Runtime context tells it the topic and that the host started the agent. If the message was about something else, Chief handles it as usual: it can delegate again or answer itself.
- **The trade-off.** A message in the Email topic that needs no email search costs an email-agent run that Chief alone would have skipped. Messages under three words ("thanks!", "ok cool") never take the first step, which removes most of that cost.
- **When the ordinary path is used instead:**
  - the message is in General, News or Markets;
  - it is shorter than three words, or is a photo or document (the email agent cannot read attachments; voice notes become text and qualify);
  - it is an explicit reply to an earlier message, whose target only Chief's context carries;
  - newer owner input was already waiting when the turn started;
  - it is longer than `agent_run`'s 2,000-character objective;
  - it is background work;
  - the email agent is not available in this deployment;
  - `TELEGRAM_TOPICS` is not `auto`.
- **Why only Email.** The News and Markets agents manage bulletin and alert _settings_. Questions typed in those topics, such as "what's this story about?" or "how is TSLA doing?", usually need web lookup, so a direct first step would often be wrong. Those topics only give Chief a hint. The [routing shadow data](journey/51-shadow-decisions.md) can show whether more topics should get a first step.
- **Where the topic comes from.** The inbound handler matches the message's thread to a stored topic id and records `topic` in the input's existing `metadata` JSON, so no migration is needed. A follow-up that joins a running reply does not get its own first step.

## Code

- `src/telegram-topics.ts`:
  - `TelegramTopics` handles the threaded-mode check, creates topics once and recovers deleted ones.
  - `inThread` turns a thread id into send options.
  - `threadOf` reads the thread from an inbound message.
- `src/telegram-views.ts`: `open` and `deliver` take a `Chat`, which is either a chat id or `{ id, thread }`. Every message part, the canvas buttons and the notices go to that thread. A view's callback binding still uses only chat and message id.
- `src/telegram.ts`: the message handler passes the thread of the inbound message to views and approval cards. grammY's `ctx.reply` and `replyWithChatAction` already add the thread for topic messages. `telegram.input_ready` records `inTopic`. The typing indicator is sent with an explicit thread and never fails a turn. grammY's `replyWithChatAction` copies `message_thread_id` even for General messages.
- `src/main.ts`: the news bulletin and stock alerts send through `topics.send(user, "news" | "markets", …)`. At startup, `topics.ensure()` creates News, Markets and Email.
- `src/agent.ts`: `topicFirstCall()` decides whether a turn starts with a host-made `agent_run`, and adds the topic to runtime context.
- `src/custom-agent.ts`: `req.firstCall` replaces the first model call with that tool call, journaled and dispatched like a model-made one.
- `src/telegram-topics.ts`: `topicAgents` maps topics to agent types (only `email` today), and `keyFor()` maps a thread back to its topic.
- Tests: `tests/telegram-topics.test.ts` and `tests/topic-routing.test.ts`.

## Operations

These ops-log events carry only the topic key (`kind`) and error codes:

- `telegram.topic_created`
- `telegram.topic_failed`
- `telegram.topic_missing`
- `telegram.topic_unusable`
- `telegram.topic_record_failed`
- `telegram.topics_check_failed`
- `route.first_call` (with `kind: topic.email`)

Rollback: turn off Threaded Mode in BotFather (production), or set `TELEGRAM_TOPICS=off` where the variable is passed. Existing topics and their messages stay in Telegram.
