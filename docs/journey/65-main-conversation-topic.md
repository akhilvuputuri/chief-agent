# 65 — An explicit Main topic instead of the aggregate All view

Work date: 7 October 2026. Status: released as v0.3.44 on 7 October 2026. Candidate/review observations below are historical.

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

## Independent review follow-up

The first Astra review reproduced a new intake delay that reversed input order, a hidden default-transport topic retry that bypassed approval cancellation, and a receipt claiming a root destination after the wire send used Main. The fixes register pending input before resolving topic identity, retain the original intake-time cutoff for cold-cache anchors, make the transport issue one message attempt with a post-lookup guard, and store returned actual thread identity in messages, views, feeds and approval receipts. Guarded views also propagate their guard through Main resolution. New executable regressions reproduce the cold-start FIFO, lookup/rejection cancellation and actual-receipt cases.

The initial local full-suite run was interrupted when host swap/disk pressure prevented temporary writes; it is not recorded as passed. Focused tests, typecheck, hosted full CI and exact-head re-review are required for release. No production setting or user data was changed during this investigation.

A second review reproduced a closed Main topic being added back to an intentional root fallback. The fix distinguishes intentional root fallback from default routing, rechecks cancellation before any definite-rejection root retry, and carries actual thread identity separately from intended destination (including an actual root send). New tests confirm the Main → root attempts, root receipts and withheld cancellation. Re-review remains required for the final head.

The final review also reproduced a voice fallback sending after cancellation. Foreground voice sends and speech-error notices now propagate their guard through the router, and the committed test uses mocked speech generation with actual handler/transport behavior. Independent Astra review approved final head `d628ec714be2741fa78e55bf63904452317d2f71` after nine focused failure regressions passed. Required hosted CI passed the full 794 application tests, 50 script tests, 30 Python evaluation tests and 32 coding-runtime tests, plus worker, browser-sandbox and PostgreSQL interleaving checks. The initial local full run remains explicitly interrupted; local focused/typecheck/format checks passed.

## Release closure — 7 October 2026

[PR #178](https://github.com/akhilvuputuri/chief-agent/pull/178) merged as `e522f5349af2d7be869bb18bcff2ba0327b06e08` after exact-head Astra approval and passing required hosted CI. [Main checks](https://github.com/akhilvuputuri/chief-agent/actions/runs/37615032704) and [automatic release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37615771842) passed for that merge; the authenticated release receipt and separate server RELEASE/health matched. [v0.3.44](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.44) labels the verified merge without moving an existing tag.

The live bot's read-only `getMe` reported threaded mode enabled; its owner-scoped Main topic record was present. Telegram accepted one introductory message explicitly addressed to Main, with a claimed/sent operational receipt to avoid repeating the introduction. It made zero model calls and left existing history intact. No database/Compose or infrastructure changes were required. The owner's client display and subsequent Main conversation remain acceptance checks; the Mac was locked during UI inspection. All still aggregates the streams.
