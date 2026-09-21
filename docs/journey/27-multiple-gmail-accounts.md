# Separate read-only Gmail accounts

## Problem and preceding iteration

[Authorization recovery](26-google-authorization-expiry.md) renewed the primary mailbox and securely saved a second authorization. The running app still accepted one mailbox, so the second consent alone did not enable searching it.

## Decision and implementation

Keep existing primary behavior and add an explicit optional second account. A discovery tool supplies the actual account mapping to the model; every search/read/thread call can select that account. Credentials and caches are isolated, each token refresh verifies mailbox identity, and both accounts share the existing request allocation. Unknown accounts fail rather than reading an unintended inbox. Results and success receipts identify their mailbox. For both accounts, the model makes separate calls; there is no hidden fan-out or silent partial success.

## Validation and boundaries

Mocked regressions exercise default selection, account discovery/owner isolation, equal message IDs in different accounts, search-cache and pagination isolation, shared request limits, mismatched identities, unknown accounts, and rejected credential injection/write operations. Existing Gmail tests remain applicable. End-to-end conversational choice still depends on model behavior: preserve account provenance in every follow-up call. Existing scheduled briefings use primary only. Gmail itself needs no data migration. No sending, account self-service or change to Calendar/Sheets permissions.

Candidate v0.3.19; independent review, CI, release and bounded production smoke checks remain pending. See [configuration and operator rollout](../google-authorization.md#multiple-read-only-mailboxes-v0319).

## Review correction

The first independent review rejected the rollout: `.env` alone does not populate the gateway's explicit Compose environment. Added both mappings. Operator inspection also found that main had an unapplied stock-watchlist migration, explaining the earlier automatic-release refusal. Reconciled the existing reviewed rollout with the exact live app-only baseline and the additional Gmail mappings; historical migrations and all other Compose bytes remain guarded. This prerequisite installs additive tables only, without configuring stock monitoring. Offline rollout tests cover the added baseline and retain failure/rollback checks.

## Verified release — 21 September 2026

[PR #70](https://github.com/akhilvuputuri/companion-agent/pull/70) passed both CI runs and independent GPT-6 Astra re-review at `9cc415f948bbd71779dc0c60efe80466810749d0` after the deployment correction. Full local checks passed (340 application tests, 2 script tests), as did 34 focused Gmail tests and 14 guarded-rollout tests. Formatting passed.

The reviewed operator procedure deployed `452b4fd7c26946639a63d3199ea094bc2a737ef1`, reported healthy, and verified migration marker18. Both mailboxes then passed a bounded search (up to ten results each) and identity verification using the deployed Gmail implementation; no message content or credentials were printed. This confirms tool access, not model interpretation of every conversational request. No market-data provider or stock alert was configured. Published [v0.3.19](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.19) records this operator release separately from the earlier failed automatic release.
