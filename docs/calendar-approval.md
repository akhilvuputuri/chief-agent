# Calendar queries and confirmed event creation

## User flow

Ask about upcoming events as before. For creation, describe the event, date, start and end time. The agent asks for missing details and saves a draft. Telegram shows an authoritative preview with **Approve event** and **Decline**. Only that button can authorize creation; natural-language assent and `/approve UUID` cannot approve Calendar writes. Approval expires after 15 minutes. Changing details requires a new draft and fresh approval.

Initial scope: timed, non-recurring events of at most seven days on the connected owner's primary calendar. Dates carry explicit UTC offsets; previews show Singapore time. No guests, invitations, all-day events, editing or deletion. Gmail remains read-only. Ordinary model replies stay natural; the structured card is the transaction approval preview, not a general response template.

## Execution and recovery

`calendar_draft` is a validated model tool. `CalendarActions` stores the exact payload in Postgres; the authenticated Telegram callback consumes an unexpired, owner-scoped approval atomically. The model has no creation or approval tool. Calendar credentials are checked against the configured owner and Google account before access.

The Google event ID is derived from the random approval UUID. The application makes one creation attempt per approval. A timeout or interrupted write stays uncertain; clicking **Check status** performs a GET for that identity, never another POST. A successful result persists its event ID/link and execution event. Restarted processes can reconcile from that record. Uncertain writes prevent additional drafts until resolved. If Google has no matching event, an operator must inspect before clearing uncertainty; absence immediately after a network interruption is not proof that no write happened. Never reset the approval to pending to retry it. A failure before the insert request is sent (token refresh, account check or local validation) is a definite non-creation: the approval is recorded as `failed` with `failure.code` `authorization` (reconnect Calendar), `configuration` (fix the server's Google OAuth client settings) or `not_sent`, the owner is told which applies, and later drafts are not blocked. The approval is still never retried.

Draft receipts prove only that a draft was saved. Recent Calendar approval outcomes are included in runtime context so the model can distinguish pending, denied and created events. A successful callback resumes only its linked task, subject to remaining execution budget. The existing query tool can check actual calendar state.

### Troubleshooting a missing event

Use the [shared incident runbook](troubleshooting.md#calendar-event-incident) to determine whether the request reached `calendar_draft`, whether its preview was delivered, whether the owner clicked the exact button, and whether `calendar.created` plus a receipt exist. Do not assume a successful `calendar_list` proves the write-capable credential or Google scope was installed. The repo records the consent procedure but does not assert the current production token's scope or validity.

The current `CalendarActions.decide` deliberately catches any exception from the create attempt and returns `uncertain` without recording a provider error category. That protects against replaying a possibly completed POST, but it means the bounded production diagnostics—and often ordinary gateway logs—cannot identify whether the cause was token refresh, account mismatch, Google rejection, or a network interruption. Treat all as hypotheses until an authorized operator verifies the credential/scope and reconciles the deterministic event ID. [Issue #28](https://github.com/akhilvuputuri/chief-agent/issues/28) tracks shared private trace inspection; its Calendar implementation should include structural stage/error categories without exposing credentials, event details, or a second write path.

## OAuth

The one-time `scripts/connect-calendar.mjs CLIENT_JSON OUTPUT_JSON EMAIL` helper requests `openid`, userinfo email and `calendar.events.owned`, checks the exact returned scopes/account, and writes a new file with mode 0600. Use a fresh private output path. This Google scope is broader than the app's exposed operations: Google permits event management on owned calendars, while our dispatcher permits only queries and approved creation. Do not change the separate Gmail token or scopes.

After the owner completes Google consent, securely replace only `CALENDAR_REFRESH_TOKEN` in the server environment. Do not print tokens, put them in Actions logs or attach them to cloud tasks. Read-only tokens still support queries but cannot create events. Production creation is not considered enabled until the new token is installed and verified.

Official API reference: https://developers.google.com/workspace/calendar/api/v3/reference/events/insert

## Reviewed additive rollout

This release changes the approvals operation constraint and Compose migration list. It therefore requires the existing operator path, not an exception to the automated database guard.

1. Pass regression tests, build and formatting; review the patch. Check there is no active runtime work.
2. Apply only `db/009_calendar_approval.sql` to the existing database with ON_ERROR_STOP. It broadens the operation constraint, preserves all rows and is safe with the old application.
3. Install the reviewed `db/003_skills.sql`, `db/009_calendar_approval.sql` and `compose.yaml` as the release baseline on the server. Migration 003 is updated because Compose reruns it: its earlier narrow constraint would reject new Calendar approval rows on future startups. Do not run deferred migration 007 or historical reset scripts.
4. Install the newly consented Calendar token securely. Merge the passing release and observe the automatic release health result. If code is deployed before consent, explicitly report that writes are not yet enabled.
5. Check Calendar listing with the connected account. For the first real creation, the owner sends a request and clicks its Telegram approval; do not create a test event without that click.

Rollback is application-only to the prior image. Keep the additive constraint broad; do not delete approvals or attempt to narrow it after Calendar records exist. Record the deployed SHA and consent/live-test status separately.

## Development record

9 September 2026: reused existing Calendar reads, approvals, authenticated Telegram gateway and Postgres. Added a dedicated draft service and exclusive callback creation boundary, deterministic event identity and read-only reconciliation. Tests cover invalid fields, ownership, denial/expiry, generic approval rejection, duplicate callbacks, restart recovery, no invitations, and migration reruns. No framework migration or new infrastructure was introduced.
