# 208 — Can the owner connect Google from the chat?

Work date(s): 2026-11-22. Written/revised: 2026-11-22.
Status: tested locally; not yet reviewed or released. Needs the operator rollout `scripts/deploy-google-connect.py`, then a "Web application" OAuth client in Google Cloud and its two settings in the server's `.env`.

## User-visible problem and preceding iteration

Gmail (two mailboxes), Calendar and Sheets were connected once by hand: an operator ran `scripts/connect-gmail.mjs`, `connect-calendar.mjs` or `connect-sheets.mjs` on a computer with a desktop OAuth client and pasted the refresh token into the server's `.env`. When a token broke (`invalid_grant`), Chief could only say "reconnect", and reconnecting needed a computer and a server edit. IBKR already had an in-chat flow ([IBKR portfolio](../ibkr-portfolio.md), issue #146): a Telegram command sends a link button, the owner signs in on the phone's browser, the server's callback stores the sealed connection and Chief confirms. The owner asked for the same for Google, with the account chosen in Google's own picker, and for Chief to offer the button by itself when a Google connection stops working.

## Evidence

- **Reported (owner, 22 November 2026):** the request above, with the standing directions to build the simple version that works in ordinary use, keep only real boundaries, and copy the IBKR flow's shape.
- **Reported (Google's documentation, not re-checked here):** consent must open in a real browser, not an embedded web view; a refresh token stops working if access is revoked, after six months unused, or on a password change for Gmail scopes; a consent screen in "Testing" status issues refresh tokens that expire after seven days.
- **Tested (local, synthetic):** `tests/google-connect.test.ts` against a fake Google and migrations applied on PGlite; `scripts/test-deploy-google-connect.py` offline. No call to Google, Gmail or production was made.

## Diagnosis and alternatives

The connection itself was fine; what was missing was a way to make one without a computer and a server edit. Chosen: a standard web-client OAuth flow served by the gateway on the existing public host, shaped like the IBKR flow (PKCE, single-use state stored hashed, claimed before the code exchange), with the connections in their own tables because the brokerage tables only allow `provider='ibkr'`. Stored connections take precedence over `.env` tokens, which remain the fallback, so nothing changes until the owner connects from the chat.

Choices and what was left out:

- **Sealing key.** Derived with HKDF from the web client secret rather than a third setting; replacing the secret means reconnecting.
- **No revoke on reconnect or on refused scopes.** Google's revoke ends every connection the account has with the client, which would cut Calendar when Gmail is reconnected on the same account.
- **No daily attempt limit** (IBKR has five a day); not needed for a single owner.
- **The tool sends the button at once** instead of queueing an approval card after the reply as `portfolio_connect` does; a connect button changes nothing until the owner finishes on Google's page.
- **Mail index and gathering** still start only with the `.env` Gmail token, as before; the tools themselves use a stored connection.
- **A second mailbox without `GMAIL_SECONDARY_EMAIL`** can be connected, but Gmail only uses the second mailbox when that address is configured.

## Implementation and review

- `src/google-connect.ts`: the four connections and their scopes (exactly those the scripts request), `begin`, `complete`, the stored-connection reader, the broken-grant notice, `/google`'s view and the callback route.
- `src/calendar.ts` `googleGrant`: one refresh path for Gmail (`src/gmail.ts`), Calendar, the preparation Sheet (`src/sheets.ts`) and the daily Sheet; on `invalid_grant` it marks the connection disconnected, sends one reconnect button and raises an error the model sees as "a reconnect button was sent" (`src/tool-errors.ts`).
- `google_connect` tool (core, offered only with the feature on) and the `/google` Telegram command.
- `db/037_google_connections.sql`, its Compose line, `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in Compose, the `/oauth/google/callback` route in `ops/oauth-site/Caddyfile`, and `scripts/deploy-google-connect.py` (from `deploy-study-list.py`, with the Caddy step from `deploy-boxes.py`) with its offline test.

Independent review: pending.

## Verification and outcome

Tested locally: the connect link's parameters for each connection; the callback stores a sealed connection and confirms, records the chosen address where none is configured, and rejects a wrong or reused state, the wrong account and different scopes; Gmail, Calendar and Sheets use a stored connection (web client) and otherwise the `.env` token (desktop client); `invalid_grant` on a stored or `.env` token marks it disconnected and notifies once; the feature is off without the two settings; migration 037 applies on PGlite; the deploy script's 28 offline tests.

Not verified: a real Google consent (scope strings Google returns for a web client, `include_granted_scopes=false` behaviour when the same account already granted other scopes to the client), the Telegram buttons on a phone, and the rollout on the host.

### Release closure — pending

Pending: independent review, merge with `BASE` set to the live release, `scripts/deploy-google-connect.py` on the host, the web client and its settings, and a first real connection.

## Follow-up and next iteration

Once a first connection works, the desktop client's `.env` tokens can be retired connection by connection.
