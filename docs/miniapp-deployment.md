# Mini App HTTPS on DigitalOcean

The owner selected the existing DigitalOcean host and a free hostname on 13 September 2026. AWS migration is independent and does not block this interface. No new server, purchased domain, tunnel account or paid service is needed.

Origin: `https://companion.188-166-246-143.sslip.io`. sslip.io maps the embedded IP to the existing host. This is third-party free DNS, not an owned domain; availability and certificate issuance limits depend on that service. The hostname remains stable while the server IP remains unchanged. If the IP changes, update the origin and Telegram launch URLs as part of that migration. TLS keys stay on this server. DNS does not proxy application traffic.

## This milestone's boundary

`deploy/miniapp/Caddyfile` serves an explicit holding response at `/` and 404 elsewhere. Caddy manages public TLS and certificate renewal, including HTTP-to-HTTPS redirects. No reverse proxy, file server, database/API route, Telegram launch button or authentication has been added. Knowing this URL exposes no saved records. The existing application and Postgres stay on loopback; Telegram polling is unchanged. TLS availability must not be reported as a completed Mini App.

Do not forward all application routes when the frontend is added. Explicitly allow its static assets and authenticated Mini App API routes. Validate Telegram initData and freshness server-side, bind a short-lived session to the allowlisted Telegram owner, and enforce ownership on every canvas read. Never place initData, bot tokens or session credentials in URLs or access logs. Keep sensitive Calendar actions behind their existing explicit Telegram approval.

## Agreed application follow-up (not implemented here)

- Serve one TypeScript web interface from the existing application. The model produces validated component documents (prose, cards, tables, charts, evidence sections), never executable HTML/JavaScript.
- Store multiple named canvases and immutable revisions in Postgres. Keep schema version, stable block IDs, originating run and source references. Distinguish saved report snapshots from explicitly refreshed live data.
- Add owner-scoped create/read/list/update tools. Use idempotency for retried writes and transactionally compare the supplied base revision; reject stale updates rather than silently overwrite another revision.
- Link individual canvases/revisions from Telegram; provide a library to reopen earlier canvases. Start with read-only navigation; preserve existing approval flows.
- Trace formation and revision lineage, conflicts and retrieval without copying private content to public/cloud diagnostic logs.
- Review the additive schema migration separately under the existing deployment procedure. Ordinary app changes afterward continue through GitHub CI and release. No migration or Compose change is part of this HTTPS milestone.

## Operator installation

Inspect current release, running services and firewall first. This procedure assumes no existing web server/Caddy configuration; preserve and reconcile an existing installation rather than overwrite it. Use the authorized operator connection described in HANDOVER.md. Do not copy that SSH credential into a cloud task or repository.

1. Confirm `getent ahostsv4 companion.188-166-246-143.sslip.io` resolves to this server and ports 80/443 are unused. Record the existing firewall rules.
2. Install `caddy` from Ubuntu's signed package repositories (`apt-get update`, then `apt-get install --no-install-recommends caddy`). This host's package receives Ubuntu updates. Keep the firewall closed during initial package installation so the package's default page is not publicly served.
3. Copy the exact independently reviewed `deploy/miniapp/Caddyfile` to a temporary path. Run `caddy validate --config PATH --adapter caddyfile`. Save the packaged `/etc/caddy/Caddyfile` in a root-only operations directory; install the reviewed file as root-owned mode 0644.
4. Enable/restart the packaged `caddy` system service. Open only TCP 80 and TCP 443 in UFW; preserve SSH and all other rules. If a DigitalOcean cloud firewall also filters these ports, add equivalent web rules there. Do not expose 3000 or 5432.
5. Verify public HTTPS with normal certificate validation (never `-k`), the root holding response, HTTP redirect, and 404 for `/api/canvases`, `/healthz` and `/.env`. Inspect issuer, hostname and certificate expiry. Confirm Caddy is enabled after reboot and running. Check local application health and exact RELEASE are unchanged by this operator step.
6. Record the actual check results and reviewed configuration commit in the PR/issue. Do not claim renewal has already occurred; Caddy is configured to renew automatically. No access log is enabled. Monitor certificate renewal failures through the service journal without enabling request-body or authentication logging.

Caddy is a host service outside production Compose. Ordinary GitHub app releases neither install nor alter `/etc/caddy/Caddyfile`; a later proxy change requires an independently reviewed operator install. Document that boundary for cloud tasks. A separate narrowly scoped ingress deployment mechanism can be added later if needed, rather than granting unrestricted host access to every task.

## Recovery

A bad configuration should fail validation before installation. Restore the previously saved Caddyfile and reload/restart if needed. To remove this new endpoint, stop/disable Caddy and remove only the TCP 80/443 UFW rules added by this procedure; preserve pre-existing rules. This does not restart the assistant, alter Postgres, remove data or resume paused tasks. Preserve Caddy's certificate storage during ordinary upgrades/restarts to avoid unnecessary issuance and rate limits.

References: [sslip.io DNS and TLS](https://sslip.io/), [Caddy HTTPS](https://caddyserver.com/docs/quick-starts/https), [Telegram Mini App authentication](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
