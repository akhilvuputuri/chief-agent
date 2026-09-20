# Google integrations

Gmail, Calendar and both Sheet mirrors are connected in the existing personal deployment. They are called directly through validated TypeScript tools. Credentials remain outside Git. Google project and OAuth client display names may retain the original prototype name; those are existing connection identities, not runtime dependencies.

## Read-only Gmail and Calendar

`gmail_search`, `gmail_thread` and `gmail_read` expose bounded message results; no send, delete, label or attachment operation exists. Search accepts Gmail's own operator syntax, returns at most ten hits and, for each, fetches `format=metadata` limited to From, To, Subject and Date, so one call yields sender, subject, date, a snippet and an unread flag instead of bare identifiers. Each field is capped at 200 characters. A hit whose metadata fetch fails or exceeds the turn budget keeps its identifiers and carries a `detail` note rather than failing the search. A computed `hint` asks for a narrower query above 50 estimated matches and suggests widening when nothing matched; it is never written by the model. Metadata is not a parts listing, so no attachment flag is returned; `has:attachment` remains available as a search operator. Identical searches by the same owner are served from a five-minute in-process cache.

`gmail_thread` reads one conversation oldest first, capped at 4,000 characters per message and 16,000 characters in total, reporting which messages were truncated or omitted; `gmail_read` still returns one message up to 16,000 characters. HTML parts and attachments are never fetched or executed in any of the three. `calendar_list` reads the primary calendar with bounded time ranges. Each adapter checks the configured owner before network access. Email and event content may enter model context and is untrusted data.

Use `scripts/connect-gmail.mjs` and `scripts/connect-calendar.mjs` with a private desktop OAuth client JSON, output path and expected email. The loopback flows use state/PKCE, verify scopes/account identity and write private token files. Set the corresponding variables from `.env.example`; never print token files. Testing-mode OAuth grants may require reconnection.

## Sheets as viewing surfaces

Postgres is authoritative. Preparation uses Target roles / Preparation gaps / Preparation tasks. Daily use has Tasks / Notes / Schedules. Managed tabs are one-way mirrors: edits to them are overwritten on sync. The model cannot target arbitrary spreadsheets.

Use `scripts/connect-sheets.mjs` for `drive.file` plus identity authorization and `scripts/create-preparation-sheet.mjs` to provision the preparation workbook. Existing installations should reuse their configured workbook IDs. `sheet_sync` and `daily_sync` report actual results; database writes remain saved if sync fails. Cells use literal values to prevent formula execution. There is no durable Sheets synchronization outbox yet.

See [preparation setup](preparation.md), [daily assistant](daily-assistant.md) and [verification](verification.md) for limits and tested behavior. Existing grants do not permit email sending or calendar event creation.
