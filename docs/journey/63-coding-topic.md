# 63 — Coding progress has a topic; key updates return to Chief

Work date(s): 2026-10-04. Status: v0.3.40 candidate; checks, independent review and exact release pending. Live coding remains off.

## Preceding iteration and requirement

[Journal 53](53-feed-destinations.md) put unprompted answers in Updates. [Journal 61](61-coding-squad.md) installed a fixed Python squad, default off until scoped provider setup. The owner requested replacing Updates with Coding and receiving key updates in Chief's main channel. This changes notification routing, not sandbox activation.

## Evidence

Fresh main `9dc06c05bea4caaa2dd776c653444f9f7c34b92e` includes the invoice gathering release; the isolated routing branch preserves it. Doctor verified GitHub repository read/write and Actions-read access. A bounded production read matched server RELEASE `9dc06c0`, coding off, and absence of all required coding project/App/auth/origin/commit/scoped AWS environment fields. Only presence booleans were read; credentials/private content were not exported. Startup cannot enable coding without this configuration. No paid project, model job or privileged account expansion was attempted.

## Change and boundaries

The stable Updates ledger/thread is retained and renamed Coding in place; old messages and owner origins survive. The older Email fallback is adopted without deleting content. News/Markets keep their feeds. Validated worker milestones route to Coding; requirements/buttons, questions, pauses/failures/cancellations and draft PR completion route to General. All unprompted work/routine answers and responsibility findings now go to General, including queued legacy background destinations. Owner-started noncoding work preserves its initiating thread. Exact saved historical Updates references remain readable, but Coding receives no implicit Updates anchor.

Requirement confirmation keeps the same owner, receipt, revision/scope/artifact and expiry fences. Topic rejection falls back to General; unknown sends remain uncertain. No migration, Compose/image change, paused-task resumption, secret change or live coding activation is required. The existing squad models/allocations and provider price ceilings remain unchanged.

## Verification and outcome

Regression coverage exercises rename retry after unknown acknowledgement without duplicate topics, stable thread reuse, retired queued targets, General background routing versus owner origins, strict milestone routing, and General requirement delivery while preserving confirmation. Existing feed references and coding/queue/outbox tests remain part of the offline check suite. Local full checks passed: 732 application tests, 50 script tests, 30 existing Python and 29 coding-runtime tests, plus strict typechecks/build/format. Independent review and exact release remain pending; synthetic tests do not establish paid sandbox acceptance.

## Next iteration

Complete checks and independent exact-head review, merge and verify the normal exact release. Verify the stored topic ledger after startup rename without sending synthetic messages. Sandbox activation still needs scoped CodeBuild credentials/project, repository-only GitHub App and authenticated HTTPS worker ingress; flipping the switch alone cannot supply them.
