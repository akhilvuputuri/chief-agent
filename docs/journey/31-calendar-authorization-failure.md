# 31 — Why could an approved Calendar event fail as "uncertain"?

Work date(s): 2026-09-23. Written/revised: 2026-09-23.
Status: tested. Code fix under review; not deployed. The expired Calendar credential itself needs operator reconnection.

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

- `src/calendar.ts`: `googleToken` reports 400/401 token responses as "Google authorization expired or was revoked … reconnect required", which tools classify as `AUTHORIZATION_REQUIRED`. The token helper is shared with the daily Sheet. Failures before the insert request is sent throw `CalendarNotSentError`.
- `src/calendar-actions.ts`: that error sets `execution: "failed"` with `failure.code` `authorization` or `not_sent`, and records `calendar.not_sent`. This mirrors the library approvals' failed state. The approval is not reopened, repeated callbacks return the saved failure without contacting Google, and later drafts are allowed. Network and response failures of the insert request itself still become `uncertain`.
- `src/telegram.ts`: the callback says no event was created and, for authorization, to reconnect Calendar and draft again. A failed status check that is caused by authorization says so.
- Regression tests: `tests/calendar-approval.test.ts` covers the token-only request sequence, the tool error classification, the Telegram reply, the stored state, no retry, and that a later draft is allowed.

Independent review: pending.

## Verification and outcome

**Tested:** `npm run check` (345 application and 10 script tests) and `npm run format:check` passed locally on 2026-09-23. No live Google or Telegram check was run.

Remaining operator steps: reconnect Calendar with `scripts/connect-calendar.mjs` and replace `CALENDAR_REFRESH_TOKEN`, confirm whether the Sheets token also needs renewal, and inspect/clear any existing `uncertain` `calendar_create` approval created by this incident. The deployed code cannot distinguish that older row from a genuinely uncertain write.

## Follow-up and next iteration

Runtime context lists only pending Calendar approvals, so the model does not see a failed or created outcome. Diagnostics also omit approval states and tool error codes, which prevented confirming this incident remotely. Both are candidate follow-ups.
