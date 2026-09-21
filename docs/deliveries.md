# Delivery tracker

Implementation for [issue 64](https://github.com/akhilvuputuri/companion-agent/issues/64). Adds migration 019 and the `parcels` capability. Candidate; not yet deployed.

## What the owner does

Ask, from Telegram: "find the delivery details for my headphones in my email and track them", "here is the tracking number for another package", "what parcels am I waiting for", "this one arrived today". The assistant searches mail **only when asked**. Nothing scans the mailbox on a schedule, and no carrier is ever contacted.

## What a parcel record is

`parcels` holds the current state; `parcel_updates` is an append-only history and the only provenance record. A correction is a new update row, never an edit, in the same spirit as a canvas revision.

An email update stores the message id, thread id, sender and subject. It never stores the message body. That is enough to re-open the exact message and to explain a status, and it keeps mailbox content out of the database. The consequence is that an email cannot be quote-verified the way preparation evidence is, because that machinery needs a persisted source row; a parcel's provenance is structural, not quoted.

## Precedence: what changes a status

Every observation carries an authority, where the owner outranks an email, and an `observedAt`, which for an email is the message's own `Date` header rather than the moment it was read. A new observation becomes the parcel's deciding one when

```
next.observedAt > current.observedAt  OR  next.authority > current.authority
```

A more recently observed fact wins outright, so today's carrier mail updates a parcel the owner last mentioned weeks ago. When the new observation is not newer it needs higher authority, which is what stops a Tuesday shipping notice from undoing the owner's Thursday "this arrived" while still letting them correct a fresher email. An observation that loses is still recorded, still visible in history, and the result says why it did not apply. A note without a status or date never moves the status, whoever sent it.

Identity fields (carrier, tracking and order references) fill a gap freely but overwrite only when the update decides, so a stale email cannot rewrite a tracking number the owner supplied.

## Matching: the host decides, the model does not guess

`parcel_match` ranks candidates. A tracking reference identifies a parcel on its own; an order reference together with the merchant does; a merchant or a label fragment never does. References compare with case and punctuation removed, so `sp 123-456` and `SP123456` are the same reference. When the result is `ambiguous`, the assistant must ask which parcel rather than choosing, and `parcel_record` needs an explicit id to update. Several parcels under one order therefore stay ambiguous until a tracking reference separates them.

`parcel_record` without an id creates a parcel and requires a label. It refuses to create when the tracking reference already belongs to a saved parcel, so a forgotten id cannot silently produce a duplicate.

## Honesty rules

Statuses are last known, never carrier-verified; every result carries that notice and `asOf`, the moment the deciding fact describes. `lastCheckedAt` records when email was last consulted, so a stale answer is visibly stale. Carrier wording that does not map to the supported vocabulary is preserved verbatim in `rawStatus` while the status stays `unknown`, rather than being coerced into a neighbouring value. An absent delivery date stays absent. A date once recorded can be replaced by a winning later observation but cannot be cleared back to unknown.

Supported statuses: `ordered, shipped, in_transit, out_for_delivery, delivered, delayed, returned, cancelled, unknown`.

## Capability gating and context cost

The three operations are gated on `availability.parcels`, enabled in the deployment and off by default. This is not an external dependency; it exists because the fixed model prompt is a shared budget. With every capability enabled the prompt was already about 51,000 characters against a 48,000-character soft allowance and a 120,000-character hard limit, and these tools add roughly 3,100. Gating keeps minimal and specialist runtimes from paying for a capability they cannot use. Merging create and update into one `parcel_record`, and folding the single read into `parcel_list(id)`, was done for the same reason. See [journal 26](journey/26-delivery-tracker.md).

## Deliberately not built

No carrier API, no authenticated browsing, no scheduled refresh or alerts. A scheduled refresh should later reuse the [routine infrastructure](scheduled-routines.md) rather than own a timer. No parcel extraction specialist: the tool surface is unchanged whether the chief or a specialist does the reading, so it can be added later. Its trigger is a tracking request routinely exhausting the turn's tool budget. No new Telegram view; parcels answer as ordinary replies.

## Deployment (operator-reviewed migration 019)

Same shape as the routine rollout. Independent review of the exact head, CI, merge, then `scripts/deploy-parcels.py ARCHIVE SHA` over the existing operations connection from the reviewed baseline. It validates historical migrations and the single Compose insertion, locks releases, builds before stopping the gateway, refuses active work, applies only 019, checks the version marker and health, and rolls back to the previous application on any failure while retaining the additive tables. 12 offline rollout tests cover those paths. It must run after the watchlist rollout, which installs migration 018 and publishes its source; started before that, it refuses because the staged migration set would differ by more than this one file. If any environment ever applied an earlier head of this branch, its owner-wide `parcel_updates_message` index must be dropped by hand first, because `CREATE UNIQUE INDEX IF NOT EXISTS` keeps the older definition.
