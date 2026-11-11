# 166 — Can the owner read Chief's traces from a phone, without exposing them to anyone else?

Work date: 2026-11-11 to 2026-11-12. Written: 2026-11-12.
Status: tested; rollout pending. agentwatch gained a sign-in ([agentwatch#21](https://github.com/akhilvuputuri/agentwatch/pull/21)); Chief sends agentwatch an API key with trace export and alert polls; three reviewed operator procedures install the gateway's key, switch on signing in, and add a Caddy site at `https://traces.52-77-47-24.sslip.io`. None of it is live yet.

## User-visible problem and preceding iteration

agentwatch, the trace viewer of issue #323, has run on the production host since 29 October ([journal 134](134-agentwatch-on-the-host.md), [tracing](../tracing.md)). It is published on the host's loopback only and has no login, so the owner can read it only through an SSH tunnel from a laptop. On 11 November the owner asked to view traces from a phone, or anywhere, behind a simple login, and chose a sign-in built into agentwatch over Caddy's `basic_auth`, as a side project based on open-source auth designs.

The traces hold the owner's full conversations, memory and tool results ([message content](../tracing.md#message-content)), so the risk is the same as exposing the database: the design has to keep them behind one password the owner chooses, and fail closed.

## Evidence

**Read from source, 11 November.** Before choosing a design, two research subagents surveyed Python auth libraries and how Phoenix and Langfuse sign users in; the key claims were then checked by hand against the source:

- Phoenix hashes passwords with PBKDF2-HMAC-SHA256 at `NUM_ITERATIONS = 10_000` and compares with `==` (`src/phoenix/auth.py`, read 11 November). OWASP's floor for PBKDF2-SHA256 is 600,000, so it was not copied.
- OWASP's Password Storage cheat sheet lists scrypt N=2^15, r=8, p=3 (32 MiB) among its equivalent minimums (read in the cheat sheet's source, 11 November).
- passlib has had no release since 2020 and breaks with newer bcrypt (reported by the research agent; not reproduced). The design therefore uses the standard library's `hashlib.scrypt`, `secrets` and `hmac`.

**Read on the host, 11 November.** Caddy 2.6.2 serves `companion.52-77-47-24.sslip.io`; agentwatch's port 4318 is published on `127.0.0.1` through Docker's port proxy, so a request from Caddy arrives from the Compose network's gateway, `172.18.0.1`, on `172.18.0.0/16`. The new site's Caddyfile passed `caddy validate` with the host's Caddy; `caddy adapt` showed the security headers applied after the proxy (deferred) and `/v1/*` answered by a static 404 before the proxy.

**Tested.** agentwatch's 33 sign-in tests and a Playwright test against a second server with signing in on; Chief's exporter and relay header tests; the three operator procedures' offline tests (key: 20, agentwatch update: 17, Caddy site: 9).

## Diagnosis and alternatives

- **Caddy `basic_auth`.** Ready the same day, but a browser prompt with no sign-out, no throttle on guesses, and nothing learned about how trace tools sign users in. Kept as the fallback.
- **An auth proxy (Authelia, oauth2-proxy).** Another service to run and patch for one owner.
- **A library (fastapi-users and others).** fastapi-users is in maintenance mode; Starlette's signed-cookie sessions cannot be revoked on sign-out.
- **Chosen:** a small module in agentwatch on standard-library primitives, following OWASP's cheat sheets and the Auth Book, with the shape of Phoenix's (off by default, Bearer keys for programs). The decisions and their reasons are in [agentwatch's design notes](https://github.com/akhilvuputuri/agentwatch/blob/main/docs/design.md#signing-in).

Once agentwatch requires signing in, Chief's two clients of it would be refused: the trace exporter (`/v1/traces`, `/v1/logs`) and the alert relay (`/api/alerts`). Both now send `Authorization: Bearer` with `AGENTWATCH_API_KEY` when it is set ([tracing](../tracing.md#viewing-traces-from-anywhere)), and agentwatch ignores the header while signing in is off, so the gateway can change first.

## Implementation and review

agentwatch ([#21](https://github.com/akhilvuputuri/agentwatch/pull/21)): `src/agentwatch/auth.py`, the `serve --auth-user`, `--api-key-env`, `--forwarded-allow-ips` and `--insecure-cookies` options, `agentwatch hash-password`, a sign-in page, and a Sign out button.

- The first browser test failed: the sign-in page sent `Referrer-Policy: no-referrer`, under which browsers send `Origin: null` with the form post, and agentwatch's host guard refused it as cross-site. The page now sends `same-origin`, and the Caddy site does too.
- Independent review (Opus 5.5) of `b330b24`: **request changes**. Measured by the reviewer: 80 wrong passwords sent at once were all checked (the throttle was read before and written after the check); during that burst an API call took 5.07 s, because waiting checks held the thread pool the API shares; and `--auth-user ""` started the server with no sign-in. Fixed in `83e1672`: an attempt counts as a failure from the moment it is let through, checks run one at a time on their own limiter with 503 beyond 8, and the CLI fails closed on an empty name or a hash without `--auth-user`. Re-review: **approved**, re-running its burst scripts (80 at once from one address: 5 checked; waves from new addresses: exactly 30 checked; 500 at once: an API call took 0.016 s). Its remaining low findings were addressed in `6cf1d8a` (tests that show the account cap and the limiter) and here (trusting only the network gateway's address, below).

Chief:

- [src/otel.ts](../../src/otel.ts) `agentwatchHeaders`, used by the exporter, [src/trace-alerts.ts](../../src/trace-alerts.ts) and both backfill CLIs; `AGENTWATCH_API_KEY` in the gateway's Compose environment.
- [scripts/deploy-agentwatch-key.py](../../scripts/deploy-agentwatch-key.py): the gateway release with that one Compose line, modelled on the Anthropic key's ([journal 161](161-enabling-direct-anthropic.md)); it requires a well-formed key in the private `.env` and never prints it.
- [scripts/deploy-agentwatch-update.py](../../scripts/deploy-agentwatch-update.py): now permits signing in, only as a whole: `--auth-user` with the password hash variable, `--api-key-env AGENTWATCH_API_KEY` with the key variable, and `--forwarded-allow-ips` equal to the Compose network's gateway as Docker reports it at deploy time. The reviewer showed that a wider range (`172.16.0.0/12`) would let a neighbouring container name any client address and get round the per-address wait. With signing in, its ingest check sends the key on curl's standard input, so the key is in no command line, then checks that the same requests without the key are refused, and rolls back if they are not.
- [scripts/deploy-traces-site.py](../../scripts/deploy-traces-site.py): adds the site to the live Caddyfile only if agentwatch already requires signing in, validates it beside the live file, reloads Caddy, checks through Caddy that `/` goes to the sign-in page, the API answers 401, `/v1/traces` 404 and `/healthz` reveals no count, checks that the Mini App's site still redirects, and restores the previous Caddyfile on any failure. `--remove` takes the site down the same way. The reviewed copy is in [ops/oauth-site/Caddyfile](../../ops/oauth-site/Caddyfile).

## Verification and outcome

Tested, not live. What the rollout will have to show: the gateway still exports and relays alerts with the key; agentwatch refuses requests without it; the site's certificate is issued and the checks above pass through Caddy; and the owner signs in from a phone and opens a trace from a Telegram alert link.

Limits: one account; sessions are kept in memory, so a restart (each agentwatch update) signs the owner out; 30 failed sign-ins an hour from many addresses keeps new sign-ins refused while it lasts; the API key has no scopes. The traces are now reachable from the internet behind one password, where before they needed an SSH key.

### Release closure

Pending: merge agentwatch#21 and pin its image; the owner adds `AGENTWATCH_PASSWORD_HASH` and `AGENTWATCH_API_KEY` to the host's `.env`; run the key rollout, then the agentwatch update, then the Caddy site; verify from a phone.
