# 53 — One input surface, deterministic feed destinations

Work date: 1 October 2026. Status: stage A released as v0.3.29; stage B implementation/review candidate.

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

## Independent review follow-up

The first review requested changes after reproducing a slow-attachment/cross-thread queue gap, supersession during an approval claim, definite Telegram rejection leaving a card permanently claimed, a slow pointer announcing a withheld answer, and an operator build missing its release identity. Fixes add draining handler slots, a post-claim freshness check, definite-rejection recovery with flood-control delay while unknown sends remain uncertain, pointer gating on actual answer-send evidence, and `RELEASE_SHA` in the operator build. Dedicated regressions cover the reproduced failures. Re-review and release remain pending.

## Stage B — exact references, bounded discovery and shared continuity

The first stage establishes destinations; the second makes delivered feed items discoverable from General and referenceable from explicit replies. Each successful feed post records the Telegram message ID plus exact owner-scoped source ID. Input anchors are frozen at intake and carried through preparation/steering. General receives a titles/IDs-only recent index capped at 15 lines/3,000 characters; `feed_read` pages original saved content. Implicit topic context obeys explicit freshness and clustering limits and is labelled potentially unrelated.

Thread-tagged exchange indexes, pending questions carrying `askedIn`, and `lastExchangeHere` preserve one shared memory while exposing conversational provenance. The host ignores topic-creation notices and labels unresolved quoted replies. Telegram's documented cross-topic private-reply identity limits are recorded instead of promising IDs the API does not supply. Structural send/reference logs are queryable in private CloudWatch without copying source content.

Focused tests cover exact old replies, cross-owner rejection, bounded quotes/indexes, frozen anchors despite later editions, exact saved reads without web lookup, thread-local pending questions, and fresh alert clusters. Full checks, independent stage-B review and release remain pending at this checkpoint.

## Stage A release closure — 1 October 2026

[PR #138](https://github.com/akhilvuputuri/chief-agent/pull/138) passed independent GPT-6 Astra review after the failure/re-review loops above, with final approval on exact head `2724d31cc44b893981ebb8754a48e39739ac18dd`. A further correction bounds delivery fences and budget-failure parking at cross-thread FIFO boundaries, so General → News → General does not suppress the first independent answer. The final reviewer independently passed 62 focused tests, and 14 offline operator tests passed. Full local checks and required CI passed.

The reviewed migration-022 operator procedure installed exact merge `015b8a99d770977ada6035c3feed4b9bbdd7226d` from its pinned baseline. Separate reads verified the migration marker, server RELEASE, gateway health, Updates topic record and unchanged aggregate role/memory/task/approval counts. The [normal release](https://github.com/akhilvuputuri/chief-agent/actions/runs/36872648089) also passed for that exact merge. [v0.3.29](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.29) labels this verified milestone. Owner Telegram acceptance and stage B remain separate.

## Stage B review follow-up

The first independent review reproduced loss of earlier old-feed anchors in a batched checkpoint, shifted historical anchor assignment after superseded finals were removed, and an implicit topic reference pointing to a newer post actually delivered in General. The fixes carry bounded per-input references with an owner-scoped original-input reading path, atomically bind each stored user message to its input identity rather than guessing offsets, and filter implicit candidates by their actual sent thread. New regressions reproduce each failure. Re-review remains pending at this checkpoint.
