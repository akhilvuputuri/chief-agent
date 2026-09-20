# 22 — NLB library assistant

Work date: 2026-09-13 to 2026-09-20. Written: 2026-09-20.
Status: Phase 1 released as [v0.3.11](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.11) at `9c71f61` ([PR #51](https://github.com/akhilvuputuri/companion-agent/pull/51), [release run 35489220156](https://github.com/akhilvuputuri/companion-agent/actions/runs/35489220156)); owner acceptance pending. Phase 2 released as [v0.3.12](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.12) at `71de810` ([PR #52](https://github.com/akhilvuputuri/companion-agent/pull/52), operator rollout 20 September 2026, migration 16, health verified); first real link pending.

## User-visible problem

The owner borrows NLB ebooks for a Kobo through Libby and wanted to ask the assistant, from a phone, whether a title is available as an ebook, later to approve a borrow or hold from a Telegram card, and to ask how many days remain on loans. The first question turned out to be the hard one: the catalogue's `isAvailable` flag reads false for titles that are borrowable right now as Lucky Day copies, so a naive answer would be wrong in precisely the cases the owner cares about.

## Evidence

- Live browser and API inspection of nlb.overdrive.com and the Thunder catalogue on 13 September 2026 established the availability fields, the Lucky Day semantics (`LuckyDayLendingPeriodsByFormat = {ebook: 7}`), the noisy mixed-type search results and the unreliable `showOnlyAvailable` filter. Recorded in [issue #41](https://github.com/akhilvuputuri/companion-agent/issues/41).
- Identity routes were probed only with anonymous, cardless chips; no card was linked. Route shapes for account operations come from Libby's own client bundle and two open-source clients and remain unexercised.
- The implementation plan (revision 2, in issue #41) was produced with four subsystem maps, three independent designs, three judges and an adversarial verification pass; the schema for the later phase was validated under PGlite.

## Diagnosis and alternatives

Plugins are declarative and cannot make HTTP calls, so the integration is a host module. The verdict is computed by the host from copy counts, never by the model from `isAvailable`. Pacing lives inside the client because the agent loop retries failed reads immediately on certain error texts; library errors are therefore validation errors with neutral wording. Search filtering is client-side because the server filter proved unreliable. Rejected: separate search and availability tools (two model round-trips per question), a generic outbound rate limiter with no second consumer, and a model-selectable Lucky Day mode.

## Implementation

Phase 1 adds `src/library-routes.ts` (the only module naming the hosts; a closed (method, path) inventory), `src/library-client.ts` (serialisation, spacing, daily ceiling, breaker, bounded bodies, redacted bearer type), `src/library-pacing.ts`, `src/library-rules.ts` (verdict, ranking, hints), `src/library.ts` (`library_check`, `library_availability`), wiring in the protocol, runtime gating, dispatcher and main, and three test files including the CI boundary test. Behaviour contract: [docs/library.md](../library.md). No migration, Compose or environment change.

## Verification and outcome

Released 20 September 2026 (v0.3.11, exact SHA above, health verified by the release workflow). Independent review of the first head found a NUL byte that made `library.ts` binary in diffs, a lending-period walk that could cache the Lucky Day map as the normal loan length, and an unwired throttle notice; all fixed before approval. Retry jitter in code is 3–4.8 s and 8–12.8 s (the plan said 3–8 s); the catalogue test fixture has 7 items, not the 25 of the live sample.

Tested: 15 new automated tests (route inventory and forbidden-segment scan, pacing, ceiling, breaker, retry classes, leak-free errors, verdict table, ebook filtering and ranking, caching, dispatcher gating). Full suite, typecheck, build and formatting pass locally. Owner acceptance from the phone (real title, vague title, repeat within 15 minutes) is pending and will be appended as reported.

## Phase 2 — 20 September 2026 (released)

Adds migration 016 with the approvals constraint widened in place in 003 and 009 (the Calendar precedent), AES-256-GCM identity storage, the detached linking ceremony with rotating-code edits and an unqueued abort, `/library` host commands, the `lib:` approval callbacks, `library_shelf`, startup recovery and the operator script `scripts/deploy-library.py` with 13 offline rollout tests. Tested: the ceremony against scripted `retained`/`regenerated`/`fulfilled` sequences, abort, deadline, the fallback code entry, re-mint, expiry marking, revoke ordering (decrypt, local wipe, one remote call), pending-card denial, redelivered updates, stranger and group taps, `/approve` rejection, expired-card retirement before the unique index, full-directory migration re-run with rows present, and a store-wide scan for the fake token and codes. Hypotheses still open until the first real link: the clone-code direction, the `POST /chip/clone` body, `chip/sync` field names and the card's `limits`.

## First real link — 20 September 2026 (reported and measured)

The owner ran `/library link` on v0.3.12. Measured: the ceremony polled 52 times over five minutes with 4 code rotations; every poll after the owner typed the code answered `retained`, never `fulfilled`. Reported: Libby displayed "Your data is being synchronized to the device that was displaying the code you entered" and no error. Diagnosis: the direction hypothesis (agent displays, phone enters) is confirmed; the completion-signal hypothesis was wrong, the card arrives on the identity by sync while the code poll stays `retained`. The attempt expired and would have discarded the identity; the operator preserved the row by marking it `expired` before cleanup. Fix (v0.3.13): sync check every fourth poll as the completion signal, no clone call when the card is already present, and `/library link` reuses an existing identity's token before showing a new code. The `POST /chip/clone` step remains unexercised.

## Second real link — 20 September 2026 (measured)

On v0.3.13 the reuse path found no card on the preserved identity and issued a new code. After the owner entered it, two ceremony syncs 25 s apart still returned zero cards and zero loans on the anonymous chip, while the code poll kept answering `retained`. Hypotheses now open: the documented `POST /chip/clone` completion call is required before the copied data appears on the chip, or the sync body has a layout the tolerant parser does not recognise. v0.3.14 records the sync body's shape (key names and sizes only), the code response's key names, and tries the clone call once per attempt after eight polls without a card (before any later completion clone), logging only its status and shape. Events are structural and are not passed through the trace scrubber.

## Third real link and the protocol from Libby's client — 20 September 2026 (measured)

On v0.3.14 the sync body shape was exactly `{result, cards, loans, holds, stashes, summary}` with empty arrays, ruling out a parsing gap, and the blind `POST /chip/clone` with an empty body answered 403 (not a throttle). Reading Libby's public web bundle (`dewey-22.1.1/src/main.js`, `chip-code-output`) settled the protocol: the displaying device polls `GET chip/clone/code` with `{code: <displayed code>, role}`; `fulfilled` arrives with a `blessing`; the device then `POST chip/clone {blessing}`, forgets its identity and syncs. Our polls omitted `code`, so the server treated every poll as a code request and never reported fulfilment. Fix: echo the displayed code on every poll, complete with the blessing, then sync; if the card is not yet visible, re-mint with the existing bearer and sync again, which is the sequence Libby's client performs (`forgetIdentity` then a chip request with the old bearer). Adopting an identity from the clone answer is a defensive hypothesis, not observed in the client. The diagnostic probe is removed. Operator notes: the identity from the second attempt was preserved by flipping its state; the attempt counter and poll budget were reset by hand for the third attempt.

## Fourth real link — 20 September 2026 (measured)

On v0.3.16 the third poll answered `fulfilled` with a `blessing` (keys `result`, `blessing`), confirming the echoed-code fix. `POST chip/clone {blessing}` still answered 403. The remaining difference from Libby's client is the chip itself: Libby mints with `chip?c=d:22.1.1&s=0` (plus `v=<chip id prefix>` on renewals) and keeps the returned `chip` id, whereas the assistant minted with the third-party `client=dewey` form. v0.3.17 mints and renews exactly as the client does and records the upstream error code on refusals. Hypothesis: a chip minted the third-party way is not permitted to receive a clone. Also in v0.3.17: `/library link` settles an attempt left `completing` before starting a new one, and the per-day attempt count is raised from two to four while the 130 link-call ceiling remains the hard daily bound.

## Follow-up

Phase 2 (schema, encrypted identity, phone linking, shelf) is the one operator-released step; Phases 3 and 4 (approved writes, hold-ready watcher) are app-only. Unknowns settled by first real use: the clone-code direction, the borrow body encoding, `chip/sync` field names and Kobo reachability. Known Phase 1 limit: the in-memory daily counter resets on restart.
