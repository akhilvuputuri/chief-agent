# 26 — A delivery tracker, and what a new capability costs the prompt

Work date: 2026-09-21. Status: candidate v0.3.19 on `feature/delivery-tracker`, rebased onto `c9a86cf`. Migration 019, so it needs the reviewed operator rollout, which must follow the watchlist rollout that installs 018. The delivery tracker and the stock watchlist were built in parallel and collided on migration number, journal number and version; this one renumbered. Not deployed, and no owner acceptance recorded.

## User-visible problem

Order confirmations and shipment notices arrive as email, and the state of a parcel lives across several of them plus whatever the owner knows directly. Asking "what am I waiting for" meant re-reading mail every time, and an answer was only as good as that one search.

## Two things the codebase did not already have

**A Gmail message is not a stored source.** Preparation evidence is trustworthy because a saved quote is verified against a persisted `research_sources` row, and that row is written only by `web_read`, the media specialist and Telegram uploads. `gmail_read` hands text to the model with no source id. Pointing the quote machinery at email would have meant persisting message bodies in Postgres. That was rejected: provenance here is structural, the message id, thread id, sender, subject and the message's own date, which is enough to re-open the exact mail and explain a status without mirroring a mailbox into the database. The honest cost is that a parcel's evidence is a pointer, not a verified quotation.

**Nothing compared when a fact was observed against when it was recorded.** Memories and preparation requirements are last-writer-wins; canvases and routines guard concurrent edits with a revision compare-and-swap. The issue's requirement, that an older email must not silently overwrite newer owner input, had no precedent to reuse. The rule built for it is deliberately two-term: a more recently observed fact wins outright, and otherwise higher authority wins. That keeps today's carrier mail useful on a parcel last discussed weeks ago while protecting a fresh "this arrived" from a late-delivered notice describing an earlier moment. Losing observations are recorded and explained rather than dropped, because the question "why does it say that" has to be answerable.

## The measured surprise: the prompt is a shared budget

The first working version passed its own tests and broke one elsewhere: after a large saved answer, a follow-up could no longer retrieve it. The cause was not the feature's logic. Five new always-on operations added about 5,500 characters to the fixed model prompt, and in that scenario the compact retrieval pointer no longer fit.

Measuring it made the shape clear. With every capability enabled the fixed prompt was already about 50,900 characters, against a 48,000-character soft allowance and a 120,000-character hard limit. It was over the soft allowance before this work began. Each new domain is not free, and there are five more domain issues queued.

Three changes brought the cost to about 3,100 characters and restored the broken behaviour:

- Create and update merged into one `parcel_record`, since they shared every field and the schema is carried on every turn. The duplicate risk this creates is handled explicitly: creating refuses when the tracking reference already belongs to a saved parcel.
- The single read folded into `parcel_list(id)`, which is what `prep_list` already does.
- The operations gated on `availability.parcels`, so minimal and specialist runtimes do not carry a capability they cannot use.

Only the third of those is a workaround; the first two are simplifications worth making anyway. The general lesson is recorded here rather than in the feature document: adding a capability to this runtime has a per-turn context price, it is already being paid, and the tool surface is the place to pay less.

## Tested

Thirteen new tests: a requested search creating a parcel that a later email updates and that survives a restart; a late email not displacing newer owner input while still appearing in history with a reason; a newer email still updating an old parcel; an explicit correction beating a fresher email; the same message applied twice changing nothing; two parcels under one order staying ambiguous until a tracking reference separates them; owner isolation on every operation; archiving as the owner's alone; a note never moving a status; unmappable carrier wording refused as a status and kept verbatim; the precedence rule and reference normalisation directly; and capability gating. Twelve offline rollout tests cover the migration procedure.

Not tested, because it does not exist yet: any real mailbox. Every extraction question, whether the assistant reliably finds a tracking number in a real shipping email, and whether matching works against real merchants, is open until owner acceptance.

## Open checks

1. A real request: find a delivery in mail and track it.
2. A second email about the same parcel, and whether matching attaches it correctly.
3. Two parcels from one order, and whether it asks instead of guessing.
4. Saying "this arrived", then letting an older notice arrive, and confirming the status holds.
