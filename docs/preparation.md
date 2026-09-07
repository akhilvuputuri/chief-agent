# Conversational preparation and Sheets

Postgres is authoritative. The TypeScript agent chooses tools conversationally. The Google workbook is a one-way viewing mirror with three managed tabs: Target roles, Preparation gaps, Preparation tasks. User edits inside those tabs are overwritten on the next successful sync; extra tabs are untouched. No application submission or email sending is available.

## Tools and evidence

- `web_search(query)`: Tavily if configured; otherwise an isolated OpenRouter/Exa search request using the configured model, three results and a 1,000-token output limit. No conversation history or saved profile is attached. Only provider citation annotations are returned, not the model's uncited prose. Search incurs OpenRouter search/model charges.
- `web_read(url)`: Tavily if configured; otherwise Jina Reader. Public HTTPS hostnames only; retrieval happens at the hosted provider, not on the private server network. No cookies or credentials are forwarded. Store the bounded content as an owner-scoped source with retrieval time and return `sourceId`. Login walls and rate limits may prevent retrieval; accept pasted listing text instead.
- `prep_save(id, topic, importance, sourceQuote, assessment, sourceId?, evidence?, question?)`: upsert one topic for a saved role. Required/preferred/inferred are distinct. The quote must exist in the saved listing description or the specified retrieved source. Strength/gap requires nonempty background evidence; unknown requires a question. Semantic truth remains the model/user's responsibility, not something a string check proves.
- `prep_list(id?)`: return requirements and shared tasks, bounded to 500 each. The sheet export uses the complete snapshot up to 5,000 rows per tab and fails rather than silently truncating above that.
- `prep_task_save(topic, exercise, completionCriteria, priority, status?)`: shared lowercase topic identifies a task across roles. Omitting status preserves progress. Task criteria should be demonstrable (e.g. retrieval evaluation on a small labeled dataset), not vague reading goals.
- `sheet_sync()`: exports a consistent owner-scoped database snapshot. One atomic Sheets batch updates all tabs, removes stale managed cells, freezes/stylizes headers and adds filters. Literal string cell values prevent formula execution from external text. The agent is instructed to sync after changes. This is agent-triggered, not a background outbox; retry through Telegram if it fails. Database saves survive sync failure.

Do not equate missing resume information with lack of skill. Ask at most three focused questions at once. Do not label inferred interview topics as explicit hiring requirements, invent experience, or assign numeric hiring probabilities.

## Google setup

1. Enable Google Sheets API in the existing Google Cloud project.
2. Run `node scripts/connect-sheets.mjs CLIENT_JSON TOKEN_JSON EXPECTED_EMAIL`. Complete Google consent in the browser. The loopback callback uses state and PKCE, verifies exact scopes and account identity, and writes a private token file without logging secrets.
3. Run `node scripts/create-preparation-sheet.mjs TOKEN_JSON SHEET_JSON` once. It creates private tabs with IDs 0, 1, 2; no sharing is added. Do not retry creation after an uncertain result without checking Drive for an existing workbook.
4. Set `SHEETS_OWNER_USER_ID`, `SHEETS_REFRESH_TOKEN`, `SHEETS_SPREADSHEET_ID` plus existing Google client fields in private local/cloud environments. Recreate the gateway.
5. Call `sheet_sync` and verify the returned URL and counts. Gmail's separate token and `gmail.readonly` scope remain unchanged.

Sheets consent requests `drive.file`, `openid`, and email identity. The application only targets its fixed provisioned spreadsheet; the model cannot choose another file. `drive.file` is supported by the Sheets API and avoids broad access to all spreadsheets. Google OAuth testing-mode token lifetime remains an operational limitation; do not assume permanent refresh-token validity.

## Verification

Tests cover owner isolation, source ownership, quote validation, unknown/gap evidence requirements, upsert identity, progress preservation, literal sheet cells, provider failure propagation and uncited search rejection. Live provider checks and cloud health checks are recorded in HANDOVER.md. Public page content is untrusted and may be stale, incomplete or malicious; exact-quote validation is provenance checking, not protection against every semantic hallucination.

References: [Sheets create](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create), [OpenRouter search](https://openrouter.ai/docs/guides/features/plugins/web-search), [Jina Reader](https://jina.ai/reader/).
