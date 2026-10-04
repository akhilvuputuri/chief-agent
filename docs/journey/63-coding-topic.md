# 63 — Coding progress has a topic; key updates return to Chief

Work date(s): 2026-10-04. Status: v0.3.40 reviewed, deployed and separately verified at `1975525`. Live coding remains off.

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

The reviewed notification release is verified below. Sandbox activation still needs scoped CodeBuild credentials/project, repository-only GitHub App and authenticated HTTPS worker ingress; flipping the switch alone cannot supply them.

## Release closure — 4 October 2026

GPT-6 Astra APPROVED exact head `5c0cc778902ca8797a9ae41f9cf2679b909a5a67` after independently passing 77 routing/feed/topic/controller/confirmation tests, typechecks/format/diff checks and additional failure scenarios: restart after an unknown rename acknowledgement without duplication, closed-topic fallback and queued background redirect without changing owner origins. The reviewer verified the official Telegram rename contract, confirmation receipt fences and preserved explicit historical references; it did not access production or run paid tests.

[PR #167](https://github.com/akhilvuputuri/chief-agent/pull/167) passed [exact-head CI](https://github.com/akhilvuputuri/chief-agent/actions/runs/37169120038) and merged at `1975525a7b5dd00b76c803d065cf2847298acbfb`. [Main CI](https://github.com/akhilvuputuri/chief-agent/actions/runs/37169429003) passed, including worker isolation/cleanup, browser sandbox and PostgreSQL gathering interleaving checks. The [normal release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37169850070) recorded a successful exact-commit receipt at 2026-10-04T02:05:03Z.

Separate bounded production reads confirmed matching server RELEASE, healthy gateway/Postgres, migration 28 and unchanged Python squad image/models/allocations. A structural comparison of the Updates ledger before deployment and Coding ledger after deployment confirmed the same owner/thread identity; the Coding marker is recorded only after the successful Telegram edit acknowledgement. The release record contains only structural comparison results, with no raw owner/message identifiers or private content. No synthetic chat message was sent. This verifies the actual startup rename and thread preservation, not future notification quality.

Immutable [v0.3.40](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.40) targets that verified merge. Coding stays off with zero jobs and missing project/App/auth/origin/scoped AWS configuration. A bounded `chief` operator-profile STS identity check also failed; this is not a proof of account-wide permissions and no credentials/error payload were exported. Provisioning/login/App/ingress activation remains unfinished. No paid sandbox/model job, user-work cancellation, data reset or paused-task resumption occurred.
