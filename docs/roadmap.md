# Roadmap

## 0.1 — Foundation (this repository)

Telegram text/voice; Hermes runtime boundary; roles, preferences and conversations in Postgres; tool events; exact-action deletion approvals; hosted search/page reading; local checks and Compose.

## 0.2 — Reliable daily use

- Durable inbox, resumable run queue, idempotent tool mutations and Telegram reply outbox. Acceptance: kill a worker after a save and recover without duplicating the role or silently losing the reply.
- Per-user budget, queue depth and rate limits. Acceptance: request bursts remain bounded and limit messages explain recovery.
- Summaries with provenance, paginated role listing, user memory review/edit/export/erase. Acceptance: a long conversation preserves explicitly stored facts while keeping context bounded.
- OpenTelemetry spans, latency/token/cost metrics and safe diagnostic categories. Acceptance: locate the failing dependency without logging user text or credentials.

## 0.3 — Stronger job-search domain

- Structured profile/CV import, evidence-backed fit analyses saved with role/profile versions, and source timestamps.
- Deduplicate role URLs and detect changed/closed listings. Add test fixtures for ambiguous locations, missing salary and outdated evidence.
- Draft outreach and application materials with explicit provenance. Keep sending disabled until a scoped connector, payload preview, approval consumption, idempotency and reconciliation are implemented together.
- A Playwright/CDP worker for JavaScript-heavy pages only after network isolation and read-only browsing policy are tested. Keep authenticated browser actions separate from page extraction.

## 0.4 — Web/PWA

OIDC authentication → internal user mapping → shared application service. Add durable run IDs, SSE progress, approval cards, role views, voice-note recording and accessible responsive layouts. Never put server keys or run capabilities in browser storage. Acceptance: Telegram and PWA see the same state and cannot access another user's records.

## 0.5 — Realtime voice

Add a separate realtime speech session adapter, short-lived client credentials, interruption handling, turn detection and transcript reconciliation. Translate confirmed intents into the same domain tools. Require visual or explicit deterministic confirmation for consequential actions. Acceptance: interruptions cannot approve, duplicate or partially submit an action.

## Evaluation before marketing claims

Create a versioned scenario set: save an unfamiliar role, compare sparse evidence, recover from a provider failure, retain preferences across restarts, refuse cross-user access, resist instructions embedded in listings, and require approval on deletion. Measure task success, unsupported claims, tool correctness, latency and cost per scenario across repeated runs. Publish actual measurements with model/configuration and failure examples. Do not describe mocked test results as agent-quality evaluations.
