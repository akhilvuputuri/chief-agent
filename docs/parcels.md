# On-demand delivery tracking

Implements [issue #64](https://github.com/akhilvuputuri/companion-agent/issues/64). A parcel is a physical shipment, separate from an order, a Gmail message and a research run. Current saved state and its evidence survive conversation resets and application restarts.

## Conversation contract

“What am I waiting for?” uses `parcel_list` locally. “What happened to these headphones?” uses `parcel_read`, with paginated evidence/decision history. The assistant describes last-known saved state, with source dates, and distinguishes email-reported delivery from user-confirmed receipt.

“Find and save my deliveries from email” or “refresh this parcel” permits a bounded foreground Gmail search. The coordinator selects up to six message IDs from current-turn owner-scoped search observations and calls `plugin_delegate` for `parcel-extraction/extractor`. The child receives only those targets, reads bounded pages and returns quoted proposals. The coordinator applies supported proposals with `parcel_apply`; ambiguous results require clarification. Reads are charged to the same Gmail request budget as the parent. An expired authorization or incomplete message does not imply that saved status was checked or change saved state.

`parcel_save` handles current authenticated user facts and explicit corrections, confirmation, dispute, archive and reopen modes. Selected writes require the revision returned by a read. Each claim and intent quote must occur in the current user input; historical messages, email and agent prose cannot substitute. Normal updates omit unknown fields; only an explicit correction can clear with null. Confirm records `user_confirmed` receipt; an email's “delivered” assertion remains `reported`. Confirmation need not invent a delivery date. Disputed deliveries remain in the waiting list. Archive hides without deleting history.

No timer, routine, unsolicited email scan, carrier fetch or alert is installed. Gmail remains read-only. A saved tracking URL is a reference, not authorization to fetch it. No new Telegram command or Mini App screen is required: the existing conversational tools and concise model-written replies provide the interface.

## Identity, chronology and evidence

- Exact carrier plus tracking reference is a strong match. Preserve reference strings, including leading zeros. Order/merchant, label and prior source are candidate signals; similarity alone does not merge shipments.
- Different tracking references in one order remain separate. An order-only update or unresolved tracking match returns candidates without mutation. Explicit user selection is required before applying an ambiguous proposal.
- Each field retains its evidence ID, exact quote, assertion time and protection flag. Missing automated facts cannot erase saved fields; protected user corrections and confirmations resist automated claims. Older, equal-time conflicting, unknown and regressive shipment statuses do not overwrite newer supported state. Accepted/rejected field decisions remain in history.
- Gmail internalDate is a message assertion timestamp, not a guarantee of physical event time. An extractor may provide a supported event time; uncertain ETAs remain source wording. Neither email delivery nor extraction validates a carrier event independently.
- Evidence identity uses the owner, mailbox identity hash, message ID and snapshot hash. Claim fingerprints prevent repeat applications, including two candidates from the same message. The projection, decision event, runtime trace and request result commit together under an owner revision guard.
- A UUID request key binds an exact action payload to its original result. Replaying identical content does not repeat the mutation; changed content rejects. A concurrent write fails without overwriting state: reread and decide again with a new key/revision. No uncertain external action is retried.

## Private extraction boundary

The host contract is `parcel-extraction/v1`; the existing `public-research/v1` contract cannot access it. Registry content pins, owner-scoped definition snapshots, approved private skill overrides, explicit grants and revocation continue to apply. Public and private specialist catalogue entries are filtered independently by web/Gmail capability.

The child gets `parcel_email_read`, `parcel_report`, its assigned `skill_read` and normal finish control. It has no Gmail search, arbitrary source/observation reads, parcel writes, nested delegation or web tools. Each read names an exact assigned message; reports cover the assigned targets exactly once. Quotes must be found in pages actually returned to that child. Complete coverage requires every available page and an untruncated body; partial/blocked claims remain visibly qualified. Report validation creates proposals only, leaving current parcel rows unchanged.

Private email bodies remain in owner-scoped runtime observations/evidence, not portable plugin bundles, reusable skills or public logs. Structural checks establish source presence and access boundaries; they do not prove the model interpreted a quotation correctly. The coordinator must still resolve semantic ambiguity and explain uncertainty.

## Storage and operations

Migration [019](../db/019_parcels.sql) adds `parcel_owners`, `parcels`, `parcel_evidence`, `parcel_events`, `parcel_requests` and indexes. Composite owner/run foreign keys use the unique index installed by migration 012. Historical migrations remain unchanged; 018 is reserved for the separate watchlist work and is not a dependency.

The gateway refuses startup without marker 19. Fresh Compose applies 019 after 017. Existing installations need the [operator procedure](parcel-rollout.md); the ordinary release handler intentionally refuses a DB/Compose change. No release/deployment is claimed by this document.

## Verification

`tests/parcels.test.ts` exercises persistence through reconstructed services, owner isolation, request replay, split shipments, ambiguity, corrections, stale claims, archive semantics, atomic write failure and migration reruns. `tests/parcel-extraction.test.ts` exercises the real mocked assistant/tool loop, private/public grants, assigned-search selection, page coverage, malicious email instructions and provider failure. Existing Gmail/research/plugin tests cover bounded reads, shared execution budgets, cancellation, definition pins and revocation.

Run `npm run check`, `npm run build`, `npm run format:check` and the focused parcel suites. No production credentials or paid model evaluation is needed. Real Gmail extraction quality and Telegram phone acceptance remain separate owner checks after deployment.
