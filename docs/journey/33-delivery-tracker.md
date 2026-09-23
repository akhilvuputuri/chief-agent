# 33 — A delivery tracker, and what a new capability costs the prompt

Work date: 2026-09-21 to 2026-09-23. Status: candidate v0.3.24 on `feature/delivery-tracker`, rebased onto `7297202`. Migration 019, needing the reviewed operator rollout from the verified-deployed `b22b09d` baseline or the docs-only `7297202` above it. Built alongside the stock watchlist, two Gmail-account releases, a context-compaction change and the Chief rebrand, this work collided with them on migration, journal and version numbers and was renumbered three times; these are the fourth set. Not deployed, and no owner acceptance recorded.

## User-visible problem

Order confirmations and shipment notices arrive as email, and the state of a parcel lives across several of them plus whatever the owner knows directly. Asking "what am I waiting for" meant re-reading mail every time, and an answer was only as good as that one search.

## Two things the codebase did not already have

**A Gmail message is not a stored source.** Preparation evidence is trustworthy because a saved quote is verified against a persisted `research_sources` row, and that row is written only by `web_read`, the media specialist and Telegram uploads. `gmail_read` hands text to the model with no source id. Pointing the quote machinery at email would have meant persisting message bodies in Postgres. That was rejected: provenance here is structural, the message id, thread id, sender, subject and the message's own date, which is enough to re-open the exact mail and explain a status without mirroring a mailbox into the database. The honest cost is that a parcel's evidence is a pointer, not a verified quotation.

**Nothing compared when a fact was observed against when it was recorded.** Memories and preparation requirements are last-writer-wins; canvases and routines guard concurrent edits with a revision compare-and-swap. The issue's requirement, that an older email must not silently overwrite newer owner input, had no precedent to reuse. The rule built for it is deliberately two-term: a more recently observed fact wins outright, and otherwise higher authority wins. That keeps today's carrier mail useful on a parcel last discussed weeks ago while protecting a fresh "this arrived" from a late-delivered notice describing an earlier moment. Losing observations are recorded and explained rather than dropped, because the question "why does it say that" has to be answerable.

## The measured surprise: the prompt is a shared budget

The first working version passed its own tests and broke one elsewhere: after a large saved answer, a follow-up could no longer retrieve it. The cause was not the feature's logic. Five new always-on operations added about 5,500 characters to the fixed model prompt, and in that scenario the compact retrieval pointer no longer fit.

Measuring it made the shape clear. With every capability enabled the fixed prompt measured 50,156 characters before this work, on the base of the time, against a 48,000-character soft allowance. It was over the soft allowance before this work began. Remeasured on 23 September on main at `798439f`, which in prompt terms is identical to the deployed `b22b09d`, the base is 50,971 and this branch adds 3,273: 2,658 gated behind the capability and 614 always paid. That limit arithmetic has also moved under this work: 120,000 is now the compaction threshold and the hard limit is 400,000. Each new domain is not free, and there are five more domain issues queued.

Three changes brought the cost to about 3,100 characters and restored the broken behaviour:

- Create and update merged into one `parcel_record`, since they shared every field and the schema is carried on every turn. The duplicate risk this creates is handled explicitly: creating refuses when the tracking reference already belongs to a saved parcel.
- The single read folded into `parcel_list(id)`, which is what `prep_list` already does.
- The operations gated on `availability.parcels`, so minimal and specialist runtimes do not carry a capability they cannot use.

Only the third of those is a workaround; the first two are simplifications worth making anyway. The general lesson is recorded here rather than in the feature document: adding a capability to this runtime has a per-turn context price, it is already being paid, and the tool surface is the place to pay less.

## What independent review caught

The first head passed 313 tests and carried three defects that none of them could see, all in the same place: writes were two statements where they needed to be one.

An observation with an id and nothing else produced `UPDATE parcels SET ,revision=...`, a raw syntax error, after its history row had already been written. A history row was inserted before the revision compare-and-swap, so a concurrent edit left history asserting an application that never happened, and because the email's identifier was now spent, the legitimate message could never be applied on retry. A rejected first observation left a parcel with no provenance at all, contradicting the claim that the update table is the only provenance record. There is no transaction helper here and the pool cannot promise one connection, so the fix is the house pattern the library work used: each write is now a single statement whose history insert selects from the parcel write, and writes nothing when that write matches nothing.

Review also found that the one-email-once index was scoped to the owner rather than to the parcel, which blocked exactly the case the ambiguity rules were built for, a single shipment email covering two parcels of one order. That a date-only observation advanced the status clock, so supplying a delivery date today made a carrier email from last week look stale and wrongly ignored; the delivery date now keeps its own clock. That matching scanned only the hundred most recently updated parcels, so an older parcel's own tracking reference returned "no saved parcel matches, save a new one", actively instructing the model to duplicate a parcel it already owned. That a long list serialised past the projection limit and lost the never-carrier-verified notice it promised to carry. And that an email could reopen an archived parcel, because the guard tested the archive flag for truth rather than for presence.

Two documented behaviours also turned out to be untested: the duplicate-tracking guard on create, and identity fields resisting a stale email. Both were revertible with the suite still green. They have tests now, as does every defect above.

## Rounds two and three: a fix that broke a promise, and a rule that was never there

Round two (Claude Fable 5.1 reviewer, head `88a9e0f`) confirmed seven of eight round-one fixes and found that the delivery-date fix had introduced a new blocker. Identity fields were gated on "status or date applied", so a stale email carrying a first-ever delivery date overwrote the tracking reference the owner had supplied. The response gated identity on the status alone.

Round three (Claude Fable 5.1, head `f4bb032`) showed that response was also wrong, from the other side. Gating the owner's own details on the status meant that "it's actually DHL, tracking JD-NEW" was recorded, reported as not applied with no reason, and then `parcel_match` on the new tracking number answered "no saved parcel matches, save a new one". The issue asks for corrections straight from the owner. Neither version had asked whose statement it was: the owner's details should always apply, and an email's should fill a gap or follow its own winning status. That is the rule now, and details are reported separately from status and date.

The same review found that creating a parcel without a status stamped the status clock with owner authority and the current time. So the issue's own example, "here is a tracking number" followed by "find the details in my email", could never take a status from an earlier shipping notice. A parcel with no status observation now has no status clock at all.

Two rules were added that were not in any earlier version. A delivery the owner confirmed cannot be moved back to an earlier state by any email, because in the reviewer's probe a carrier notice written the morning after the handover otherwise reverted it; a later return notice still applies. And an observation more than a day in the future is refused, because a model passing an expected delivery date as the observation time would outrank every real update after it.

Smaller corrections: the runtime guidance named `parcel_update`, a tool that does not exist, on the exact match-then-write path; `rawStatus` and the delivery date's own clock were invisible on the parcel; the deciding-update pointer moved on date-only changes; updating to another parcel's tracking reference was allowed; and two trim loops were unreachable in practice and untested. Limits are now injectable, so those loops are exercised directly.

The pattern across three rounds is that each fix was verified against the scenario that motivated it and not against the neighbouring one it changed. The round-two identity fix passed its own stale-email test and silently broke owner corrections, which no test covered because every correction test also sent a status.

## Round four: the same hole in two more fields, and a lock two emails could open

Round four (Claude Fable 5.1, head `43464a5`) found no blocker and three majors.

The owner-correction fix covered carrier, references and note, but the schema also lets the owner send a merchant and a label with an id, and those were silently ignored. Merchant matters more than it looks: order reference plus merchant is a decisive match, so a wrong merchant left that order permanently ambiguous. Both are now details, with two email limits: an email never renames the owner's label and never clears a field.

The confirmed-delivery lock was keyed on the owner being the status source. An email saying "delivered" after the owner had said so was allowed through as harmless, took over as the source, and a third email could then walk the parcel back. An email that only repeats the owner's status now changes nothing, which keeps the owner as the source and the lock closed.

The rollout baseline named `798439f` as deployed. It never was: its release failed the current-main check, and `b22b09d` deployed after it. The script now accepts exactly `b22b09d` and the journal-only `7297202` above it, and a test proves any other baseline is refused. Calling a commit deployed because it was main's tip is the same mistake as calling a feature live because it merged.

Minor fixes: carrier wording without a status is refused instead of dropped, archiving an archived parcel no longer moves its timestamp, details are reported per field in `detailsChanged`, and the one-day future allowance is documented as the clock-skew trade-off it is.

## Tested

Twenty new tests: a requested search creating a parcel that a later email updates and that survives a restart; a late email not displacing newer owner input while still appearing in history with a reason; a newer email still updating an old parcel; an explicit correction beating a fresher email; the same message applied twice changing nothing; two parcels under one order staying ambiguous until a tracking reference separates them; owner isolation on every operation; archiving as the owner's alone; a note never moving a status; unmappable carrier wording refused as a status and kept verbatim; the precedence rule and reference normalisation directly; and capability gating. Twelve offline rollout tests cover the migration procedure. The tests now use the real read path, `parcel_list` with an id; an earlier version called a `parcel_read` operation that does not exist and silently passed through the update branch, which the test files escape because `tsconfig.json` type-checks only `src`.

Not tested, because it does not exist yet: any real mailbox. Every extraction question, whether the assistant reliably finds a tracking number in a real shipping email, and whether matching works against real merchants, is open until owner acceptance.

## Open checks

1. A real request: find a delivery in mail and track it.
2. A second email about the same parcel, and whether matching attaches it correctly.
3. Two parcels from one order, and whether it asks instead of guessing.
4. Saying "this arrived", then letting an older notice arrive, and confirming the status holds.
