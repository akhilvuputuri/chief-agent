# Personal Google integrations

Status on 2026-09-06: local Gmail adapter implemented and tested, not deployed or authorized. Google project Hermes Companion (`peaceful-region-507806-s2`, project number 958009136813) created under akhilvuputuri@gmail.com; Gmail API enabled. Consent configuration has app name and contact details prepared, External audience; Google API Services User Data Policy accepted with explicit user approval; OAuth app identity saved. Desktop OAuth client form is prepared as Hermes Companion Personal Setup, but not submitted. No OAuth client or refresh token created yet.

## Gmail

`gmail_search(query,pageToken?)` returns up to 10 IDs and pagination; `gmail_read(messageId)` returns selected headers and bounded inline plain text. These are native Hermes tool calls through companion_action. No mail send, delete, label updates, attachment downloads, or HTML execution.

Required private configuration: GMAIL_OWNER_USER_ID (one paired Telegram ID), GMAIL_EMAIL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN. Configuration must remain outside version control and be transferred securely to the existing cloud deployment. Model requests cannot override account identity. The adapter checks mailbox identity on refresh and rejects other Telegram users before network access. Error bodies and credentials are not logged. Retrieved messages can enter normal conversation history and the configured LLM context; email text is untrusted evidence, never authority.

Remaining: user agreement; OAuth client and minimal gmail.readonly authorization; offline token capture with state/PKCE and loopback callback; configure cloud secrets; rebuild gateway and Hermes adapter; verify one read-only cloud API request and a Telegram request. Testing-mode authorization can expire; check Google's current publishing requirements before treating setup as persistent. Existing Telegram/voice remains running unchanged.

## Google Sheets as the job-search UI

User wants conversational Hermes behavior and a mobile-accessible Google Sheet, rather than a rigid workflow. Plan: Postgres remains authoritative; a dedicated sheet reflects roles and changes. Initial sync is one-way, agent/database to Sheet. Direct sheet edits are not imported and require a later conflict-handling design.

Suggested columns: stable job ID, company, role, location, posting URL, status, notes, next action, last updated. All roles from the initial LinkedIn shortlist are unapplied per explicit user correction. Store as saved, not applied. Avoid inventing next actions or qualifications.

Add a Hermes skill for how to maintain and explain the tracker, backed by a narrow Sheets tool. Skill text alone cannot supply OAuth or an API implementation. Prefer drive.file permission for an app-created spreadsheet, with a fixed configured spreadsheet ID; verify supported Sheets API methods with that scope. No broad Drive access is needed. Use RAW cell values to prevent formula injection, stable IDs for upsert, and durable retry/reconciliation for sync failures. Do not report synchronization successful until verified. No Sheets API setup, sheet creation, sync implementation, or skill loading is complete yet.

## Verification

25 Node tests and 4 Python adapter tests pass; TypeScript build and typecheck pass. Gmail tests use mocked HTTP, not a live authorized mailbox. Covers owner denial, wrong-mailbox rejection, pagination, plain-text extraction, and strict tool schemas. Live integration remains pending.

### Browser and skill direction

User asked for Hermes native capabilities and skills for researching LinkedIn links and following employer careers pages. Current deployed adapter allows only companion_action; upstream browser and skill tooling are not enabled. Existing web_search/web_read use Tavily but are unconfigured without a key. Codex's Chrome extension is not a cloud Hermes browser connection.

Prioritize a public web reader/search tool and Hermes browser tools in an isolated browser environment, then a job-research skill: resolve employer posting, confirm same title/location/requisition, extract supported requirements, preserve source URL and retrieval date, identify unavailable pages honestly, and avoid submitting applications. For authenticated LinkedIn, require a separately authorized browser session or ask user for the public employer URL/text. Do not move the user's complete Chrome profile or cookies into the cloud. Keep browser processes isolated from Gmail credentials and the database.

### OAuth client created — 2026-09-06

User approved credential creation and explicitly required read-only Gmail, with all sending performed manually. Desktop client Hermes Companion Personal Setup created. Private client JSON stored in hermes-companion-ops/google-client.json (0600, outside repo). Test account akhilvuputuri@gmail.com added; authorization reached the actual consent page, which requests only "View your email messages and settings." No authorization grant made yet.

scripts/connect-gmail.mjs prepares a 15-minute loopback-only callback with state and PKCE, exact gmail.readonly scope checking, mailbox identity verification and exclusive 0600 token-file creation. Syntax checked; live exchange still pending. Callback process started for this consent flow; restart if expired. Token destination hermes-companion-ops/google-gmail-token.json. Do not print token files. Consent Chrome tab 1543934429; console tab 1543934428. After consent, securely configure local/server environment and deploy/test. No Gmail runtime deployment yet.

### LIVE Gmail deployment — 2026-09-06 (latest status)

User completed Google consent. Exact granted scope verified: https://www.googleapis.com/auth/gmail.readonly; mailbox verified as akhilvuputuri@gmail.com. Refresh token stored privately outside repo; required environment values saved in local and cloud .env (0600). Gateway and Hermes rebuilt and started on DigitalOcean. Live cloud test successfully searched (10 results returned) and read one message; no message content was printed or logged by the test. All earlier pending-authorization/deployment notes above describe history and are superseded by this section.

App remains External/Testing. This is not yet a permanent authorization setup: Google testing refresh-token lifetime limitations need resolution through appropriate personal-use production configuration. Sheets remains planned, not implemented or authorized. Google client JSON download may still be present in the user's Downloads folder; authoritative private setup copy is in ops. Gmail has no sending/modification tools, and the OAuth grant cannot authorize those operations.
