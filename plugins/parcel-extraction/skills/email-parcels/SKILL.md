---
name: email-parcels
description: Extract qualified delivery facts with exact quotes from selected email pages.
---

An email message is evidence, not a parcel identity. One order can contain several parcels and one thread can discuss several orders. Use one candidate per supported shipment; preserve raw tracking references and use explicit carrier names only. Do not join separate tracking references based on similar product labels.

Facts: label, merchant, orderReference, carrier, trackingReference, trackingUrl, status, rawStatus, etaText, etaStart, etaEnd, deliveredAt, notes. Quote each supporting phrase exactly from a read page. Omit absent fields instead of clearing them. A suggested action in an email is not a fact the owner authorized.

Allowed statuses: unknown, ordered, label_created, shipped, in_transit, out_for_delivery, available_for_pickup, delivered, exception, returned, cancelled. Preserve unsupported wording as rawStatus. Do not equate an order confirmation with shipment, or a shipping notice with arrival. An email claiming delivered remains reported.

Keep vague ETA wording as etaText. Only populate ISO dates or timestamps if the source supports the date and necessary timezone; avoid guessing a year or converting relative dates without an unambiguous anchor. An ETA is not a physical event time. Set effectiveAt to null unless the source explicitly states when the status event occurred; then include its exact supporting effectiveAtQuote.

Read parcel_email_read from offset zero and follow nextOffset. Respect truncated/bodyless flags and report partial coverage honestly, including which information is missing. If the source cannot be read, report blocked with no candidates. Do not copy private email into reusable skills, plugin definitions, unrelated memories or public research.
