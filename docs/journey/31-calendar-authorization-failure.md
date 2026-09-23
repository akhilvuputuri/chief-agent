# 31 — Why could an approved Calendar event fail as "uncertain"?

Work date(s): 2026-09-23. Written/revised: 2026-09-23.
Status: released 2026-09-23 (deployed `7648fca`, no version tag). The expired Calendar credential itself still needs operator reconnection.

## User-visible problem and preceding iteration

**Reported:** the owner tried to add a Calendar event on 23 September (about 00:59 Singapore time) and it did not get created. [Calendar approval](../calendar-approval.md) makes one creation attempt per Telegram approval, and any failure during that attempt was recorded as an _uncertain_ write. [Journal 26](26-google-authorization-expiry.md) replaced the expired Gmail credential on 21 September after the OAuth project moved out of Testing. Calendar and Sheets use separate refresh tokens, and the runbook left their renewal as a separate check.

## Evidence

- **Measured** (bounded [diagnostics run 35864713296](https://github.com/akhilvuputuri/chief-agent/actions/runs/35864713296), 2026-09-23 13:05 UTC, release `c936d7d`, 24-hour tool window): `calendar_list` failed 3 of 3 times; `calendar_draft` succeeded once; `gmail_search` (2) and `gmail_read` (1) succeeded. The run that saved the draft stopped with `awaiting_approval`.
- **Not observable:** diagnostics include neither approval rows, button taps nor tool error text. Whether the owner pressed Approve, and which message was shown, is not established.
- **Hypothesis:** the Calendar refresh token was issued while the OAuth project was in Testing and has expired (`invalid_grant`). It explains Calendar reads failing while Gmail, renewed two days earlier, succeeded. The error text that would confirm it is not in the diagnostics.

## Diagnosis and alternatives

**Tested from source:** saving a draft makes no Google request, so it succeeded. On approval, `CalendarTools.create` refreshes the token and checks the account before the insert request. A failure there was caught along with network failures and marked `uncertain`. That has two effects:

1. The owner is told the outcome is uncertain and offered **Check status**, which fails the same way and shows a generic "unavailable" message.
2. `calendar_draft` refuses all later drafts while an uncertain write exists. After reconnection, **Check status** finds no event and still reports uncertain, so an operator must clear it.

The token endpoint's `invalid_grant` 400 also reached tools as the generic `Google request failed (400)`. That text did not match the `AUTHORIZATION_REQUIRED` classification, so the model saw only "the tool failed".

Alternatives considered: re-opening the approval as `pending` for a retry. That contradicts the one-attempt-per-approval rule, so it was rejected. Classifying failed insert responses (e.g. 4xx from Google) as definite non-creation was left out: a 409 means the event already exists, so it needs its own reconciliation analysis.

## Implementation and review

- `src/calendar.ts`: `GoogleAuthError` records whether a rejection needs owner reconnection (`authorization`) or a server OAuth settings fix (`configuration`). Tools classify these as `AUTHORIZATION_REQUIRED` and `NOT_CONFIGURED` respectively. Only the token endpoint's `invalid_grant` code (read from a bounded error body) and userinfo 401/403 or a wrong account count as `authorization`. Other token 400/401 codes, such as `invalid_client`, or an unreadable body, count as `configuration`. `list` now reuses the same header and account check. The token helper is shared with the daily Sheet. Failures before the insert request is sent throw `CalendarNotSentError`.
- `src/calendar-actions.ts`: that error sets `execution: "failed"` with `failure.code` `authorization`, `configuration` or `not_sent` (carried on the error, not inferred from message text), and records `calendar.not_sent`. This mirrors the library approvals' failed state. The approval is not reopened, repeated callbacks return the saved failure without contacting Google, and later drafts are allowed. Network and response failures of the insert request itself still become `uncertain`.
- `src/telegram.ts`: the callback says no event was created. For `authorization` it says to reconnect Calendar and draft again; for `configuration` it says the server's Google connection settings must be fixed. A status check that fails with a `GoogleAuthError` says so.
- Regression tests: `tests/calendar-approval.test.ts` covers the token-only request sequence, the tool error classification, the Telegram reply, the stored state, no retry, and that a later draft is allowed.

Independent review, round 1 (2026-09-23): a separate reviewer agent in this session (Claude, harness-selected model; GPT-6 Astra was unavailable) returned **REQUEST CHANGES** on `652a3278`. It found the logic correct, but:

- **F1 (blocking):** no test used the real client to prove that failures after the insert request is sent stay uncertain. Its mutation that wrapped the insert in `CalendarNotSentError` passed every test.
- **F2:** userinfo 401/403 and missing configuration were labelled "could not be reached".
- **F3:** the "expired or revoked" wording overstated the cause for `invalid_client` and wrong-account failures.
- **F4:** the `calendar.not_sent` event was written even when the guarded update matched no row.
- **F5:** the stored draft was revalidated outside the not-sent boundary.

Fixes:

- **F1:** a new test covers an insert network error and an insert 500; it fails under the reviewer's mutation.
- **F2:** userinfo 401/403 and missing configuration are now classified as authorization.
- **F3:** the wording is now a neutral "authorization failed".
- **F4:** the event is written only when the row was updated; otherwise the callback reports uncertain.
- **F5:** the stored draft is now validated only inside `create`.

Devin Review on `652a3278` raised two findings. The first, userinfo 401/403 classified as `not_sent`, was already fixed in `900b83c`. The second was that every token 400/401 was called expired, although `invalid_client` needs a settings fix rather than reconnection. That was addressed by parsing the OAuth `error` code and adding the structured `GoogleAuthError` classification above.

Independent review, round 2: the same reviewer returned **APPROVE** on exact head `60c3bda915257f81c2ffae331c01d1b7871c88f9`. It re-ran `npm run check` (346 application and 10 script tests) and Prettier on a clean `git archive` of that SHA. Mutations caught by tests 5 and 7 included: the insert wrapped as not-sent, every token 400/401 treated as authorization, the userinfo 401/403 mapping removed, and the error kind not propagated.

The reviewer left non-blocking notes, deferred here:

- The F4 row guard, the F5 validation placement and the Telegram `configuration` reply are correct by probe but not pinned by tests.
- A token-endpoint 403 is still classified as `not_sent`.
- The `configuration` reply says "before drafting again" although drafts are not blocked.

It could not verify Google's OAuth error semantics (`invalid_grant`/400, `invalid_client`/401) against the documentation because the session's network proxy blocks the documentation hosts.

## Verification and outcome

**Tested:** `npm run check` (346 application and 10 script tests after the review fixes) and `npm run format:check` passed locally on 2026-09-23. No live Google or Telegram check was run.

Remaining operator steps: reconnect Calendar with `scripts/connect-calendar.mjs` and replace `CALENDAR_REFRESH_TOKEN`, confirm whether the Sheets token also needs renewal, and inspect/clear any existing `uncertain` `calendar_create` approval created by this incident. The deployed code cannot distinguish that older row from a genuinely uncertain write.

## Follow-up and next iteration

Runtime context lists only pending Calendar approvals, so the model does not see a failed or created outcome. Diagnostics also omit approval states and tool error codes, which prevented confirming this incident remotely. Both are candidate follow-ups.

### Release closure — 2026-09-23

- **Merge:** [PR #81](https://github.com/akhilvuputuri/chief-agent/pull/81) was squash-merged as `7648fca5cb7f2cd0590a7db5e496f3c4a6f97b33` from approved head `60c3bda`. The merge sits on top of the watchlist-only #80 (`2f57b24`), which merged while this PR was open.
- **Checks:** [checks run 35867846631](https://github.com/akhilvuputuri/chief-agent/actions/runs/35867846631) passed on the merge commit.
- **Release:** [release run 35868480055](https://github.com/akhilvuputuri/chief-agent/actions/runs/35868480055) re-ran format, check and build, then deployed and reported `{"deployed": "7648fca5cb7f2cd0590a7db5e496f3c4a6f97b33", "healthy": true}`.
- **Scope:** application-only; no migration or Compose change.
- **Version:** no version tag was published, because the package version was not bumped in the PR.

Startup health does not show that Calendar works. Remaining steps:

- Reconnect Calendar and replace `CALENDAR_REFRESH_TOKEN`.
- Check whether the Sheets token also needs renewal.
- Clear any `uncertain` `calendar_create` row left by the original incident.
- Then the owner should confirm, with a real Telegram approval, that an event is created. Until the credential is replaced, an approval should now produce the reconnect message rather than "uncertain".
