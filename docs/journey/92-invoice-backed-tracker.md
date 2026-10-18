# 92 — Can one agent fetch invoices and keep the subscription tracker in step?

Work date(s): 2026-10-18. Written/revised: 2026-10-18.
Status: in progress. Implementation and focused tests pass locally; independent review, merge and release pending.

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

Regression tests cover each case. Re-review pending.

## Verification and outcome

Tested with PGlite fixtures that reproduce gathering's matched rows: owner isolation, unmatched candidates, superseded scopes, amount/currency and date checks, plan and account conflicts, older-invoice refusal, price-change output, retry hashing, background-lane refusal, and the bills/gathering/subscriptions catalogue and shared-skill wiring.

Not established: whether a fast-tier model picks the right total from several recorded amounts, whether moving procedure into lazily read skills changes gathering or subscriptions behaviour, and whether the bills agent fits gathering plus tracker updates in one 12-call allocation on real collections.

## Follow-up and next iteration

First owner acceptance: ask Chief to gather one month's invoice for a tracked subscription and update the tracker, then check the Subscriptions tab shows the invoice-sourced amount, last invoice date and collection link. If wrong totals appear, add an owner confirmation card before invoice-backed writes. Price alerts, monthly summaries and automatic monitoring through responsibilities remain separate work under issue 132.
