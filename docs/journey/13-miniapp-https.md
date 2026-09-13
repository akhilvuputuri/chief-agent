# Free HTTPS foundation for the Telegram Mini App

Work date: 2026-09-13. Revised: 2026-09-14.
Status: released v0.3.3; HTTPS origin subsequently extended by v0.3.5 canvases.

## Problem and decision

Interactive Telegram messages are already shipped, but a Mini App needs a public HTTPS origin. The owner selected the existing DigitalOcean server and a free hostname. Use IP-address-based sslip.io DNS and a Caddy host service for TLS; keep AWS migration independent.

## Change and boundary

At this milestone the versioned Caddyfile exposed only a holding response and 404s. It did not expose the existing application, private records or a Telegram launch button. The [deployment guide](../miniapp-deployment.md) records installation, rollback, free-DNS/IP dependencies, the operator-only configuration boundary and the next canvas implementation.

The agreed canvas model supports multiple persistent documents, immutable revisions and explicit conflict detection. That frontend, authentication, schema migration and agent tools were future work for this change, which only established HTTPS ingress; they later shipped as [persistent canvases](14-persistent-canvases.md). No application or database behavior changes.

## Validation and release evidence

The acceptance plan required exact Caddy config validation, independent review and CI before installation, followed by trusted TLS, redirect, default-deny path, service-persistence and unchanged local application-health checks. The verified outcome is recorded below; the deployment guide retains the operator procedure. No paid model evaluation is relevant to this change.

## Release closure — 14 September 2026

[v0.3.3](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.3) shipped [PR #35](https://github.com/akhilvuputuri/companion-agent/pull/35) at `750df06fc9957931b144c011226079d4fe551c42`. The [release workflow](https://github.com/akhilvuputuri/companion-agent/actions/runs/34712863362) completed successfully for that exact SHA; published release evidence records deployment and health verification. Astra approved `bc57c982b131b7e7cf8b0fabe85b4eebf12c1698`; 124 local tests, typecheck/build/format and GitHub checks passed. The separately installed Caddy service passed trusted TLS, hostname/expiry, redirect, holding-response and private/unknown-path 404 checks, with loopback-only application/database/admin services and reboot enablement. An actual certificate renewal cycle had not been observed. The free-DNS/IP dependency remains; later canvas deployment changed the reviewed exposed routes.
