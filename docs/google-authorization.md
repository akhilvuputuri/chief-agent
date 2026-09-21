# Long-lived Google authorization

Google External OAuth apps in Testing issue seven-day refresh tokens for the Gmail scopes used here. Production removes that specific expiry rule, not Google's ability to revoke authorization. Password/security changes, revocation and other Google policies can still require reconnection.

On 21 September 2026 the production Gmail refresh request returned HTTP 400 `invalid_grant` / `Token has been expired or revoked`. Two Gmail tool calls failed at 14:46 UTC; prior recorded success was 11 September. Cloud Console showed Testing. This establishes a recurring-expiry configuration, although the generic error alone cannot distinguish expiry from revocation.

## Operator recovery

1. Complete OAuth branding with real, publicly accessible app information and privacy URLs. `ops/oauth-site` contains static informational pages and an explicit-route Caddy configuration for the existing HTTPS host. They have no data API, JavaScript or credentials. Inspect the actual host configuration before installation; preserve any independently added routes. Validate Caddy before reload and check that unrelated routes remain closed. These files are not installed by an ordinary application release.
2. With owner confirmation, change Google Auth Platform → Audience from Testing to In production. This changes OAuth eligibility beyond the test-user list; application owner restrictions remain necessary. Personal use may qualify for Google's verification exception, but publishing does not confer verification. Do not bypass warnings or claim tokens cannot expire.
3. Issue a new Gmail authorization using `scripts/connect-gmail.mjs` with the existing desktop client, an exclusive mode-0600 output file and the expected owner mailbox. The helper requests only gmail.readonly and verifies the mailbox. Never log token/code responses.
4. Update only the server Gmail refresh token in its private .env, preserving permissions and other integrations. Recreate the gateway only after checking active work; do not reset tasks, resume old work, or deploy unrelated code.
5. Verify token refresh, mailbox identity and a bounded read-only Gmail request. Keep email content and credentials out of issue/PR logs. Confirm separately whether Calendar and Sheets credentials also need renewal; their tokens/scopes are separate.

## Sources

- https://support.google.com/cloud/answer/15549945
- https://support.google.com/cloud/answer/13464323
- https://developers.google.com/identity/protocols/oauth2

## Current status

On 21 September 2026, independent GPT-6 Astra review approved `2bfdecf48ffb382dc617fb1c21c776fefa141699`. The host validated and installed the static routes: `/about`, `/privacy`, `/terms` and existing `/miniapp/` returned 200; an unrelated path returned 404. Following explicit owner confirmation, branding was saved and Google Audience showed **In production**. The owner completed consent. Both the renewed primary credential and a separately authorized secondary mailbox passed token refresh, expected-mailbox identity and a bounded read-only message-list request. Only the primary refresh token was replaced in the production environment; the idle gateway was recreated using its existing image, and token refresh from the running gateway returned HTTP 200. The secondary credential is stored separately in an owner-only server file and is not wired into runtime tools; current Gmail tools still support one mailbox. No credential values or email content are retained in this documentation.

## Multiple read-only mailboxes (v0.3.19)

The primary mailbox keeps `GMAIL_EMAIL` and `GOOGLE_REFRESH_TOKEN`. An optional second mailbox uses `GMAIL_SECONDARY_EMAIL` and `GMAIL_SECONDARY_REFRESH_TOKEN`, with the same OAuth client and authenticated Telegram owner. Set both secondary fields together after independently authorizing and checking that account. Each account has its own access token, identity check and search cache; the per-run request allocation is shared. The gateway has explicit Compose environment mappings; both new settings must be passed through. This Compose change requires the reviewed operator rollout below. Gmail itself needs no database migration.

`gmail_accounts` returns owner-scoped selectors and email addresses, never credentials. Search, read and thread tools accept `account`: `primary`, `secondary`, or a connected email address. Omission preserves primary behavior, including existing daily email briefings. Unknown accounts fail without fallback. To search both, the model calls each separately and reports any account failure explicitly; page tokens and message/thread IDs must be reused with their source account. Results and successful tool receipts carry the selected account. This is two-mailbox support, not arbitrary account self-service; adding accounts or consent remains an operator action. No sending or inbox mutation is enabled.

Operator rollout: verify the secondary credential with the existing helper, copy only its refresh token and expected mailbox into the two new environment fields without logging values, then use the reviewed operator procedure below to recreate the idle gateway. Verify `gmail_accounts` and bounded searches for both accounts through the deployed GmailTools implementation. Rollback leaves the additional environment fields unused by old code. Never copy production credentials into GitHub or a developer checkout.

### Reviewed rollout from the current live baseline

The live baseline `25aa0e33af9f620b27b29f98f07d0978d4d165cb` predates the already-merged stock-watchlist migration 018. Automatic release correctly refuses this DB/Compose difference. The reconciled `scripts/deploy-watchlist.py` accepts that exact app-only baseline, preserves all existing migration bytes and permits only migration018 plus the stock-provider and secondary-Gmail environment mappings. It locks release, builds before interruption, refuses active/queued work, applies additive 018, and restores the old application/Compose on startup failure. No stock provider, watchlist, alert or paid service is configured by this rollout.

After exact-head independent approval and CI, transfer the exact merged Git archive and reviewed `scripts/deploy-watchlist.py` to the server, then run `python3 deploy-watchlist.py ARCHIVE SHA`. Never skip baseline, schema or Compose checks. Verify RELEASE, startup health and migration marker18, followed by the Gmail account smoke check. The script changes do not replace the trusted cloud-release command; subsequent ordinary releases work once live DB/Compose match main.

Verified rollout: v0.3.19 deployed as `452b4fd` with healthy gateway, migration18 and bounded searches passing for both accounts. See [journal closure](journey/27-multiple-gmail-accounts.md#verified-release--21-september-2026).
