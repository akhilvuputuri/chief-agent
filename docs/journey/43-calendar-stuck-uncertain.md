# 43 — Why did one uncertain Calendar write block every later event?

Work date(s): 2026-09-29. Written/revised: 2026-09-29.
Status: tested (PR open on `claude/calendar-event-creation-bug-nad2ub`). Not released; live acceptance pending.

## User-visible problem and preceding iteration

**Reported (owner screenshot, 29 September SGT):** Chief would not add a haircut event. It said an earlier attempt "returned an uncertain-write error", so it could not safely retry, and asked for **Check status** or operator inspection. "Try to add again" at 11:06 got the same refusal.

[Journal 31](31-calendar-authorization-failure.md) hit the same state on 23–24 September. An operator had to settle the stale approval by hand: a GET for its deterministic event ID returned 404 a day later, and they recorded it as absent. That fix removed the trigger (an expired token) but not the mechanism. An uncertain approval that Google never created still blocked every later draft until someone intervened in the database.

## Evidence

**Measured (sanitized CloudWatch metadata, `npm run logs:cloudwatch`, 26–29 September):**

- Only two `calendar_draft` calls exist in the window, at 11:53 and 13:44 UTC on 26 September. Both saved drafts, and the owner approved each within seven seconds (`calendar.approval_decided approved=1`). No `calendar.not_sent` line followed. `calendar.created` is written by SQL and is not projected, so the outcome of each insert is not visible in the logs. The owner's 26 September migration acceptance reports a successful Calendar approval.
- After that, no `calendar_draft` call appears at all. This morning's runs (09:04–09:07 SGT) called `calendar_list` once and then only `conversation_search`/`conversation_read`, and answered without a tool call. The calendar domain was loaded on every turn. A local `runtimeContext` check confirmed that `calendar_draft` is offered when the domain is loaded.
- Hypothesis: the 13:44 approval is stored as `approved` with execution `uncertain`. It is consistent with the bot's history-based answer and with the source. It is not confirmed by a database read. The cause of that insert failure is unknown: the uncertain path recorded no category.

**Tested from source:** `CalendarActions.decide` marks every error after the insert attempt `uncertain`. **Check status** GETs the deterministic ID and, on 404, returns `uncertain` again without changing the row. `calendar_draft` refuses while any approved row is `creating`/`uncertain`. So absence never resolves, and the block is permanent. The model also learned from chat history to refuse without calling the tool.

## Diagnosis and alternatives

The approval is claimed only before `expires_at` (15 minutes after drafting). After review, the insert is sent only within 60 seconds of the claim, which bounds the untimed audit write, token refresh and account check; the insert then times out after 20 seconds. Well after expiry, no attempt can still be in flight. A 404 for the deterministic ID then means the event was never created. This is the same judgment the operator applied manually in journal 31, a day later.

- **Chosen:** read-only settlement. After `expires_at + 5 minutes`, a GET that returns 404 records the approval as `failed` with `failure.code = not_found` and a `calendar.reconciled` event. A found event is recorded as created. **Check status** and the `calendar_draft` guard both run it, so "try again" works without a button or an operator. Within the window, absence is still treated as uncertain. The guarded `UPDATE` repeats the time condition. A concurrent checker that loses the race re-reads and reports the recorded outcome.
- **Rejected:** retrying the insert or resetting the approval to pending. That still violates one attempt per approval.
- **Deferred:** classifying definite 4xx insert responses as non-creation (journal 31's open item). Settlement now resolves those cases within minutes anyway. A 409 still needs its own analysis.

## Implementation and review

- `src/calendar-actions.ts`: `settle()` performs the GET-only reconciliation. The draft guard settles each unresolved approval and reports one of three outcomes: still uncertain (with timing guidance), found (recorded as created, confirm with the owner before another draft), or the check failed.
- The uncertain path now emits `calendar.uncertain` with a bounded cause (`http`, `timeout` or `error`) plus the Google HTTP status (`GoogleHttpError`). The next incident will show why the insert failed. `calendar.reconciled` is projected to the operational log.
- Telegram explains a `not_found` settlement. The model context now tells it to call `calendar_draft` for a retry instead of refusing from chat history.
- Tests (`tests/calendar-approval.test.ts`): blocked inside the window, and a failed check stays blocked. After the window, Check status settles `not_found` and the next draft saves. A stuck approval is settled by the next draft itself. A found event is recorded as created and blocks once. Exactly one insert per approval. Recorded uncertain causes.

Independent review (Claude Opus 5.5 subagent, head `385c811`): **REQUEST CHANGES.** Findings and corrections:

1. **Medium:** the audit write between the claim and the insert had no time limit, so a stalled database could send a POST after settlement. Fixed: `create()` refuses to send more than 60 seconds after the claim (`not_sent`).
2. **Low–medium:** a created event the owner deleted made `findCreated` throw, which would block again. Fixed: a `cancelled` event with the deterministic ID settles as `deleted`.
3. **Low:** a concurrent checker reported "uncertain" after another had settled the row. Fixed: it re-reads the row.
4. **Low:** failed settlement checks were silent. Fixed: `calendar.check_failed` logs a bounded cause.
5. **Low:** test gaps (`creating` rows, the 4-minute boundary, concurrency, the real 404/cancelled paths, projections). Tests added.
6. **Low:** a stale troubleshooting sentence. Fixed.

Re-review of the updated head is pending.

## Verification and outcome

`npm run check` passed: 497 application and 21 script tests, plus both Python eval suites. `format:check` also passed. Not yet released. The stuck approval will settle on the owner's first Calendar retry after deployment, or when they tap **Check status**. If its event exists, Chief will report it instead of drafting a duplicate.

## Follow-up and next iteration

- Live acceptance: after release, ask Chief to add the event again; expect a `calendar.reconciled` line, then a new approval card.
- If `calendar.uncertain` recurs with `httpStatus` 401/403, check the write scope of the production Calendar token (a successful `calendar_list` does not prove it).
