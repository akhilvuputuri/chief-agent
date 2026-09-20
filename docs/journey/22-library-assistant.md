# 22 — NLB library assistant

Work date: 2026-09-13 to 2026-09-20. Written: 2026-09-20.
Status: Phase 1 in progress (candidate v0.3.11); account phases planned. Release SHA and PR added at verification.

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

Tested: 15 new automated tests (route inventory and forbidden-segment scan, pacing, ceiling, breaker, retry classes, leak-free errors, verdict table, ebook filtering and ranking, caching, dispatcher gating). Full suite, typecheck, build and formatting pass locally. Deployment and owner acceptance are pending and will be appended with the exact SHA.

## Follow-up

Phase 2 (schema, encrypted identity, phone linking, shelf) is the one operator-released step; Phases 3 and 4 (approved writes, hold-ready watcher) are app-only. Unknowns settled by first real use: the clone-code direction, the borrow body encoding, `chip/sync` field names and Kobo reachability. Known Phase 1 limit: the in-memory daily counter resets on restart.
