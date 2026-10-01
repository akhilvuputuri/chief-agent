# Topics in the private chat

General is the default input surface. News, Markets and Updates are outbound feeds; a follow-up typed in a feed is still answered there. Chief keeps one shared conversation and memory. Topic routing is deterministic host code, not a model classifier or instruction pack. See [issue 137](https://github.com/akhilvuputuri/chief-agent/issues/137) and [journal 53](journey/53-feed-destinations.md).

## Destinations

| Output                                                          | Destination                                |
| --------------------------------------------------------------- | ------------------------------------------ |
| Foreground progress, answer, views, voice and its own approvals | Initiating input's thread                  |
| Owner-started work, including later background passes           | Saved origin thread                        |
| Unprompted routine/background answer                            | Updates                                    |
| Unprompted questions, approvals, failures or budget stops       | General, with source label                 |
| Approval cards from other runs                                  | General                                    |
| News edition                                                    | News                                       |
| Stock alert                                                     | Markets                                    |
| Reminders, daily briefing, operations notices                   | General                                    |
| Slash-command response                                          | In place                                   |
| Unknown thread                                                  | Reply in place; no implicit domain routing |
| Unusable thread                                                 | General                                    |

`src/delivery-routing.ts` owns the policy. `Delivery.reason` and transport metadata are host-only; the strict model answer schema rejects them. The stop reason is copied from execution, with pending approvals taking precedence. Routines should end with `awaiting_user` when they require an owner decision; the ordinary finish tool already supports it.

Each input records its raw `threadId`. `work_start` captures an owner origin from authenticated input records in `work_tasks.delivery_context`; model arguments cannot select it. Unprompted tasks have no owner origin. Legacy tasks default to General for unknown origin; routine occurrences are identifiable from existing records. No old task is automatically resumed.

## Queueing and delivery

One foreground execution queue remains shared per owner. Contiguous ready follow-ups in the same thread can join at checkpoints. A cross-thread input waits for the next turn and is a FIFO boundary: later same-thread input cannot skip it. Delivery fences compare revisions within the originating thread, so unrelated input does not suppress an answer. Attachment preparation retains ordering and cancellation remains explicit.

Foreground progress looks up the actual run origin; a waiting Telegram handler may not own the queue's first input. Text, views and voice use the actual delivered thread. A non-General final response arriving over 60 seconds after intake also sends one pointer in General, deduplicated by run. The pointer itself is not a new conversation request.

Owner work results use `work_deliveries`; routine results retain `routine_deliveries`. Both use pending → sending → sent/uncertain. Destination is stored with the payload before sending; a restart never executes work again to recover a send. A `sending` record recovered after restart becomes uncertain and is not automatically replayed. Feed destinations are likewise saved in edition/alert payloads at creation. Legacy pending payloads without a destination retain their prior default.

Approval dispatch is serialized per owner and atomically claims each card before sending. Current run-family cards follow the turn; leftovers go to General. A send with an unknown outcome stays claimed for inspection. Approval delivery is separate from authorization: clicking the existing approval button remains required for the external action.

## Topic lifecycle

In BotFather's Mini App, enable Threaded Mode and Disallow users to create new threads. General is addressed by omitting `message_thread_id`; the special id 1 is not sent. Keep General unmuted for decisions; the bot cannot see client-side mute state.

`TELEGRAM_TOPICS=auto|file|off` remains compatible. `auto` and `file` now have the same feed behavior; the Email first-step shortcut is retired. The generic runtime `firstCall` hook remains available for future independently validated routing. Production Compose uses the default `auto`; Threaded Mode is the owner control.

At startup News, Markets and Updates are ensured. If a recorded Email topic exists, it is renamed Updates in place, preserving any messages. Deleting a topic deletes its messages too, so retirement never silently deletes it. Unknown/old thread IDs are accepted as ordinary input and answered in place.

A missing feed topic is recreated once and its next post carries a notice explaining how to stop the feed. A rejected/closed thread falls back to General. Only a definite topic-related rejection is retried; transport failures with uncertain acceptance are not retried. Stored intended destinations remain intact while actual destinations are recorded at send time.

## Migration 022 and release

Migration `022_telegram_delivery.sql` adds task delivery context, an ordinary work delivery outbox, a message-reference index and slow-pointer deduplication. It preserves all existing tasks, messages, approvals, schedules and records. Compose adds only the new migration entry. Normal automatic release refuses this schema/Compose difference until operator installation.

`scripts/deploy-topics.py` is the one-time reviewed operator rollout. Its baseline is `a9fd27617a3abd74b999ef4ad6874a2e5b554d56`, verified by private CloudWatch on 1 October. Recheck server RELEASE before execution; a different baseline requires reconciliation and review. The procedure checks exact archive identity, unchanged historical migrations/release handler and the single expected Compose addition. It builds first, waits for idle execution and intake, stops the gateway, applies additive SQL, verifies marker 22, starts the image and verifies health. On failure it restores the prior application/source/Compose; the additive schema is retained. It neither cancels nor replays owner work.

Run offline rollout tests with `python3 scripts/test-deploy-topics.py`. Once independently approved and merged, create `git archive` for the exact merge, transfer it and the reviewed script through the pinned Lightsail operator connection described in [lightsail.md](lightsail.md), and run:

```sh
sudo python3 /tmp/deploy-topics.py /tmp/topics-release.tar FULL_REVIEWED_MAIN_SHA
```

After installation, verify exact RELEASE, health, migration marker and fresh private telemetry. Dispatch/watch the normal release for that same commit to verify subsequent automatic releases accept the installed baseline. Startup health is separate from owner Telegram acceptance.

## Validation

Tests cover destination policy, cross-thread queue/FIFO behavior and delivery fences, same-thread checkpoint wakeup races, owner isolation, captured work destinations and uncertain-send recovery, topic lifecycle and approval placement. Live acceptance should exercise General and feed-topic input, one own approval plus unrelated leftover, a delayed reply and an actual scheduled feed. No synthetic alert is sent to the owner as routine verification.

## Feed reference resolution

Successful News, Markets and work/routine posts record `telegram.feed_sent` with actual Telegram message/thread identity and their edition, alert or run ID. Legacy pending editions/alerts obtain their reference from the claimed outbox row, not from an optional payload field. There is no invented historical backfill.

At ingestion, an explicit reply is resolved against owner-scoped sent records at any age, with `sentAt` for age. Unresolved replies use a bounded quoted-text fallback, labelled as incomplete untrusted content. Topic-creation service messages never become explicit references. Telegram documents `reply_to_message` for the same chat/thread and `external_reply` for other topics; original chat/message IDs in `external_reply` are documented only for supergroups/channels. Cross-topic private-chat payloads therefore get exact identity only when actually supplied, otherwise an available quote; the host never invents an original ID.

A General turn receives a recent-feed index of titles, IDs and timestamps, bounded to 24 hours, 15 lines and 3,000 characters. `feed_read(kind,id,offset)` reads the exact owner-scoped saved edition, alert or queued update in 8,000-character pages. Reading stored content does not run another search or authorize an action. Source text stays labelled untrusted.

Only known feed topics receive implicit anchors, labelled potentially unrelated: the newest News/Updates post under 24 hours, or up to five Markets alerts under six hours and within 15 minutes of the newest. Anchor identity and titles are frozen in input metadata before voice/photo preparation and survive checkpoint absorption. Each turn carries bounded per-input reference packets, so multiple old explicit replies absorbed at one checkpoint keep their identities. `conversation_read(inputId)` reads the original input and full frozen anchor when packet quotes are shortened. Stored user messages are atomically linked to inputs by identity during append, so removing superseded assistant messages cannot shift references. The bounded exchange index includes thread identity and input-specific feed references. `pendingReply.askedIn` and `lastExchangeHere` make thread-local follow-ups distinguishable from the shared global history. No separate memory store or routing model call is introduced.

Private CloudWatch records structural feed-send/reference-resolution events, never titles, quoted text or content. Exact content remains in owner-scoped Postgres records. Forwarded external references without verifiable identity remain deferred.
