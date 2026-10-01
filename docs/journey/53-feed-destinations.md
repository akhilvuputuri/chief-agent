# 53 — One input surface, deterministic feed destinations

Work date: 1 October 2026. Status: first-stage implementation candidate, not released.

## Problem and preceding iteration

[Journal 52](52-telegram-topics.md) introduced private-chat topics and an Email-topic shortcut. The owner found choosing an input topic burdensome and wanted General as the ordinary conversation, with feeds for unsolicited output. [Issue 137](https://github.com/akhilvuputuri/chief-agent/issues/137) proposes independent destination and reference-resolution mechanisms.

## Evidence and diagnosis

Code inspection confirmed feed sends discarded message IDs and approval dispatch selected every pending unsent card for an owner. A reply delivering in a feed could therefore carry an unrelated approval. Input absorption and the delivery fence were both owner-global: preventing cross-thread absorption alone would still suppress an earlier reply when another thread received input. Routine deliveries were durable, but ordinary work results went directly to Telegram.

These are transport and conversation-boundary defects. A prompt-only topic rule cannot fix them; a classifier would add calls without establishing trustworthy identity or delivery state.

## Changes and alternatives

The host now chooses destinations from execution source, stop reason and authenticated origin. Owner tasks retain their original thread even during background passes; unprompted answers go to Updates and questions/approval requests go to General. Inputs in different threads remain separate serialized turns, with FIFO boundaries and thread-specific delivery fences. Same-thread steering remains supported.

Migration 022 adds origin metadata and an ordinary-work outbox. Routine outboxes are reused. Destinations are captured before sending; uncertain sends remain inspection cases rather than retrying work. Approval cards are atomically claimed and serialized, own run-family cards follow the turn and unrelated cards go to General. Slow replies produce at most one General pointer per run.

Email is retired by renaming its topic Updates, preserving any new messages. Automatic deletion was rejected because Telegram deletes the topic's messages too and the issue's earlier claim that it was empty can become stale. Topic first-step delegation is removed; generic runtime first-call support remains for future routing work.

## Validation and limitations

Focused mocked runtime tests exercise mixed-thread queueing, FIFO boundaries, delivery fences and restart recovery. The unchanged same-thread steering regressions remain part of validation. Full checks, independent exact-head review and operator rollout are pending at this checkpoint; neither package version nor code presence establishes release.

This stage does not yet resolve references to raw feed posts. The second stage records sent feed identities, supplies bounded recent-feed context and an owner-scoped reading path. CloudWatch telemetry describes structural routing outcomes; Postgres remains authoritative for content and actions. No new routing model calls or infrastructure are introduced.
