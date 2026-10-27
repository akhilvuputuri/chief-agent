# 124 — Why did the site root return an empty page?

Work date: 2026-10-27. Written: 2026-10-27.
Status: repository fix proposed; the live host still needs the operator install below. Caddy is a host service, so an ordinary release does not change it.

## User-visible problem and preceding iteration

Opening the site root (`https://companion.52-77-47-24.sslip.io/`) should redirect to the Mini App at `/miniapp/`. Instead it returns an empty `200`. [Journal 35](35-lightsail-private-logs.md) diagnosed this during the Lightsail move and listed the fix as future work. The same line has been in the repository Caddyfiles since `677683a` (PR #36).

## Evidence

- **Cause (tested):** in the Caddyfile, a first argument to `redir` that starts with `/` is a path matcher. `redir /miniapp/ 302` therefore means "for requests to `/miniapp/`, redirect to `302`". Inside `handle /`, the path is never `/miniapp/`, so the request falls through with no handler and Caddy writes an empty `200`. `caddy validate` accepts it.
- **Second effect (tested):** that empty `200` also skips the site-wide `header` block. Because the block deletes `Server`, Caddy defers all of its operations until a handler writes a response, and none does. The root response carried `Server: Caddy` and lacked `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy`. `/nope`, which reaches the `404` handler, had them.
- **Reproduction (tested, 2026-10-27):** Caddy v2.6.2, the version Ubuntu 24.04 installs on the host (journal 35). The repository Caddyfile was run locally with only the site address changed to `http://127.0.0.1:<port>`:

  | Config                          | `GET /`                      | Headers on `/`                                                   |
  | ------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
  | `redir /miniapp/ 302` (before)  | `200`, empty body            | `Server: Caddy`; no security headers                             |
  | `redir * /miniapp/ 302` (after) | `302`, `Location: /miniapp/` | `Cache-Control: no-store`, `nosniff`, `no-referrer`; no `Server` |

  Both configs pass `caddy validate`. `/nope` returns `404` with the headers in both. The same parse was confirmed against Caddy master (`71c5812`, 26 October 2026).

- **Upstream (reported):** [caddyserver/caddy#6517](https://github.com/caddyserver/caddy/issues/6517) discusses this trap. Maintainers proposed treating a single `redir` argument as the target, and adding a clearer error.

## Diagnosis and alternatives

Add the `*` matcher so the single argument is the target, as journal 35 suggested. The alternative of omitting the status and relying on Caddy's default was not tested. The explicit form keeps the status visible.

## Implementation and review

- `ops/oauth-site/Caddyfile` (the Lightsail host's ingress) and `deploy/miniapp/Caddyfile` (the retired DigitalOcean variant) now use `redir * /miniapp/ 302`. No other route changes.
- Independent review: pending for the exact head.

## Verification and outcome

Tested locally as above. Not live until the operator install runs.

### Operator install (pending)

The live `/etc/caddy/Caddyfile` has drifted from the repository: it has routes added by `scripts/deploy-boxes.py` and the coding worker ([gathering deployment](../gathering-deployment.md)). Do **not** copy the repository file over it. Change only the one line:

```sh
sudo cp -p /etc/caddy/Caddyfile /root/Caddyfile.before-124
sudo sed 's|redir /miniapp/ 302|redir * /miniapp/ 302|' /etc/caddy/Caddyfile | sudo tee /etc/caddy/Caddyfile.124 >/dev/null
sudo diff /etc/caddy/Caddyfile /etc/caddy/Caddyfile.124   # expect exactly one changed line
sudo caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.124
sudo mv /etc/caddy/Caddyfile.124 /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Verify from outside, with normal certificate validation:

```sh
curl -sSI https://companion.52-77-47-24.sslip.io/          # 302, Location: /miniapp/, Cache-Control: no-store, no Server header
curl -sSI https://companion.52-77-47-24.sslip.io/miniapp/  # 200
curl -sSI https://companion.52-77-47-24.sslip.io/healthz   # 404
```

Also confirm that the Mini App still opens from Telegram.

Rollback: `sudo cp -p /root/Caddyfile.before-124 /etc/caddy/Caddyfile && sudo systemctl reload caddy`.

## Follow-up and next iteration

- Record the operator install result and update this entry's status.
- The host runs Caddy v2.6.2 from the Ubuntu archive (2022). Upgrading it is a separate operator decision.
- A possible upstream contribution: make `redir` treat a single argument as the target, or warn when the target looks like a status code (caddyserver/caddy#6517).
