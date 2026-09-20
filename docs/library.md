# NLB library assistant

Product requirement and full implementation plan: [issue #41](https://github.com/akhilvuputuri/companion-agent/issues/41). This document describes shipped behaviour and grows with each phase.

## Phase 1 — catalogue availability (v0.3.11)

Ask "is Project Hail Mary available as an ebook at NLB?" and the assistant answers from the public OverDrive catalogue in one tool call. No library card, identity, credential or schema is involved; the feature is on whenever the application runs. Borrowing, holds and the shelf arrive in later phases; until then the reply says so and the owner borrows in Libby.

### The verdict rule

`isAvailable` from the catalogue is never consulted, because Lucky Day copies can be borrowed while it reads false. The host computes one verdict per candidate:

| Condition                                                | Verdict        | Meaning for the owner                                  |
| -------------------------------------------------------- | -------------- | ------------------------------------------------------ |
| `availableCopies > 0`                                    | `borrow_now`   | Normal loan (library lending period, fallback 21 days) |
| `availableCopies == 0` and `luckyDayAvailableCopies > 0` | `lucky_day`    | 7-day loan; cannot be renewed or held                  |
| both zero and `isHoldable`                               | `hold`         | Queue length and estimated wait are reported           |
| both zero and not holdable                               | `unobtainable` | No lendable ebook copy                                 |

Kobo reachability is the presence of the `ebook-kobo` format on the Thunder catalogue item. The title page and the catalogue have been observed to disagree on this flag for one title; the catalogue is treated as authoritative until the first real borrow settles it.

### Tools

- `library_check(query, author?)`: one search (`mediaType=ebook`, 25 results, first page), a client-side ebook filter, ranking, one bulk availability read for the top five, verdicts and a host-written `answerHint` sentence per candidate. Returns `ambiguous` when the best match is weak, two editions tie, or a strong rival has a different author, and `omittedNonEbook` for the audiobooks and magazines dropped. The server-side `showOnlyAvailable` filter is not used because it returned zero-copy titles first; `format=<id>` is not used because the four ebook format ids would need four queries.
- `library_availability(titleIds ≤ 5)`: rechecks known titles with the same rule.

Both are read operations (`readOperations`), advertised only when the `library` availability flag is set, and return no account data. Results are cached in memory: search and availability for 15 minutes, library metadata for 24 hours. A repeat question within 15 minutes makes no upstream call and reports the same `checkedAt`.

### Pacing and safety

All requests go through one `LibraryClient` that serialises calls globally, waits at least 2 seconds between calls (60 seconds between writes, none exist yet), counts attempts per Singapore day (reads stop at 180 of a 200 ceiling), retries only reads and only on transient failures (twice, jittered), and opens a circuit breaker on a `whoa` 403 (24 hours, one owner notice) or HTTP 429 (1 hour), or after five consecutive transient failures (30 minutes); each opening sends the owner one Telegram notice. In Phase 1 the counter, cache and breaker live in memory and reset on restart; the schema release moves them to Postgres.

Every library failure the model sees is a `ToolValidationError` with neutral wording (no status codes, no titleIds, no URLs), so the agent loop never retries it and an interrupted read can never be journaled as an uncertain write.

`src/library-routes.ts` is the only module naming the two OverDrive hosts. Its (method, path) inventory is the complete outbound surface; `tests/library-boundary.test.ts` fails if a route is added, if a host appears elsewhere, or if any source constructs a return, renew, download, fulfilment or card-login path. Identity routes are declared now and unused until Phase 2.

### Acceptance (owner, from the phone)

1. Ask for a well-known title and confirm the verdict, Lucky Day or hold numbers and the Kobo label arrive in one reply.
2. Ask a vague title and confirm the assistant lists candidates and asks which.
3. Repeat the first question within 15 minutes and confirm the reply quotes the same check time.

Record outcomes in [journey 22](journey/22-library-assistant.md) as reported observations.
