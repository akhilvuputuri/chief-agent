# Separate read-only Gmail accounts

## Problem and preceding iteration

[Authorization recovery](26-google-authorization-expiry.md) renewed the primary mailbox and securely saved a second authorization. The running app still accepted one mailbox, so the second consent alone did not enable searching it.

## Decision and implementation

Keep existing primary behavior and add an explicit optional second account. A discovery tool supplies the actual account mapping to the model; every search/read/thread call can select that account. Credentials and caches are isolated, each token refresh verifies mailbox identity, and both accounts share the existing request allocation. Unknown accounts fail rather than reading an unintended inbox. Results and success receipts identify their mailbox. For both accounts, the model makes separate calls; there is no hidden fan-out or silent partial success.

## Validation and boundaries

Mocked regressions exercise default selection, account discovery/owner isolation, equal message IDs in different accounts, search-cache and pagination isolation, shared request limits, mismatched identities, unknown accounts, and rejected credential injection/write operations. Existing Gmail tests remain applicable. End-to-end conversational choice still depends on model behavior: preserve account provenance in every follow-up call. Existing scheduled briefings use primary only. No data migration, sending, account self-service or change to Calendar/Sheets permissions.

Candidate v0.3.19; independent review, CI, release and bounded production smoke checks remain pending. See [configuration and operator rollout](../google-authorization.md#multiple-read-only-mailboxes-v0319-candidate).
