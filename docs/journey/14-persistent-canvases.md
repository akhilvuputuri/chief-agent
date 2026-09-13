# Persistent canvases inside Telegram

Status: implementation candidate, 13 September 2026. Release evidence belongs in the PR and immutable release notes after verification.

## Problem and design

Paginated Telegram messages provide useful quick views but are cumbersome for longer analyses and many saved roles. A single mutable page would also lose earlier topics. Keep conversation and voice in Telegram, and add multiple persistent documents whose structured components are rendered by a small web client.

Each document has immutable revisions with a base-revision check, so refining one topic does not overwrite another and conflicting updates are visible. The agent chooses supported components and natural prose; the frontend does not execute generated code. Postgres remains the source of truth. A separate read-only Roles tab makes existing saved data immediately browsable without regenerating it.

## Implementation and boundaries

The [canvas contract](../canvases.md) documents schema, auth, source provenance, bounded retrieval, tracing and limitations. Signed Telegram launch data is exchanged for a short-lived in-memory bearer session, allowing Telegram Web embedding without depending on third-party cookies. Every read checks the same owner, even when a link is copied. No public tool/write/approval endpoint exists. The runtime retains approval, cancellation and uncertain-write handling.

A single SQL statement commits the head, revision and event. Exact retry keys recover prior results; changed retry payloads and stale revisions are rejected. Migration 011 is additive and leaves the separate memory checkpoint's migration 010 untouched. Caddy exposes only the reviewed static/API paths on the already deployed free hostname.

## Development and verification

Implementation began from current main after the HTTPS and media releases plus the context-limit fix. While tracing delivery end to end, we found that adding a reference to the answer schema alone was insufficient: Assistant's reply projection needed to carry it through to Telegram. Added a model → canvas save → observation → finish test to cover that boundary.

Tests cover persistence, racing/repeated writes, ownership, authentication freshness/tampering, unsupported inputs, public-route boundaries, immutable history, source ID/URL ownership, restart reuse and message links. Browser inspection with synthetic local data verifies all component families, historical revisions and role navigation at phone width. This does not establish real Telegram client compatibility or model answer quality; real-owner launch and first generated canvas remain live acceptance checks. No production documents or credentials are used in fixtures.

The required independent Astra review and exact deployment verification must precede a release claim. The [operator rollout](../miniapp-deployment.md) records migration and ingress installation and how to retain all revisions during an application rollback. Future iterations can use formation/retrieval/view traces to assess whether canvases improve daily use; no UX or cost savings are claimed yet.
