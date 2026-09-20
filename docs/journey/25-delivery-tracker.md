# 25 — Which delivery facts should survive a conversation?

Work date: 20 September 2026. Status: implementation candidate; independent review and deployment pending.

## User-visible problem and preceding iteration

[Issue #64](https://github.com/akhilvuputuri/companion-agent/issues/64) requests durable delivery tracking from explicitly requested mail searches and conversational user updates. The [mailbox-search iteration](23-gmail-search.md) made bounded email discovery more useful, but search results and conversation context do not represent a persistent physical parcel. The [plugin iteration](15-portable-plugins.md) provided isolated public research; it did not authorize private mailbox access.

## Evidence and diagnosis

**Reported requirement:** track several shipments from one order, retain later corrections and distinguish sender-reported arrival from confirmed receipt. **Design decision:** separate parcel identity, immutable source snapshots and append-only decisions. A tracking reference with a carrier can identify a shipment; an order number or product label alone cannot reliably do so.

Giving a public specialist unrestricted Gmail search would enlarge its permissions and obscure scope. The chosen private contract receives exact current-turn search targets and only supports reads of those messages. It returns quoted proposals; the coordinator performs owner-scoped, revision-checked writes. This preserves the existing permission boundary while adding private source handling.

## Implementation and review

See [behavior/storage contract](../parcels.md), [operator rollout](../parcel-rollout.md), [parcel domain](../../src/parcels.ts), [extractor](../../src/parcel-extraction.ts) and [plugin package](../../plugins/parcel-extraction/plugin.json).

Synthetic testing first exposed two integration errors: an optional result envelope was mistaken for a wrapped result, and page validation assumed decoded journal arguments although the real runtime stores raw tool-call text. The extractor now unwraps only an actual result member and selects successful host-produced page identities. The integration suite exercises the real assistant loop so direct helper tests cannot hide those boundaries.

The additional schemas also exposed a continuity regression: when fixed context exceeded the optional-history allowance, saved-answer retrieval pointers disappeared. Four recent host-shaped answer references now survive optional-history eviction, still subject to the final serialized hard limit. The existing saved-answer regression test exercises this foundation fix. Parcel guidance stays in the loadable personal-assistance skill to limit fixed instructions.

Independent review has not yet approved a final SHA. The final review verdict and exact revision belong on the PR; no self-approval or CI-only approval is implied here.

### 20 September: confirmation-field review correction

The [independent reviewer](https://app.devin.ai/sessions/48e6bad842ad401aa70a4243cea2a7bf) returned **REQUEST CHANGES** for `eac8d3384e88d0aa395c6caf8829d9cc1eb12b1e`, compared with base `25aa0e33af9f620b27b29f98f07d0978d4d165cb`. The reviewer ran in explicitly selected Devin Ultra mode; the underlying model identifier is not exposed, so no GPT-6 Astra claim is made.

**Synthetic finding:** confirmation protected status but left accompanying receipt facts, such as `deliveredAt`, open to newer email claims. That could change the receipt date while retaining the user-confirmed delivery basis. Confirmation now protects every supplied field, while explicit user corrections can still replace it. The regression test first reproduced an incorrect `applied` decision, then passed with `conflict`, preserving the confirmed date and provenance and recording the rejected decision. All 15 parcel/extraction tests passed after the fix. Updated-head review is required; no live acceptance or rollout follows from this correction.

### 20 September: PR comment regressions

Three additional automated review findings reproduced under PGlite: a duplicate source with a new request key returned obsolete parcel state; a partial ETA change could invert the saved range; and an unacknowledged `parcel_report` was classified as an interrupted read after restart despite durable proposals. New source-duplicate responses now read current state while exact request-key replays retain their original results. ETA validation covers the merged parcel. Reports are journaled as writes, preserving uncertainty and preventing transient-read retries.

The fourth comment, that carrier exceptions permanently prevent recovery, did not reproduce: the existing rank comparison defaults the previous status to zero, not infinity. A regression test verifies newer transit and delivery reports can leave an exception while delivered status remains protected. No status-transition implementation change was necessary. All 19 parcel/extraction tests passed after these corrections.

## Verification and outcome

**Synthetic tests:** owner isolation, restart-style service reconstruction, idempotency, multiple shipments per order, ambiguity without mutation, stale/unknown facts, confirmation/correction, archive history, failed transactional writes and migration reruns. Private extraction tests cover actual runtime tool access, selected sources, page-level evidence, partial coverage and unavailable Gmail. Existing research/plugin/Gmail suites remain regression coverage for public permissions, pins, revocation and budgets.

**Verified locally on 20 September 2026:** `npm run check` passed 315 application tests and two scope-script tests on `30c387d55a4159157d54ee955e77f52503c44595`; `npm run build` and `npm run format:check` passed. These are synthetic PGlite/mocked-provider checks, not semantic acceptance.

**After the review correction, 20 September 2026:** `npm run check` passed 316 application tests and two scope-script tests; `npm run build` and `npm run format:check` passed. No paid evaluation or live provider access was used.

**After PR comment corrections, 20 September 2026:** `npm run check` passed 320 application tests and two scope-script tests; `npm run build` and `npm run format:check` passed.

**UI acceptance attempt:** the independent testing agent reached the Telegram login screen, but no authenticated test conversation, test runtime/bot/model configuration or test Gmail authorization was available. All parcel UI flows remain untested. No production polling or paid model call was attempted.

**Pending:** independent final-head review of [PR #66](https://github.com/akhilvuputuri/companion-agent/pull/66). **Not measured:** real email interpretation quality, live mailbox coverage, Telegram phone acceptance or cost improvements. **Not deployed:** migration 019 and gateway release require the reviewed operator procedure; production state has not been inspected or changed for this task.

## Follow-up

After review, record exact-SHA approval, operator migration verification and deployment health before publishing a release closure. Carrier integrations, automatic refresh, notification scheduling and a dedicated parcel browser are deliberately outside this on-demand feature.
