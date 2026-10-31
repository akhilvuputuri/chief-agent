# Roadmap

This page records direction, not commitments. The original 0.1–0.5 plan was written before the release numbering it shares; releases now follow [docs/releases.md](releases.md), and [current work](current-work.md) is the live status. Daily use decides what comes next.

## Delivered since the original plan

- **Reliable daily use.** Durable inbox and Telegram outbox, idempotent mutations, uncertain-write pauses, per-task allowances, history recall and sanitized operational logs ([reliable execution](reliable-execution.md), [authoritative storage](authoritative-storage.md), [operational logs](operational-logs.md)).
- **Coordinator and agents.** Plugin-defined specialist agents with validated reports, and remote MCP connectors ([agents](agents.md), [plugins](plugins.md), [MCP](mcp.md)).
- **Domains.** Calendar drafts, parcels, responsibilities, routines, subscriptions and invoice gathering, IBKR holdings and order drafts, stock alerts and rules, the news bulletin, Singapore data and job alignment.
- **Clients.** Telegram topics, interactive views and the authenticated read-only Mini App with canvases ([telegram views](telegram-views.md), [canvases](canvases.md)).
- **Isolated execution.** Owner-controlled invoice browsing in a separate container, and owner-approved coding in disposable EC2 boxes ([gathering](gathering.md), [boxes](boxes.md)).

## Open directions

- **Owner acceptance.** Several released features still wait for a real-use check; each one is listed in [current work](current-work.md).
- **Boxed sub-agents.** Warm box reuse, owner steering of a running box, then further profiles such as analysis and crawling ([boxes](boxes.md)).
- **Memory.** Evaluate mail recall ([mail recall](mail-recall.md)) and the nightly learner ([learning](learning.md)); add owner review, export and erasure of memories and history ([security](security.md#persistence-and-privacy)).
- **Money.** Subscription facts from email, responsibility adapters and merchant cancellation handoffs ([subscriptions](subscriptions.md)).
- **Library.** Account borrowing and holds, once provider API access allows them ([library](library.md)).
- **Web/PWA.** OIDC authentication mapped to the same owner, with SSE progress and approval cards. Telegram and the web client must see the same state, and neither can reach another user's records.
- **Realtime voice.** A separate realtime speech adapter with short-lived client credentials, interruption handling and transcript reconciliation. Consequential actions still need a visual or deterministic confirmation, and an interruption must never approve, duplicate or partially submit an action.

## Evaluation before marketing claims

Create a versioned scenario set: save an unfamiliar role, compare sparse evidence, recover from a provider failure, retain preferences across restarts, refuse cross-user access, resist instructions embedded in listings, and require approval on deletion. Measure task success, unsupported claims, tool correctness, latency and cost per scenario across repeated runs. Publish actual measurements with model/configuration and failure examples. Do not describe mocked test results as agent-quality evaluations.
