# 93 — Can one agent fetch invoices and keep the subscription tracker in step?

Work date(s): 2026-10-18. Written/revised: 2026-10-18; release closure 2026-10-19 (SGT).
Status: released as v0.3.83 (deployed `1733d48`). Owner acceptance and model-behaviour measurements pending.

## User-visible problem and preceding iteration

The manual tracker ([journal 54](54-subscriptions.md), v0.3.34) records only what the owner states. Invoice gathering ([journal 62](62-gathering-harness.md), v0.3.39) collects and matches original PDFs but deliberately never touches the tracker. An owner who asks "get my Claude invoices and update my subscriptions" therefore had two disconnected results: files in the Invoices view and a tracker that still showed whatever price they last typed.

The owner asked for the link to run as one subagent whose definition grants both the fetching and the tracking capabilities, with procedure shared between agents through common skills rather than copied into each prompt.

## Evidence

- Tested: the gathering tables already hold everything the link needs: current-scope matches (`gather_items`), per-target typed invoice clues (`gather_candidates.facts`: issuer/product labels, invoice dates, service months, every currency amount found) and a gathering receipt per match.
- Tested: `subscription_updates.source_kind` is constrained to `owner`, but `source_ref` and `field_sources` are free JSON objects. Invoice provenance fits without a migration.
- Measured (offline, 18 October 2026, `runtimeContext` with every integration flag on, coordinator mode, no loaded domains, empty work state): main `a9f4547` offers Chief 14 tools, 6,002 schema characters and 5,089 runtime-state characters (11,091 total), with 14 agents and 6 skills in its catalogues. This branch: the same 14 tools and 6,002 schema characters, 5,860 runtime-state characters (11,862 total, +771), with 15 agents and 9 skills. The increase is the `bills` catalogue entry, three skill catalogue keys and longer gathering/subscriptions descriptions. The four tracker tool schemas offered to the subscriptions and bills agents grow from 4,323 to 5,706 characters (three tools before, four now). Common system instructions are unchanged and excluded. Character inventory, not tokens, latency or cost.
- Deferred: paid picker/model evals and live owner acceptance.

## Diagnosis and alternatives

The safety boundary from journal 54 is that a receipt alone is not an instruction to save. That still holds. What changes is that an owner request to use invoices is an instruction, and the invoice supplies values the host can check.

Alternatives considered:

- **Owner-confirmed proposal card per invoice.** Strongest, but it needs a new approval kind and a second owner tap for something the owner already asked for. Kept as a possible later mode if live use shows wrong amounts being applied.
- **A new `source_kind = 'invoice'`.** More literal, but it needs a migration and the operator procedure, and it would blur who authorised the write. Instead `source_kind` keeps meaning the authoriser (the owner) and `field_sources` marks which fields an invoice evidenced.
- **Host-derived amounts.** Invoices carry subtotals, tax and credits; choosing the recurring charge deterministically from typed clues is not reliable. The agent chooses; the host checks the choice occurs in the document.
- **Extending the existing gathering agent.** Old tasks pin `core/gathering`, and its narrow, files-only contract is useful on its own. A separate `core/bills` agent keeps both.

## Implementation and review

- `subscription_invoices` lists current-scope matched invoices with their typed clues and already-linked subscription IDs ([src/subscriptions.ts](../../src/subscriptions.ts)).
- `subscription_record` accepts `invoice: {collectionId, artifactId}` and checks amount/currency, `lastInvoiceDate`, issuer/product identity, plan conflicts, gathered account label and invoice order. It marks those fields `sourceKind: "invoice"`, records the invoice and receipt in `source_ref` and returns `priceChange` for any amount change.
- `core/bills` ([plugins/core/agents/bills.md](../../plugins/core/agents/bills.md)) has the ten gathering-agent tools plus the four tracker tools. It shares the agent state of `core/gathering`.
- Shared skills: `invoice-gathering` (moved from the gathering prompt), `subscription-ledger` (moved from the subscriptions prompt) and the new `invoice-ledger`. The gathering and subscriptions prompts now keep their mandate and hard limits and load the procedure through `skill_read`.
- The Mini App shows the last invoice date, marks invoice-sourced items and links invoice-backed history to its collection.
- Design record: [subscriptions](../subscriptions.md#invoice-backed-fields), [agents](../agents.md#agent-definitions).

Review, 18 October 2026: the independent reviewer (Claude Opus 5.5) requested changes at `f8d71c1` and reproduced each defect:

- **Blocking.** A Claude Pro invoice updated an item saved as label "Claude", plan "Max", because each name alone passed the plan check.
- **Blocking.** Substring identity let a Netflix item with plan "Premium" take a YouTube Premium invoice's price. An item labelled "Max" also matched a Claude Max target.
- **Non-blocking.** The older-invoice guard covered only amounts, so a date-only update could move `lastInvoiceDate` back first. Service-period matches without an invoice date skipped the guard.
- **Non-blocking.** `lastInvoiceDate` was not calendar-validated.
- **Non-blocking.** A collection-bound agent could cite other collections.
- **Non-blocking.** The bills prompt lacked the gathering hard limits.

Fixes:

- The issuer is matched on the merchant (or label) only, by vendor group or a leading name.
- Plan conflicts are checked on combined names.
- The age check covers every invoice-backed field, and undated invoices are refused once a date is saved.
- An invoice-backed amount needs its recorded date.
- Bound agents are limited to their collection.
- The prompt restates the hard limits.

Regression tests cover each case.

Second round at `926a1f9`: the reviewer confirmed the first-round fixes and ran 20 identity and plan probes built from real `invoiceFacts`. It requested changes for one blocking case: sized plan names ("Max 5x", "Max20", "Claude Max (5x)") still passed against a Claude Pro invoice. The plan check now reduces each name to its family and tier before `productEvidence`, which itself is unchanged for `gather_match`. Non-blocking:

- Legal or domain suffixes ("Spotify AB", "Anthropic PBC", "Claude.ai") were refused on the safe side. They are now ignored, and the label is a fallback for issuer matching.
- The undated-invoice message now points to the recorded invoice dates.
- Same-vendor different products remain a documented limit.

All 20 probes now give the expected result.

Third round at `d83a5f8` requested changes for one blocking regression introduced by suffix stripping. Merchants such as "Anthropic PBC" or "OpenAI Inc" now passed the issuer check, but the plan-family lookup still used the raw name, so a Claude Pro or ChatGPT Plus invoice could update a Max or Pro item. The fix:

- The family now comes from the suffix-stripped name of the merchant or the label.
- The label fallback for issuer matching was removed (the label counts only when there is no merchant), which also closes a merchant-Netflix, label-Disney+ acceptance.
- Suffixes are kept when what remains is under three characters ("X Corp" stays distinct from "X.ai").

Across the reviewer's 47 probes, the remaining unintended acceptances are the documented same-vendor case and a contrived "AI" merchant. Known safe-side refusals: "ChatGPT Team" against a "ChatGPT Business" invoice.

Fourth round: the reviewer **APPROVED** exact head `12e6aad`, with all 52 probe cases giving the intended outcome. Main then advanced to `9437d86` (PR 249, which took journal 92), so this entry is renumbered 93 and the branch merges that main. The reviewer **APPROVED** merged head `b8fa3ef` after rebuilding the merge with `git merge-tree` and checking PR 249's write-block handling for delegated tracker writes. Hosted CI passed on that head.

Devin Review on `b8fa3ef` raised five findings, all accepted:

- **Accounts.** An invoice gathered for an account label could update an unlabelled item.
- **Dates.** A caller-chosen date from a multi-date service-period PDF could set and order `lastInvoiceDate`.
- **Paging.** A 2,000-row cap was applied before paging.
- **Amounts.** Only 12 of up to 30 recorded amounts were listed.
- **Price changes.** Currency-only and unknown↔known changes were not reported.

All five are fixed with regressions, and the reviewer's 52 probes give unchanged results. The reviewer **APPROVED** exact head `ff135b1`, re-running all 52 probes plus new date and price-change probes. Hosted CI passed on that head. Devin completed there with one further finding, declined: paging fails past offset 10,000. Reaching it needs more than 10,000 matched invoices for one owner, at 100 files per collection. It is the same 10,000 offset ceiling as `subscription_list` and the parcel and responsibility lists, and `collectionId` narrows the listing.

## Verification and outcome

Tested with PGlite fixtures that reproduce gathering's matched rows: owner isolation, unmatched candidates, superseded scopes, amount/currency and date checks, plan and account conflicts, older-invoice refusal, price-change output, retry hashing, background-lane refusal, and the bills/gathering/subscriptions catalogue and shared-skill wiring.

Not established: whether a fast-tier model picks the right total from several recorded amounts, whether moving procedure into lazily read skills changes gathering or subscriptions behaviour, and whether the bills agent fits gathering plus tracker updates in one 12-call allocation on real collections.

### Release closure — 19 October 2026 (SGT)

- **Merge.** [PR 253](https://github.com/akhilvuputuri/chief-agent/pull/253) merged as `1733d48ac0fb0600aab7971dabc8dd13e0caf5a5` from approved head `ff135b1`.
- **Release.** The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39143260571) recorded the exact deployment and startup health (`npm run release:status`).
- **Logs.** Private logs show `gateway.started` for that release at 16:07 UTC on 18 October. No warn/error lines were logged in the 30 minutes before the check, about two minutes after startup.
- **Migration.** None.
- **Local checks.** 983 application tests passed on the merged branch before the Devin fixes, and 56 focused tests after them.
- **Not yet measured.** Owner Telegram acceptance, amount selection by the fast-tier model, behaviour with lazily read skills, and whether the bills agent fits gathering plus tracker updates in its 12-call allocation.

## Follow-up and next iteration

First owner acceptance: ask Chief to gather one month's invoice for a tracked subscription and update the tracker, then check the Subscriptions tab shows the invoice-sourced amount, last invoice date and collection link. If wrong totals appear, add an owner confirmation card before invoice-backed writes. Price alerts, monthly summaries and automatic monitoring through responsibilities remain separate work under issue 132.
