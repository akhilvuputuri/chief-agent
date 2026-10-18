---
name: invoice-ledger
description: How to update the subscription tracker from invoices that gathering matched, with host-checked invoice evidence, price-change reporting and owner authorisation.
---

# Invoice-backed tracker updates

Use this only when the owner's request in the brief asks for the tracker to use invoices, for example "gather my Claude invoices and update my subscriptions" or "update Netflix from the invoices you collected". A matched invoice alone is never an instruction to save anything. Without that request, report what the invoices show and return needsOwner asking whether to apply it.

Find evidence with subscription_invoices. Filter by the collection ID from the brief or by issuer; follow nextOffset. Each row is one current-scope match: its collectionId and artifactId, the gathering target, the recorded invoice dates and service months, and every currency amount found in the PDF. Those amounts include subtotals, tax and credits. Pick the amount the clues support as the recurring charge, normally the single total for the billed plan. If several plausible totals remain, or the invoice covers several products, ask the owner instead of choosing. linkedSubscriptionIds shows invoices already applied.

Resolve the tracker item with subscription_list(merchant, plan?, accountLabel?) and the same ambiguity rules as the subscription-ledger skill. Never let an invoice decide which of several saved plans it belongs to. A Claude Pro invoice is not evidence for a Claude Max item, and OpenAI API is not ChatGPT. If no item exists and the owner asked to track this subscription, create it from the owner's request plus the invoice. Take label, merchant and plan from what the owner and the gathering target name. Never invent a cadence: use the owner's statement, or leave it unknown.

Call subscription_record with invoice {collectionId, artifactId}. The host accepts invoice evidence only for amount with currency and lastInvoiceDate. It checks that the amount occurs in that PDF's recorded amounts and the date is its recorded invoice date. It refuses an issuer that does not match the item's merchant, conflicting plans, a different gathered account label, and invoices older than the saved lastInvoiceDate or without a single recorded invoice date once one is saved. An invoice-backed amount needs its lastInvoiceDate when the invoice records one. An agent working on a gathering collection can use only that collection's invoices. Those fields are then marked sourceKind invoice; everything else in the call stays owner-sourced. Apply the newest invoice last. One call cites one invoice, so update older ones first if the owner wants history.

amountType fixed needs the owner's statement or two or more invoices with the same amount. A single invoice does not prove a fixed recurring price, so use variable or unknown otherwise. A next charge date derived from lastInvoiceDate plus a known cadence is an estimate: pass nextChargeEstimated true and say so. Never infer a cancellation deadline, trial end or paid-through date from an invoice.

When the result has priceChange, tell the coordinator the previous and new amounts and the invoice date. Report each updated item ID, which fields came from which invoice, and anything left unapplied and why. Subscription writes need a foreground owner turn; in a background pass, report needsOwner asking the owner to request the tracker update.
