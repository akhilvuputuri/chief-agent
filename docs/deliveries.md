# Delivery tracker

Implementation for [issue 64](https://github.com/akhilvuputuri/chief-agent/issues/64). Adds migration 019 and the `parcels` capability. Candidate; not yet deployed.

## What the owner does

Ask, from Telegram: "find the delivery details for my headphones in my email and track them", "here is the tracking number for another package", "what parcels am I waiting for", "this one arrived today". The assistant searches mail **only when asked**. Nothing scans the mailbox on a schedule, and no carrier is ever contacted.

## What a parcel record is

`parcels` holds the current state; `parcel_updates` is an append-only history and the only provenance record. A correction is a new update row, never an edit, in the same spirit as a canvas revision.

An email observation stores the message id, thread id, sender and subject. It never stores the message body. One message applies once per parcel, so a single shipment email covering two parcels of an order can be recorded against each, while repeating it against the same parcel changes nothing. That is enough to re-open the exact message and to explain a status, and it keeps mailbox content out of the database. The consequence is that an email cannot be quote-verified the way preparation evidence is, because that machinery needs a persisted source row; a parcel's provenance is structural, not quoted.

## Precedence: what an observation changes

An observation can carry three independent things, and each is decided on its own terms. The result reports each one (`statusApplied`, `etaApplied`, `detailsApplied`), and `ignoredReason` names every part that did not apply and why. Nothing is dropped: a losing observation is still recorded in history with those same flags.

**Status.** Every observation carries an authority, where the owner outranks an email, and an `observedAt`, which for an email is the message's own `Date` header rather than the moment it was read. A status applies when

```
next.observedAt > current.observedAt  OR  next.authority > current.authority
```

A more recently observed fact wins outright, so today's carrier mail updates a parcel the owner last mentioned weeks ago. When the new observation is not newer it needs higher authority, which is what stops a Tuesday shipping notice from undoing the owner's Thursday statement while still letting them correct a fresher email. One rule sits above that: once the owner confirms a parcel delivered, no email can move it back to an earlier state, whatever its date, because a carrier notice written after the doorstep handover is lagging rather than new. A later return notice is a genuine next event and still applies. A parcel created without any status has no status clock at all, so an older shipping email found afterwards still sets its status; `asOf` and `statusSource` are then absent rather than pretending the owner said "unknown".

**Delivery date.** The date keeps its own clock (`etaAsOf`) under the same newer-or-higher-authority rule. A date-only observation therefore never advances the moment the status is taken to describe. `deciding_update_id` points only at the observation that decided the status.

**Details** (carrier, tracking and order references, note). The owner's statement always applies, with or without a status, because correcting a detail is exactly what the owner is for. An email fills an empty detail, and overwrites one only when its own status applied, so a stale email cannot rewrite a tracking number the owner supplied. Changing a tracking reference to one another parcel already holds is refused, so a decisive reference stays decisive.

**Time.** An `observedAt` more than a day in the future is refused, because it would outrank every later real observation, including the owner's. For the owner's own statements the model omits `observedAt` unless they say when something happened.

## Matching: the host decides, the model does not guess

`parcel_match` ranks candidates. A tracking reference identifies a parcel on its own; an order reference together with the merchant does; a merchant or a label fragment never does. References compare with case and punctuation removed, so `sp 123-456` and `SP123456` are the same reference. When the result is `ambiguous`, the assistant must ask which parcel rather than choosing, and `parcel_record` needs an explicit id to update. Several parcels under one order therefore stay ambiguous until a tracking reference separates them.

`parcel_record` without an id creates a parcel and requires a label. It refuses to create when the tracking reference already belongs to a saved parcel, archived or not, so a forgotten id cannot silently produce a duplicate. A parcel with no tracking reference has no such guard, which is why matching must be called first. Both writes are single statements: a parcel and its first observation commit together, and an update and its history row do too, so history can never claim an application that did not happen.

## Honesty rules

Statuses are last known, never carrier-verified. The notice leads every result and results are trimmed to stay below the 12,000-character model projection, because above it a result is replaced by a bare excerpt and the notice would be lost. Lists are paged and report `total` and `nextOffset`; a decisive reference is looked up directly, so matching still finds a parcel outside the recent window. Results also carry `asOf`, the moment the deciding fact describes. `lastCheckedAt` records when email was last consulted, so a stale answer is visibly stale. Carrier wording that does not map to the supported vocabulary is preserved verbatim in `rawStatus`, on the parcel as well as in its history, while the status stays `unknown`, rather than being coerced into a neighbouring value. An absent delivery date stays absent. A date once recorded can be replaced by a winning later observation but cannot be cleared back to unknown.
Supported statuses: `ordered, shipped, in_transit, out_for_delivery, delivered, delayed, returned, cancelled, unknown`.

## Capability gating and context cost

The three operations are gated on `availability.parcels`, enabled in the deployment and off by default. This is not an external dependency; it exists because the fixed model prompt is a shared budget. Measured on 23 September 2026 with every other capability on, the fixed prompt is 50,971 characters on the deployed `798439f` and 54,244 on this branch, a rise of 3,273, against a 48,000-character soft allowance; 120,000 is the compaction threshold and 400,000 the hard limit. Gating spares minimal and specialist runtimes the 2,658 characters of tool schema and description. The remaining 614, a paragraph of runtime guidance, are paid whether or not the capability is on. An earlier measurement on a different base gave 3,137 in total and 479 always paid; the difference is the observation-time rule added in the third review round. Merging create and update into one `parcel_record`, and folding the single read into `parcel_list(id)`, was done for the same reason. See [journal 33](journey/33-delivery-tracker.md).

## Deliberately not built

No carrier API, no authenticated browsing, no scheduled refresh or alerts. A scheduled refresh should later reuse the [routine infrastructure](scheduled-routines.md) rather than own a timer. No parcel extraction specialist: the tool surface is unchanged whether the chief or a specialist does the reading, so it can be added later. Its trigger is a tracking request routinely exhausting the turn's tool budget. No new Telegram view; parcels answer as ordinary replies.

## Deployment (operator-reviewed migration 019)

Same shape as the routine rollout. Independent review of the exact head, CI, merge, then `scripts/deploy-parcels.py ARCHIVE SHA` over the existing operations connection from the reviewed baseline. It validates historical migrations and the single Compose insertion, locks releases, builds before stopping the gateway, refuses active work, applies only 019, checks the version marker and health, and rolls back to the previous application on any failure while retaining the additive tables. 12 offline rollout tests cover those paths. Migration 018 from the watchlist rollout is already live, so the reviewed baseline is the deployed `798439f`; a newer release must be reconciled and re-reviewed rather than bypassed. If any environment ever applied an earlier head of this branch, its owner-wide `parcel_updates_message` index must be dropped by hand first, because `CREATE UNIQUE INDEX IF NOT EXISTS` keeps the older definition.
