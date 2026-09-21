# Telegram Mini App and persistent canvases

The Mini App is a small browser client served by the existing TypeScript application. `/canvases` or `/app` in a private Telegram chat returns an Open Chief button. The library offers separate named canvases and a read-only Roles tab. The application remains on DigitalOcean; the free HTTPS origin and Caddy installation are described in [deployment](miniapp-deployment.md).

## Creating and revisiting content

Ask the assistant to save a result as a canvas, for example “Make a preparation canvas from these saved roles, keeping unknowns and sources visible.” The model chooses among text, expandable details, tables, cards, timelines and nonnegative bar charts. No arbitrary HTML, generated JavaScript, remote images or custom CSS is accepted. Canvas text is rendered using textContent, so Markdown/HTML inside it is plain text. Telegram replies retain their existing formatting and natural model-written prose.

New topics create separate canvases. Refining an existing topic creates another immutable revision. A library entry opens the latest revision. The revision selector opens historical content; a twenty-second check while the window is visible offers an explicit Open latest revision button if a newer one appears. It never silently replaces the document being read. Older revisions remain accessible through paginated history. Opening or filtering a view does not call a model, regenerate analysis or authorize a Calendar event.

Canvases are saved snapshots. Sources describe the stored answer; they are not independently verified by the renderer. Saved roles are a separate live view of current records and do not create a canvas or rerun research. Filters apply to loaded pages; Load more retrieves additional records. The first release does not include inline editing, approvals, exports, automated answer-to-canvas conversion, or a separate non-Telegram login. Existing inline-message views remain available.

## Runtime contract

- `canvas_create(requestKey,document)` saves a named document. Use a UUID requestKey per intended write and reuse it only for an identical retry.
- `canvas_update(id,baseRevision,requestKey,document)` reads and reconciles the current revision before updating it. Block IDs should stay stable when refining the same content.
- `canvas_list(offset)` pages twenty titles/IDs/latest revisions without loading every document into context.
- `canvas_read(id,revision?,offset)` retrieves 8,000-character chunks. Pin the returned revision for subsequent chunks to avoid mixing versions while another update occurs.
- `finish_turn.canvases` is an optional array of `{id,revision?}`. The delivery layer checks ownership/existence again before constructing a Telegram web_app button. The main reply stays independently useful. Invalid or unavailable references do not produce links.

Schemas are in `src/canvas-schema.ts`: version 1, at most thirty uniquely identified blocks, fifty sources and 100 KB serialized content. Tables enforce matching column counts, all fields are bounded, and unknown/executable fields are rejected. Source URLs must be HTTP(S). A supplied sourceId must belong to the authenticated owner and match the saved source URL exactly. This checks record provenance, not whether the claim is semantically supported. The runtime's existing write journaling/cancellation/uncertain-outcome rules remain in force; writes are never automatically retried as reads.

`canvases` stores ownership, current title and latest revision. `canvas_revisions` stores documents, originating runs, timestamps and unique per-owner request keys/hashes. A single SQL statement atomically updates the head, inserts its immutable revision and emits a metadata event. The head update compares the supplied base revision; concurrent updates cannot both succeed. Exact repeated requests return the recorded revision. A reused request key with changed content is rejected. An unsuccessful insertion rolls back the whole statement. Revisions have no update/delete API. Storage is additive; no data is reset and no paused task is resumed.

## Authentication and public surface

Telegram's official SDK supplies initData. The browser sends it in a POST body to `/api/miniapp/session`. The backend rejects duplicate parameters, verifies Telegram's HMAC in constant time, validates a numeric user ID against the existing allowlist, and accepts launch timestamps at most five minutes old with thirty seconds of future clock tolerance. Data received from the page never determines permissions before verification.

The backend returns a signed thirty-minute bearer session, derived using a domain-separated key from the bot token. The browser holds it only in module memory, uses an Authorization header, and clears it on reload/close; it is never written to localStorage, cookies, URLs or logs. This supports embedded Telegram Web without relying on third-party cookies. The allowlist is checked on every authenticated request. A bot-token rotation invalidates all sessions; expiry requires reopening from Telegram. A copied signed launch or bearer token remains usable until its short expiry, so neither must be exported or logged. No device binding or server-side revocation list is claimed.

Public static files are exactly `/miniapp/`, `/miniapp/app.js` and `/miniapp/app.css`. The API has session creation plus authenticated GETs for canvas list/read/history/head and role list/detail. There is no public tool dispatcher or write/approval endpoint. APIs return no-store and no CORS grant; foreign Origin headers are rejected, session exchange requires the configured exact Origin. Authorization headers prevent cookie-based CSRF. A bounded per-process global allowance of 300 API requests/minute limits ingress; this is a personal-app control, not distributed abuse protection. Error responses and diagnostics exclude launch data, session tokens and private request bodies.

CSP allows the app's own scripts/styles, the official Telegram SDK and same-origin fetches; it disallows generated inline scripts and external data requests. Outgoing source links use HTTP(S), no embedded credentials, noopener and noreferrer. Page data is inserted as text nodes. Requests from abandoned views are aborted; old responses cannot overwrite newer navigation. Saved data is private even though the static shell is publicly reachable.

## Observability

`canvas.revised` is committed with its revision and includes canvas ID, base revision and new revision. Its run ID connects to existing conversation/model/tool traces. `canvas.conflict` records stale/current revision metadata. Agent `canvas.read` events include offset and originating run; `canvas.viewed` records actual document retrieval by the Mini App and its originating run. Head polling emits no viewed event, so it does not inflate document-view counts. Runtime calls keep the full private arguments/results and normal receipts.

This establishes which run formed a revision and which later run retrieved it. Retrieval is not proof the model used it in a conclusion. A view event means a document was retrieved, not that the person read every block. The restricted cloud diagnostics command adds seven-day aggregate event/run counts; the root-owned handler needs the same reviewed operator update as earlier diagnostic additions. Full document/private trace inspection remains an authorized operator task; no private content is added to Actions logs.

## Development and verification

`npm test` now builds the browser TypeScript entry before running tests; no frontend framework, bundler or extra runtime service is required. Static HTML/CSS are under `web/`; `src/miniapp-ui.ts` emits one browser module. The Docker image includes web assets. `MINIAPP_ORIGIN` is empty by default, disabling public routes and model canvas tools; production uses the configured HTTPS origin without a trailing slash.

PGlite/Fastify injection checks cover independent canvases, immutable history, idempotency, concurrent conflicts, owner isolation, exact source ownership, invalid content, duplicate/stale/future/tampered Telegram launches, forged/expired sessions, absent write routes, owner-checked Telegram links, migration reruns and conversation → write → observation → finish envelope. Synthetic browser checks cover phone layout, multiple canvases, historical/latest revisions and saved-role navigation. Tests use no production secrets or paid model calls. A real Telegram launch and model-chosen canvas are separate live acceptance checks.

See [rollout](miniapp-deployment.md) before deploying migration 011 and updated ingress. Migration 010 is reserved by the unfinished memory checkpoint and is not part of this release.
