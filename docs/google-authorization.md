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

On 21 September 2026, independent GPT-6 Astra review approved `2bfdecf48ffb382dc617fb1c21c776fefa141699`. The host validated and installed the static routes: `/about`, `/privacy`, `/terms` and existing `/miniapp/` returned 200; an unrelated path returned 404. Following explicit owner confirmation, branding was saved and Google Audience showed **In production**. The owner must still complete Gmail consent; token renewal and production Gmail verification remain pending. No claim of restored Gmail access until those checks pass.
