# Daily assistant

General tasks/notes, reminders, fixed briefings and a separate viewing workbook live alongside the job tools. Everything runs on the existing server. Calendar is read-only; Gmail remains read-only.

## Try in Telegram

- Save a task to renew my passport next month.
- Save a note titled Weekend ideas: try a new cycling route.
- Remind me in 30 minutes to check the oven.
- Remind me every Monday at 9am to plan my week.
- Show my reminders; move that reminder to tomorrow at 8pm; pause/cancel it.
- Every day at 9am send a brief of my tasks, unread inbox and upcoming calendar events.
- What is on my calendar tomorrow?
- Sync my daily-life Sheet.

Times default to Asia/Singapore. The reply must confirm the actual next firing time. Task due dates are separate from reminders. General records support open/done/archived status; they never modify job records. Calendar reads cover the primary calendar, maximum 31 days and 100 events; responses disclose truncation.

## Scheduling design

The TypeScript scheduler accepts explicit once, interval and cron arguments. `cron-parser` computes recurring times in Asia/Singapore; the model translates conversational requests into supported arguments. There is no Python endpoint or arbitrary scheduled script execution.

Postgres holds schedules and delivery state. A worker ticks every 15 seconds, atomically claims due rows, delivers one bounded Telegram message and computes the next run. Recurrences are at most hourly. Missed recurring occurrences coalesce into one message, then restart from the current time. Pending one-shot reminders survive restarts.

If delivery errors or a process dies during delivery, the schedule becomes failed (stale processing after 10 minutes). It is not automatically replayed because Telegram may already have accepted it. Check Telegram, then explicitly reschedule. A cancellation before the final delivery check suppresses sending; a message already in flight cannot be recalled. This is not exactly-once delivery or a safety-critical alarm system. Delivery state and errors are visible through schedule_list and the Sheet.

Briefings in this release use no model call: up to 10 open tasks, optional upcoming 24-hour primary calendar events and optional 5 unread inbox subjects from the past day. Email/calendar must be explicitly selected by the user. A failing Google source is reported in the brief while available sections are delivered. The content field is a label, not an arbitrary scheduled prompt. Research briefs, custom semantic prioritization, frontier review and periodic skill cleanup remain pending.

## Google setup and viewing surface

Use `scripts/connect-calendar.mjs CLIENT_JSON OUTPUT_JSON EMAIL` for a separate PKCE loopback OAuth flow. It requires exactly openid, userinfo.email and calendar.readonly, verifies the account and stores the credential with mode 0600. Enable Calendar API in the existing Google project. Configure CALENDAR_REFRESH_TOKEN in private local/cloud environment files. OAuth testing-mode credentials can expire and require reconnection.

DAILY_SPREADSHEET_ID identifies the separate workbook with numeric tab IDs 0/1/2 named Tasks/Notes/Schedules. It reuses the existing drive.file-scoped Sheets token. Use daily_sync after changes; the agent is instructed to request this, but it is not a durable synchronization outbox. Schedule deliveries also attempt synchronization. If Sheets is unavailable, Postgres retains all state. Managed tabs overwrite manual edits. Cells are literal strings; UTC timestamps are labelled, scheduling intent uses Singapore time. Snapshot size is bounded at 5000 rows per tab.

## Tests

Database tests exercise owner isolation, task updates, cancellation, due delivery, recurring progression, worker recreation and ambiguous-delivery failure handling. Calendar tests enforce owner identity, bounded ranges, account verification and GET-only event access. TypeScript scheduler tests cover stored schedule formats, recurring times and the minimum hourly recurrence restriction. No new cloud VM or Google event-writing scope is required.
