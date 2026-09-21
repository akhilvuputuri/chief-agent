# Recurring Google authorization expiry

## Problem and evidence

On 21 September 2026 Gmail searches failed with authorization-required results. A bounded production check confirmed configured credentials and Google's `invalid_grant` response. The OAuth project's audience was still External / Testing, which imposes seven-day refresh-token expiry for Gmail access. The generic error cannot prove whether this particular token expired or was revoked.

## Decision

Repeated reconnection while leaving Testing enabled would repeat the failure. Prepare real informational and privacy pages on the existing HTTPS host, complete the OAuth branding, then obtain owner confirmation to publish and reconnect. This avoids new infrastructure and preserves Gmail read-only access. It does not eliminate all possible Google revocations.

## Changes and boundaries

Added static pages, an exact-route Caddy configuration and [operator recovery instructions](../google-authorization.md). Public pages contain no user records or executable scripts. The Mini App authentication path stays unchanged. The account publishing operation and credential replacement remain operator actions, not application self-service or automatic release actions.

## Validation and status

Prepared for independent review. Host configuration validation, owner confirmation of OAuth publication, token renewal and bounded Gmail verification are pending. Gmail has not yet been restored. Update this entry with actual outcomes rather than inferring success from a configuration change.

## 21 September operator follow-up

[PR #68](https://github.com/akhilvuputuri/companion-agent/pull/68) received independent GPT-6 Astra approval on `2bfdecf48ffb382dc617fb1c21c776fefa141699`. The host passed Caddy validation and the three static pages returned HTTP 200 after reload; Mini App remained 200 and an unrelated path remained 404. No gateway restart or application release was needed for the public pages. The owner explicitly approved the OAuth domain/publication change; Google then showed **In production**. Reconnection is waiting at Google consent; the expired production Gmail token has not been replaced yet.
