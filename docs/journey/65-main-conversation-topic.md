# 65 — An explicit Main topic instead of the aggregate All view

Work date: 7 October 2026. Status: implementation/review candidate, not released.

## Problem and preceding iteration

[Journal 53](53-feed-destinations.md) separated feed destinations and reference identity; [journal 63](63-coding-topic.md) specialized Coding progress. Both assumed topic-less "General" would provide a distinct ordinary conversation in the private-chat client. The owner reported that the visible All tab still includes feed output and has no separate General tab. The earlier terminology hid an actual navigation gap.

## Evidence and diagnosis

Fresh main `af951df49fc4680efc04a0ca822010972d77483e` defines News, Markets and Coding, but no explicit conversation topic. Its general destination sends without a thread. Telegram's client-controlled aggregate view cannot be filtered by the Bot API; separate topics are the supported mechanism. [Official topics](https://core.telegram.org/api/forum), [Bot features](https://core.telegram.org/bots/features#topics-in-private-chats).

This is a presentation/destination defect, not evidence that the shared memory itself is contaminated. Client inspection was unavailable because the owner's Mac was locked; the user report and fresh code establish the missing explicit topic. Live acceptance must check the owner's actual client.

## Change and alternatives

Create Main using the existing owner/topic ledger, preserving News/Coding/Markets. Route logical general destinations to it and default unthreaded sends to Main for allowed private-chat owners, including reminders, approvals, voice and files. Explicit feeds and other thread IDs keep their destination. Normalize ordinary root input to Main before intake so root/Main follow-ups use one execution boundary. Keep one memory/history and preserve all earlier messages.

Changing All's filter was rejected because it is not a bot-controlled surface. Deleting or moving history would neither filter All nor preserve original message identity. Creating a new Main topic avoids conflating the aggregate view with the conversation. No new model calls, schema, infrastructure or access scopes are required.

## Validation and limitations

Focused tests cover explicit Main creation/reuse, stored destination capture, root intake metadata, owner-only default routing across text/voice/file/typing, preservation of explicit feed targets and other chats, definite missing-topic recovery, unknown-send non-retry, threaded-mode-off fallback and no slow pointer inside Main. Full checks and independent review/release are pending at this checkpoint.

All still shows the combined history. Topic delivery failures may fall back to the root; old history is not backfilled. Main is a topic destination, not a separate memory partition. The owner's live client view remains an acceptance check.
