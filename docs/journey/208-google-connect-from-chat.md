# 208 — Can the owner connect Google from the chat?

Work date(s): 2026-11-22. Written/revised: 2026-11-22.
Status: tested locally; not yet reviewed or released. Needs the operator rollout `scripts/deploy-google-connect.py`, then a "Web application" OAuth client in Google Cloud and its two settings in the server's `.env`.

> **Update, 22 November 2026:** live in `c5fa173` and switched on from the rollout, because the web client and its two settings were in place first; no real sign-in yet. See Release closure below.

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

> **Update, 22 November 2026:** approved by an independent review (Claude Opus 5.5) at `63cc336a` in one round; its notes are in Release closure below.

## Verification and outcome

Tested locally: the connect link's parameters for each connection; the callback stores a sealed connection and confirms, records the chosen address where none is configured, and rejects a wrong or reused state, the wrong account and different scopes; Gmail, Calendar and Sheets use a stored connection (web client) and otherwise the `.env` token (desktop client); `invalid_grant` on a stored or `.env` token marks it disconnected and notifies once; the feature is off without the two settings; migration 037 applies on PGlite; the deploy script's 28 offline tests.

Not verified: a real Google consent (scope strings Google returns for a web client, `include_granted_scopes=false` behaviour when the same account already granted other scopes to the client), the Telegram buttons on a phone, and the rollout on the host.

### Release closure — pending

Pending: independent review, merge with `BASE` set to the live release, `scripts/deploy-google-connect.py` on the host, the web client and its settings, and a first real connection.

> **Update, 22 November 2026:** the callback's scope check now accepts a sign-in when Google grants every scope the connection needs, extras included, and stores the scopes Google actually granted; it still refuses one with a needed scope missing. Google's web consent can report scopes the request did not name (`openid`, or one the same account granted this client earlier), and the exact match written first would have refused a good sign-in. Tested locally with a fake Google; still unmeasured against a real consent.

### Release closure — 22 November 2026

- **Merged:** [PR 533](https://github.com/akhilvuputuri/chief-agent/pull/533) as `c5fa173`; the merged tree equals the reviewed head `63cc336a`. Before review the scope check was changed to accept extras (the update above). The independent review (Claude Opus 5.5) read the rollout script against the earlier reviewed rollout scripts and approved in one round.
- **Review notes, non-blocking:** the "stays off at rollout" statements (below); a rotated web client secret makes stored connections unreadable until the owner reconnects with `/google`, as the Storage design says; Gmail token refreshes now go through the common Google error path, so a 429 or 5xx from the token endpoint has a different error shape than before; each `/google` creates one pending attempt per connection.
- **Web client:** before the rollout the owner created a "Web application" OAuth client in the same Google Cloud project, with the callback as its redirect address, and saved its ID and secret on the server as `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (checked by name and length only).
- **Rollout:** `scripts/deploy-google-connect.py` on the host against baseline `8d8fd50d`, with the gateway idle, late on 22 November (Singapore time). It reported `c5fa173` deployed, healthy, migration 37 and the Caddy route added.
- **Checked afterwards:** the host reports `c5fa173` with a healthy gateway; `runtime_migrations` has 37; `google_connections` and `google_oauth_attempts` exist and are empty; the Caddy file has the `/oauth/google/callback` route, and a request to it through the public address returns the gateway's 400 page (no state supplied), as the script's probe expects; the gateway has both settings and `MINIAPP_ORIGIN`; the automatic `checks` and `release` runs for `c5fa173` succeeded; a read-only search on each existing mailbox still works through the `.env` tokens.
- **Corrections:** the deploy script's docstring, the Rollout paragraph in [Google integrations](../google-integrations.md#connecting-from-the-chat-22-november-2026) and the "Next" line in `docs/current-work.md` say the feature stays off at rollout because the server has no web client yet. That was wrong by the time of the rollout: the settings were saved first, so the feature was on as soon as the new gateway started. The two docs carry dated notes; the docstring is code and is left for a later change.
- **Not yet done or measured:** a real sign-in through `/google` on the owner's phone (whether Telegram opens Google's page in a browser Google accepts, and the scopes Google actually reports), the confirmation message, and a reconnect after a real `invalid_grant`.

## Follow-up and next iteration

> **Update, 22 November 2026:** next, the owner tries `/google`; then the review notes above, and the deploy script's docstring.

Once a first connection works, the desktop client's `.env` tokens can be retired connection by connection.
