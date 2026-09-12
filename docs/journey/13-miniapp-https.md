# Free HTTPS foundation for the Telegram Mini App

## Problem and decision

Interactive Telegram messages are already shipped, but a Mini App needs a public HTTPS origin. The owner selected the existing DigitalOcean server and a free hostname. Use IP-address-based sslip.io DNS and a Caddy host service for TLS; keep AWS migration independent.

## Change and boundary

The versioned Caddyfile exposes only a holding response and 404s. It does not expose the existing application, any private records, or a premature Telegram launch button. The [deployment guide](../miniapp-deployment.md) records installation, rollback, free-DNS/IP dependencies, the operator-only configuration boundary and the next canvas implementation.

The agreed canvas model supports multiple persistent documents, immutable revisions and explicit conflict detection. That frontend, authentication, schema migration and agent tools remain future work; this change only establishes HTTPS ingress. No application or database behavior changes.

## Validation and release evidence

Before installation, validate the exact config with Caddy, obtain the required independent review, and wait for CI. After installation, verify trusted TLS, redirect, default-deny paths, service persistence and unchanged local application health. Record actual results and reviewed/deployed SHAs in the PR and issue #26; preparation of this document alone is not evidence of a live endpoint. No paid model evaluation is relevant to this change.
