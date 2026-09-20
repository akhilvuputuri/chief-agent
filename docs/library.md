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

## Phase 2 — linked card, shelf and days left (v0.3.12, operator-released)

Requires migration 016 and a server `LIBRARY_IDENTITY_KEY`; see [rollout](library-rollout.md). Without the key the account features are absent from the tool list and `/library` says so.

### Linking from the phone

`/library link` sends an approval card. Tapping **Start linking** claims the row and starts a detached ceremony: the assistant mints an anonymous Libby identity, asks Libby for an 8-digit setup code and edits the card to show it (spaced as `4821 9037`), with a **Stop linking** button. The owner types the code into Libby on the same phone under Menu → Copy To Another Device. The assistant polls every 5 seconds for up to 5 minutes and at most 60 polls, edits the message when the code rotates (at most 6 edits), and on `fulfilled` completes the clone, re-mints so the card is baked into its token, syncs, and requires a card for NLB (website id 106 or advantage key `nlb`) before marking the identity linked. Two attempts per Singapore day; an attempt needs 80 calls of allowance left. Every poll is journaled as an enum (`retained`, `regenerated`, `fulfilled`), never the code. Abort flips a flag the loop reads and is never queued behind other controls. The fallback direction, if Libby shows a code on the phone instead, is `/library code 12345678` within 15 minutes of the approved attempt; the message is deleted best-effort and the code is never stored. Do not use Recover Your Data on the phone: that path would replace the phone's own Libby data.

Settled on 20 September 2026 by three real attempts and Libby's own web client: the phone enters the code the assistant displays. The displaying device must poll `GET chip/clone/code` **with its current code as a parameter**; without it the server only issues or retains codes and never reports fulfilment (two attempts stayed `retained` for five minutes). On `fulfilled` the answer carries a `blessing`; `POST chip/clone {blessing}` completes the transfer (an empty body is refused with 403); Libby's client then re-mints with its existing bearer and syncs, which is what the ceremony does when the card is not yet visible. Adopting an identity from the clone answer is kept only as a defensive hypothesis, unobserved against the real server. The ceremony also checks the sync every fourth poll (each a counted read) and links a bearer that already carries the card as it is. `/library link` also tries the existing identity's token first, so an attempt that timed out before this fix links without a new code.

### Identity storage and kill switches

The bearer, card id and expiry are sealed with AES-256-GCM (`src/secret-box.ts`, key from `LIBRARY_IDENTITY_KEY`, AAD bound to the owner) in `library_identities.token_box`. Only `withBearer()` decrypts; the `Bearer` value stringifies as `[REDACTED]`; no tool argument, tool result, event, approval payload or Telegram text carries the token, the card id or a code, and a test scans every store after a full link to prove it. The only unattended request is the re-mint (`POST /chip` with the current bearer) when the token is within 72 hours of expiry. An unauthenticated answer marks the identity `expired` with one notice. Kill switches in increasing reach: `/library revoke` (card; local wipe first, then one remote revoke attempt, never retried), `scripts/library-kill.sql` (operator), removing the key from the server environment and restarting.

### Shelf

`library_shelf` (model tool, read, only when the account is configured) and `/library` (host command, no model, reads the last snapshot) report loans with days left computed from `expireDate`, due dates, Lucky Day flags, holds with readiness or estimated wait, slot capacity when the card exposes limits, and today's call usage. Sync is cached 15 minutes. Snapshots never contain ids.

### Recovery

`recoverLibrary()` runs at startup after `recoverRuntime()`: an executing approval without a recorded send becomes `failed` (nothing was sent), one with a send becomes `uncertain`, a displaying link attempt is aborted and its anonymous chip forgotten, a fulfilled or completing attempt stays uncertain for the Check shelf path. `/library pending` re-sends pending cards that scrolled away. Borrow, hold and cancel cards exist in the schema but their execution arrives in Phase 3.

### Acceptance (owner, from the phone)

1. Ask for a well-known title and confirm the verdict, Lucky Day or hold numbers and the Kobo label arrive in one reply.
2. Ask a vague title and confirm the assistant lists candidates and asks which.
3. Repeat the first question within 15 minutes and confirm the reply quotes the same check time.

4. Phase 2: `/library` says not linked; `/library link`, approve, complete the handshake in Libby; ask "how many days left on my loans"; note which direction Libby used.

Record outcomes in [journey 22](journey/22-library-assistant.md) as reported observations.
