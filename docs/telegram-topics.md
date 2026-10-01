# Topics in the private chat

Telegram's threaded mode (Bot API 9.3 and 9.4) adds topics to a bot's private chat. Chief uses it in two ways. Scheduled output goes to its own topic. A message typed in a topic is answered in that topic. General stays the main conversation, and Chief keeps one shared conversation and memory across all topics.

This is phase 1. A topic does not yet change which agent handles a message. That is phase 2; see [journal 52](journey/52-telegram-topics.md).

## Setup

In the @BotFather Mini App, open My bots → Chief → Bot Settings → Threads Settings, and turn on both:

- **Threaded Mode.** Turns topics on.
- **Disallow users to create new threads.** Without this, every message the owner types outside a topic creates a new topic.

The `/mybots` text menu does not show these switches. They are only in the Mini App.

`TELEGRAM_TOPICS` defaults to `auto`, which uses topics only when `getMe().has_topics_enabled` is true. `off` sends everything to General without changing BotFather. Production Compose does not pass this variable yet, so production always uses `auto`. There, the switch is BotFather's Threaded Mode.

## Behaviour

| What                                       | Where it goes                                            |
| ------------------------------------------ | -------------------------------------------------------- |
| Daily news bulletin                        | **News** topic                                           |
| Stock price alerts                         | **Markets** topic                                        |
| Reply to a message typed in a topic        | Same topic, including progress, views and approval cards |
| Reply to a message typed in General        | General                                                  |
| Daily briefings, routines, background work | General (unchanged)                                      |

- **Topic creation.** Chief creates each topic the first time it sends there, then records the thread id as a `telegram.topic` event. No migration is needed: each owner and topic has a stable run id, so the lookup uses the existing run index, and the newest row wins. Concurrent first sends share one creation.
- **Deleted topic.** If the owner deletes a topic, the next send fails with "message thread not found". Chief then records the id as gone (a row with a null `threadId`), creates the topic again and retries that send once. No other error is retried.
- **Falling back to General.** Sends go to General in any of these cases: threaded mode is off, `TELEGRAM_TOPICS=off`, the threaded-mode check fails (it is retried on the next send), or creation fails. A topic never blocks a delivery.
- **Addressing General.** Telegram rejects `message_thread_id=1`, so `inThread()` leaves the id out for General.

## Code

- `src/telegram-topics.ts`:
  - `TelegramTopics` handles the threaded-mode check, creates topics once and recovers deleted ones.
  - `inThread` turns a thread id into send options.
  - `threadOf` reads the thread from an inbound message.
- `src/telegram-views.ts`: `open` and `deliver` take a `Chat`, which is either a chat id or `{ id, thread }`. Every message part, the canvas buttons and the notices go to that thread. A view's callback binding still uses only chat and message id.
- `src/telegram.ts`: the message handler passes the thread of the inbound message to views and approval cards. grammY's `ctx.reply` and `replyWithChatAction` already add the thread for topic messages. `telegram.input_ready` records `inTopic`.
- `src/main.ts`: the news bulletin and stock alerts send through `topics.send(user, "news" | "markets", …)`.
- Tests: `tests/telegram-topics.test.ts`.

## Operations

These ops-log events carry only the topic key (`kind`) and error codes:

- `telegram.topic_created`
- `telegram.topic_failed`
- `telegram.topic_missing`
- `telegram.topics_check_failed`

Rollback: turn off Threaded Mode in BotFather (production), or set `TELEGRAM_TOPICS=off` where the variable is passed. Existing topics and their messages stay in Telegram.
