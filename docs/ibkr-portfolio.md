# IBKR portfolio access and quote-provider evaluation (issue #146)

Status: **Phase 0 measured; Phase 1 implemented, not yet reviewed or deployed (3 October 2026).** Phase 0: registration, read-only consent through the local probe, rotating refresh, a 12-hour idle refresh, the tool catalogue, owner-reconciled holdings and one real-time quote. Phase 1: holdings in Chief, through `/portfolio` and the `core/portfolio` agent, behind `IBKR_PORTFOLIO=off`. Written 2 October 2026 SGT against freshly fetched `origin/main` `ae0237f4337a640937d36ed6e742c5fdef7ae9b7`. The issue's research baseline (`78ad212`) is superseded by PRs #148, #150 and #151, none of which touch the stock subsystem. Refetch main before implementing.

Product requirement: [issue #146](https://github.com/akhilvuputuri/chief-agent/issues/146). Related design: [stock watchlist](stock-watchlist.md), [plugins](plugins.md), [Library identity](library.md), [Google authorization](google-authorization.md), [coding runtime ingress](coding.md).

## 1. What exists today

The facts below are from code inspection of `ae0237f`.

- **Market data only.** `src/stock-provider.ts` defines `MarketDataProvider` (`search`, `quotes`, `creditsPerMinute`, `supportsExtended`). Twelve Data is the only implementation. Its `rowToQuote` hardcodes `delayed: true`, and the only place that flag is read is the alert text "(delayed ~15m)" at `src/stocks.ts:590`.
- **Instrument identity.** An instrument is identified by `watchlist_items.symbol` plus `mic_code`, with `UNIQUE(user_id,symbol,mic_code)` (`db/018_watchlist.sql`). It has no broker contract ID. `src/market-calendar.ts` covers only US MICs, and `watchlist_add` refuses anything else. The limit is 25 items per owner.
- **Monitor.** `StockMonitor.tick` is deterministic: it gates by calendar, session and window, fetches paced batches, and checks freshness and suspicious moves. Alerts are deduplicated per item per trading day, and delivery uses the outbox with `uncertain`. It makes no model calls.
- **Tools.**
  - The `watchlist_*` operations are withheld from the coordinator and granted to the `core/stocks` agent (`plugins/core/plugin.json`, `plugins/registry.json`).
  - `runtime.ts:93` disables them when no provider is configured.
  - Only `watchlist_list` is in `readOperations` (`src/execution.ts`). Every other operation is a write and is guarded by the owner-wide uncertain-write check.
- **OAuth precedent.**
  - Google consent runs through operator loopback scripts (`scripts/connect-*.mjs`), and refresh tokens live in the server `.env`. Rotation is never persisted and there is no refresh lock.
  - The app has **no server-side OAuth callback or state store**.
- **Encrypted runtime credentials.** `src/secret-box.ts` (AES-256-GCM with AAD) seals `library_identities.token_box` and coding results. This is the right container for IBKR tokens.
- **Phone-usable linking precedent.** `/library link` sends a Telegram approval card, then runs a detached ceremony with an attempt journal, one live attempt and a deadline (`src/library-link.ts`).
- **Ingress.** Caddy at `companion.52-77-47-24.sslip.io` (`ops/oauth-site/Caddyfile`) allows only `/about`, `/privacy`, `/terms`, `/miniapp/*` and `/api/miniapp/*`. A callback route needs both a reviewed Caddy change, installed by the operator, and a Fastify route.
- **No MCP client exists.** There is no `@modelcontextprotocol/sdk`, no JSON-RPC client and no SSE client.
- **Migrations.** The latest on main is `025_subscriptions.sql` (added by PR #142 after this plan was first written), so the next is **026**. Default-off features check their migration only when enabled, as `main.ts` does for 016, 023 and 024.

## 2. External evidence (refreshed 2 October 2026 SGT)

Measured with unauthenticated requests from a development machine:

- `GET …/mcp-public/.well-known/oauth-protected-resource` returns 200 with scopes `mcp.read` and `mcp.write`, and header bearer.
- `GET https://api.ibkr.com/.well-known/oauth-authorization-server` returns 200. It advertises authorization-code with PKCE S256, `refresh_token`, a `registration_endpoint`, a `revocation_endpoint` and a `userinfo_endpoint` with an `account_ids` claim. Three facts here are **new relative to the issue**:
  - the advertised scopes also include `openid`, `profile`, `email`, `account-ids` and **`mcp.orders.submit`**;
  - `client_credentials` is advertised;
  - `none` is an allowed token-endpoint auth method, which means a public client.
- `POST /v1/api/mcp-public` with an unauthenticated `initialize` returns 401 with `WWW-Authenticate: Bearer resource_metadata=…`.

Reported by IBKR's [consent guide](https://www.ibkrguides.com/clientportal/gen-ai-instructions.htm): the connection is set up from IBKR's portal by choosing Claude, ChatGPT, Grok or Perplexity. It grants read access to "account, portfolio, and related information" and allows "non-binding instructions" that the client confirms in an IBKR app. The guide states no consent lifetime. Revocation is under Settings → Manage Third-Party Consents. Market-data availability is not stated. The product page returned HTTP 403 to automated fetching.

Not established: whether IBKR accepts a client registered by an arbitrary third party, the authenticated tool catalogue, token lifetimes, quote availability, pacing, or entitlements. Third-party community "IBKR MCP" servers are not evidence about the official server.

## 3. Analysis: risks that decide the shape of the work

1. **Third-party client eligibility (gating).** The consent guide frames access as picking a supported AI vendor connector. A registration endpoint is advertised, but IBKR may allowlist redirect URIs, client names or registrations. Library is a direct precedent: the catalogue works, but the provider refuses third-party card linking. Nothing else should be built until a registered Chief client completes consent and lists tools.
2. **Unattended refresh.** Refresh-token lifetime, rotation and any absolute session cap are unknown. Brokerage-session rules in the conventional Web API (daily resets, competing sessions) may or may not apply to MCP. If consent must be repeated often, MCP cannot support unattended quotes, though it may still support occasional holdings sync.
3. **Write-capable surface.** The server advertises `mcp.write` and `mcp.orders.submit`. Chief must request only `mcp.read`, plus `openid account-ids` if needed for account selection. It must check the granted `scope` in the token response, and revoke and fail closed if any write or order scope is granted. Tool calls go through a static allowlist enforced by a boundary test, like `src/library-routes.ts`. The model never names an MCP tool.
4. **Data semantics.** Positions must be keyed by IBKR `conid` and account, never by ticker. Quantities can be fractional, there can be several accounts, and responses can be partial, paginated or empty. Holdings in FX need care. A failed or partial sync must never replace the last complete snapshot.
5. **Quote replacement.**
   - IBKR may need paid market-data entitlements (the comparison point is US$1.50 per network per month), and those may not apply to MCP.
   - Quotes for non-held symbols are unknown.
   - Previous close, timestamps and session flags must exist, or the monitor's freshness and corroboration checks cannot run.
   - The monitor's pacing model is credits per minute; IBKR's limits are unknown.
6. **Integration gotchas in this codebase.**
   - `agentCatalogue` hides an agent unless **all** of its tools are available. Adding a conditionally available `portfolio_*` tool to `core/stocks` would hide the whole stocks agent whenever IBKR is off.
   - `domainOf()` treats an operation with no domain prefix as core, so it would be offered on every coordinator call.
   - Every new tool needs `readOperations`, a runtime description, a tool-domain prefix and a recomputed core plugin hash.

## 4. Proposed architecture

```text
Telegram /portfolio ─┐                           ┌─ portfolio_read / portfolio_status (read tools, core/portfolio agent)
                     ▼                           │
         connect attempt (approval card) ──► IBKR authorize (owner's phone browser)
                                                 │ redirect
        Caddy /oauth/ibkr/callback ──► Fastify route ──► ibkr/oauth.ts (state, PKCE, exchange, scope check)
                                                 │
                     brokerage_connections (sealed tokens, CAS version) ◄── single-flight refresh
                                                 │
   PortfolioSync (deterministic timer, no model) ──► ibkr/mcp-client.ts ──► allowlisted read tools only
                                                 │
                  portfolio_syncs / portfolio_positions (immutable snapshots)
```

### Modules

- `src/ibkr/oauth.ts` handles client registration (once, stored), authorization URLs with PKCE S256 and a 32-byte state, code exchange, the scope-subset check, `userinfo` for the account list, revocation, and refresh.
  - **Refresh is single-flight.** It holds `pg_advisory_xact_lock(user)` on a pinned client, which avoids the pool caveat noted in the Library revoke. It re-reads the row, refreshes, and writes the rotated refresh token with `token_version = token_version + 1` before using the new access token.
  - **A lost refresh response is a rotation hazard.** It moves the connection to `refresh_uncertain`, and only a bounded retry with the stored token follows. If that fails, the state becomes `disconnected` and the owner gets one reconnect prompt. Nothing loops.
- `src/ibkr/mcp-client.ts` is a hand-rolled minimal Streamable HTTP client: `initialize`, `notifications/initialized`, `tools/list` and `tools/call`.
  - It sends the `Mcp-Session-Id` header and accepts JSON or a single SSE response.
  - It has request timeouts, an AbortSignal, a byte-bounded body reader and no server-initiated features.
  - I recommend this over the SDK because only three methods are needed, the repo already uses bounded hand-written clients, and the allowlist is easier to enforce at one choke point. **Revisit if Phase 0 shows** the server needs streaming, resumption or other protocol features.
- `src/ibkr/tools.ts` is the complete inventory of permitted MCP tool names with Zod output schemas. A boundary test asserts that no order or instruction tool is reachable. At startup and after each connection, `tools/list` is compared with the inventory: a missing tool degrades, and an unknown tool is ignored and never called.
- `src/portfolio.ts` holds `PortfolioSync`, which follows pagination to completion within bounded pages; hitting the bound makes the sync `partial`. It also holds the snapshot store and the `PortfolioTools` reads.

### Storage: migration 026 (additive, default off)

- **`brokerage_connections`**: `id`, `user_id`, `provider` (`ibkr`), `client_box` (registration), `token_box` (sealed with `IBKR_TOKEN_KEY` and AAD `ibkr-connection-v1:<user>:<id>`), `key_version`, `token_version`, `scopes`, `state` (`connecting` | `connected` | `refresh_uncertain` | `disconnected` | `revoked`), `access_expires_at`, `last_refresh_at`, `last_error_code` and timestamps. At most one live connection per owner and provider.
- **`brokerage_oauth_attempts`**: `state_hash`, `verifier_box`, `expires_at` (10 minutes), `status`, at most one live attempt per owner, and a small daily cap.
- **`brokerage_accounts`**: account reference, label, base currency and `selected`, which is chosen by the owner and never inferred.
- **`portfolio_syncs`**: `outcome` (`complete` | `partial` | `failed` | `empty`), `source_as_of`, `started_at`, `finished_at`, counts, error code and bounded detail.
- **`portfolio_positions`**:
  - columns: `sync_id`, `account_ref`, `conid`, `symbol`, `listing_exchange`, `currency`, `sec_type`, `quantity numeric`, nullable broker-reported `avg_cost`/`market_price`/`market_value`/`unrealized_pnl`/`realized_pnl`, plus bounded `broker_fields jsonb`;
  - keys: `UNIQUE(sync_id, account_ref, conid)`.
- **Current holdings** per selected account are the latest `complete` or `empty` sync. A `partial` or `failed` sync is recorded but never supersedes it, and readers see both the current holdings and the last attempt.
- **Retention:** the last N syncs per account. This also preserves day-to-day position history without claiming performance history.
- If Phase 0 shows usable quotes, the Phase 3 `quote_comparisons` table is folded into 026 so that only one operator rollout is needed.

### Behaviour

- **Connect.**
  - `/portfolio connect` sends an approval card. Approving creates an attempt and a button linking to IBKR's authorize page.
  - The callback validates the state hash (timing-safe, single use, unexpired), exchanges the code and checks scopes.
  - Telegram then lists the account IDs returned by IBKR and asks the owner to pick which to sync.
  - The flow is entirely phone-usable; no Mac step is involved.
- **Disconnect.** `/portfolio disconnect` wipes the local tokens first, then makes one revoke call. Snapshots stay unless the owner separately asks to delete them.
- **Model tools, read-only.**
  - `portfolio_read` returns current holdings per selected account. It labels freshness (`fresh` | `stale` | `disconnected` | `never_synced`), the last attempt outcome, and whether each position is monitorable (supported US MIC and type, already watched, at capacity) with the reason. It says which figures are broker-reported and which are computed.
  - `portfolio_status` returns connection health.
  - Both go in `readOperations`.
  - A new `core/portfolio` agent avoids the `agentCatalogue` gotcha, and a new `portfolio_` tool domain prevents core leakage. Changing `config/tool-picker.json` needs the documented paid `npm run eval:picker` (about $0.04), which runs only with owner approval.
  - Connect, disconnect and manual refresh are Telegram host commands, not model tools.
- **Sync.**
  - Runs on the existing 15-second routine timer, with a configurable cadence (default every 4 hours, plus `/portfolio refresh`) and per-connection backoff like the watchlist's.
  - It makes no model calls.
  - It **never** creates, deletes, pauses or resumes watch items.
- **Watch linkage** (Phase 2). `watchlist_list` and `portfolio_read` cross-reference by exact listing identity: conid when stored, otherwise symbol + MIC + currency + type. The owner then asks to watch a holding explicitly. Selling a holding never removes a watch or its history.
- **Configuration.**
  - `IBKR_PORTFOLIO=on|off` is a runtime setting.
  - `IBKR_TOKEN_KEY` is a 64-hex secret in the host `.env`.
  - The redirect origin reuses `MINIAPP_ORIGIN`.
  - When the feature is `on`, startup requires migration 25, the key and the origin.
  - All of these go in `compose.yaml`, `.env.example` and `check-env.mjs`.
- **Observability.** Sanitized `ibkr.refresh`, `ibkr.tool_call` and `portfolio.sync` events record only outcome, duration, counts and age. They never contain tokens, account IDs, quantities or values. `/portfolio` shows health on the phone, and CloudWatch shows the events to both local and cloud agents.

## 5. Phased build plan

Each phase is a separate reviewable PR with its own journal entry update, independent review and release record.

### Phase 0: authenticated feasibility spike (no production code)

The deliverable is a sanitized findings section in the journal, plus fixtures built from **schemas**, never account values.

1. Use the operator probe `scripts/ibkr-probe.mjs`, modelled on `scripts/connect-gmail.mjs`. It uses a loopback redirect, PKCE and state, and writes tokens to a 0600 file in the private ops directory, never to the repository.
   - It requests `mcp.read` (with the RFC 8707 `resource`) and records the granted scopes. If a broader `mcp.*` scope is granted, or the grant cannot be verified, it revokes and stops.
   - It records `expires_in`, whether a refresh token was issued, whether it rotates, and any refresh expiry.
   - It refuses to call any tool whose name or annotations suggest an order, instruction or other write. It prints tool results only as structure: keys, types and lengths, with account-like keys masked.
2. The **owner** completes the IBKR login and consent in their own browser. The agent never handles IBKR credentials.
3. Record `initialize` capabilities and `tools/list` tool schemas. Annotate each tool as read or write.
4. Call each candidate read tool once. Print only field names and types, counts, timestamps and pagination markers, never values.
5. Make quote calls for one held symbol and one non-held symbol. Record whether price, previous close, currency, timestamp, session, delay and entitlement are present.
6. Run lifetime tests: refresh after access expiry, again after more than 12 hours and again after more than 24 hours. Also check coexistence with the owner's normal IBKR mobile session, and confirm that revocation from the portal results in `invalid_grant`.
7. If IBKR refuses loopback redirects, stop and report. The spike then needs the Phase 1 hosted callback first.
8. If consent is refused for Chief's client, the owner adds the same server to a local Claude Code (`claude mcp add --transport http ibkr https://api.ibkr.com/v1/api/mcp-public`, then `/mcp` login). This tells us whether IBKR treats vendor clients differently from Chief's registration (see §6b).

**Gate G0** decides the path:

- registration and read-only consent work, read tools exist and refresh survives at least 24 hours → MCP holdings (Phase 1);
- IBKR grants only a token broader than `mcp.read` → an owner decision is needed on whether a host-side allowlist alone is acceptable (§3, risk 3); until then, Flex;
- registration or consent is refused, or consent is needed daily → the Flex fallback (§6). The vendor-client proxy (§6b) is considered only if step 8 shows IBKR accepts vendor clients and refuses Chief's.

#### Phase 0 progress — 2 October 2026 SGT

- **Measured: registration succeeded.** One POST to the advertised registration endpoint returned HTTP 201 with a public client (no secret) and the requested loopback redirect `http://127.0.0.1:53682/callback`. The registration response is stored with 0600 permissions in the private ops directory; the client ID is not recorded here.
- **Measured: IBKR ignored the requested scope at registration.** The request asked for `mcp.read openid account-ids`. The registered client came back with `mcp.orders.submit mcp.read mcp.write`, and `openid`/`account-ids` were dropped. Read-only access therefore cannot rely on the registration. It must be requested at authorization and verified in the token response, which the probe does.
- **Measured: consent works for Chief's own client.** At about 23:43 SGT the owner completed consent in their browser through `scripts/ibkr-probe.mjs connect`. The loopback callback succeeded, and the token response granted **exactly `mcp.read`**. The access token's `expires_in` is 599 seconds, a refresh token was issued with no reported expiry, and no ID token was returned. Risk 1 (client eligibility) is cleared for loopback clients. The hosted HTTPS redirect still needs its own registration, to be tested in Phase 1.
- **Measured: refresh tokens rotate.** A refresh at about 23:43 returned HTTP 200, still scoped to `mcp.read`, with a **new refresh token**. Combined with a 10-minute access token, this makes the single-flight, persist-before-use refresh in §4 mandatory. Idle and absolute refresh lifetimes are still untested.
- **Measured: the server reports itself as `ibkr-cpapi-mcp` 1.2.2** (protocol `2025-06-18`, with tools, prompts, resources and completions), so it fronts the Client Portal API.
- **Measured: 34 tools are listed under the `mcp.read` token, including write tools.** Among them are `create_order_instruction`, `delete_order_instruction`, `create_alert`, `update_alert`, `delete_alert`, `set_alert_status`, `create_watchlist`, `edit_watchlist`, `delete_watchlist` and `provide_customer_feedback`. Whether the server refuses them under `mcp.read` was **deliberately not tested**, because that would mean attempting a write. Chief's static allowlist is therefore a required boundary. Read-only annotations (`readOnlyHint`) are present and accurate for the tools inspected.
- **Measured: structure of the holdings reads.** Shapes only; values were never printed.
  - `get_account_positions` returns `positions[]` with `contract_id`, `contract_description`, `position`, `market_price`, `market_value`, `currency`, `average_price`, `unrealized_pnl` and `asset_class`. The schema also lists `daily_pnl`. The response had **no account identifier, no listing exchange, no pagination markers and no source timestamp**, and the tools take no account parameter. Scope is therefore the consented account, and freshness must be Chief's fetch time.
  - `get_account_summary` returns net liquidation, equity with loan, buying power, cash, margins, excess liquidity, dividends and leverage, plus `currency`.
  - `get_account_balances` returns `balances[]` per currency: cash, settled cash, net liquidation, stock market value, unrealized and realized P&L, and exchange rate.
- **Measured: quotes for AAPL (contract 265598) at 15:45Z, with US markets open.**
  - `top_status` was `REALTIME`, `last.ts` was in epoch seconds, the quote was **5–6 seconds old**, `halted` and `is_close` were both false, and `change` and `change_pct` were present.
  - `prior_close` was **empty on the first call and populated (`priorClose`) on the second call** 3 seconds later. That matches the Client Portal snapshot warm-up behaviour. The monitor must treat a missing previous close as "not ready", never as a valid quote.
  - `search_contracts` resolves any symbol to a contract ID, so quoting non-held instruments appears possible. This one sample does not show whether AAPL is held.
  - A single sample is not a reliability measurement; Phase 3 still applies.
- **Measured: the refresh token survived a 12-hour idle gap overnight.** The refresh-lifetime loop started at 23:47 SGT. Its first refresh ran at 11:46 SGT on 3 October, delayed because the Mac slept, which was 723 minutes after the previous refresh. It returned HTTP 200, a rotated refresh token and exactly `mcp.read`. The loop continues, to look for an absolute session cap.
- **Reported by the owner: holdings reconcile.** On 3 October, a one-off display of positions, summary and balances matched the owner's IBKR app. Internal sums were consistent across positions, balances and FX. Values are not recorded.
  - Symbols use IBKR's local form (`BRK B`).
  - ETFs are reported as `STK`.
  - The base currency is SGD.
  - `equity_with_loan_value`, `buying_power` and `leverage` look non-standard. Phase 1 shows positions and balances and leaves those three fields out.
- **Not yet tested:** absolute refresh-token lifetime beyond 12 hours; coexistence with the owner's mobile session; revocation; pacing limits; non-US or delayed instruments; the hosted redirect.

### Phase 1: holdings foundation (migration 026 and an operator rollout)

**Implemented on branch `feat/ibkr-portfolio-146` (3 October 2026); not yet reviewed or deployed.** The feature defaults to off.

**Modules.**

- `src/ibkr/oauth.ts`:
  - one dynamic public-client registration per redirect URI (`brokerage_clients`);
  - consent attempts with a hashed single-use state, a sealed PKCE verifier, a 10-minute expiry and at most 5 attempts per day;
  - code exchange that accepts **exactly `mcp.read`** and otherwise revokes and fails;
  - tokens sealed with `IBKR_TOKEN_KEY` (AAD bound to the owner);
  - refresh that is single-flight in process plus a Postgres lease and a compare-and-set on `token_version`, storing the rotated refresh token before use;
  - a lost refresh response moves the connection to `refresh_uncertain` and keeps the stored token; `invalid_grant` wipes local tokens and marks it `disconnected`;
  - owner disconnect wipes local tokens first, then sends one remote revoke.
- `src/ibkr/mcp.ts`:
  - a minimal Streamable HTTP JSON-RPC client (JSON or SSE, 2 MB bound, 20 s timeout);
  - a refresh-and-retry on an early 401;
  - **`IBKR_READ_TOOLS`** (`get_account_positions`, `get_account_balances`, `get_account_summary`), the only tools that can be called.
- `src/portfolio.ts`:
  - Zod-validated syncs into immutable `portfolio_syncs` and `portfolio_positions`. Only `complete` or `empty` syncs are current; malformed responses, duplicate contracts and auth failures are recorded as `failed` and never replace the current holdings.
  - Scheduled syncs every 4 hours, which also keep the rotating token in use, with exponential backoff after failures.
  - A one-time Telegram notice when access ends.
  - `portfolio_read` re-syncs holdings older than 15 minutes before answering.
  - `get_account_summary` is used only for the base currency; its margin and leverage fields are not shown.
- `src/ibkr/routes.ts`: `GET /oauth/ibkr/callback` (`no-store`, no session). Results are sent to the owner in Telegram, followed by the first sync.
- **Tools.**
  - `portfolio_read` and `portfolio_status` are read operations owned by a separate `core/portfolio` agent. They are gated on `availability.portfolio`, so the stocks agent never disappears when IBKR is off.
  - The `portfolio_` prefix maps to the existing `watchlist` domain. These tools are delegated, never offered to the coordinator, so `config/tool-picker.json` and its paid eval are unchanged.
- **Telegram.** `/portfolio`, `/portfolio connect` (an IBKR link button), `/portfolio refresh` and `/portfolio disconnect`. These are host commands, not model tools.
- **Configuration.**
  - `IBKR_PORTFOLIO=on|off` and `IBKR_TOKEN_KEY` (64 hex characters).
  - The redirect is `MINIAPP_ORIGIN + /oauth/ibkr/callback`.
  - Startup refuses `on` without migration 26 (`STARTUP_MIGRATION_026`), or without the key and origin (`STARTUP_IBKR_CONFIG`).
- **Logs.** `portfolio.sync` records state, `positionCount` and latency. `ibkr.callback` records state and `errorCode`. Neither ever contains values, tokens or account identifiers.

**Tests.**

- `tests/portfolio.test.ts` runs PGlite against a fake IBKR server with rotating refresh tokens and SSE MCP responses. It covers:
  - PKCE and the scope parameters;
  - single-use, expired, denied and broader-than-read consent;
  - sealed tokens;
  - single-flight refresh, a lost response, recovery and `invalid_grant`;
  - an early 401 retry;
  - complete, malformed, duplicate and empty syncs, with earlier holdings retained;
  - owner isolation;
  - no watch-item writes;
  - scheduled cadence and backoff;
  - owner disconnect and revoke;
  - the callback route, including replay and HTML injection;
  - the allowlist boundary;
  - runtime gating and delegation.
- `scripts/test-deploy-portfolio.py` covers the rollout (15 offline cases).

**Not yet tested.** Pagination; IBKR does not report any. Multiple accounts, because the measured responses carry no account dimension and the consent selects the account. Whether IBKR accepts a **non-loopback HTTPS redirect** at registration; that is checked first on activation.

**Rollout.** Run `scripts/deploy-portfolio.py ARCHIVE SHA` on the host, the same procedure as the other additive migrations ([stock watchlist rollout](stock-watchlist.md#deployment-operator-reviewed-migration-018)).

- The live `RELEASE` must equal `BASE`. It applies only 026 and only the default-off IBKR Compose environment lines, and checks the marker and health.
- Rollback keeps the additive tables; the previous image never reads them.

**Activation** happens separately, while idle, by the operator on the host:

1. Add `IBKR_TOKEN_KEY` (from `openssl rand -hex 32`, generated on the host and never printed or copied off it) and `IBKR_PORTFOLIO=on` to `/opt/hermes-companion/.env`. Keep the file at mode 0600.
2. Install the reviewed `ops/oauth-site/Caddyfile`, which adds only `/oauth/ibkr/callback`, with the `install-host.sh` steps: `install`, `caddy validate`, `mv`, then reload Caddy.
3. Recreate the gateway with `docker compose up -d --no-deps --no-build gateway` and check its health.
4. The owner sends `/portfolio connect` from the phone, approves read-only access on IBKR's site, and gets the holdings in Telegram.

To turn it off, set `IBKR_PORTFOLIO=off` and recreate the gateway. `/portfolio disconnect` beforehand revokes the token. Snapshots are retained.

**Acceptance.** Reconcile holdings privately and record only "matched" or "not matched"; check restart recovery, one overnight scheduled refresh, revocation, and a Chief answer to "how are my holdings doing?".

### Phase 2: holdings linkage and owner-defined dip conditions (owner request, 3 October 2026)

The owner asked for alerts when a stock falls below the average price of a holding, or below its 12-week or 52-week average, "to know when to buy the dip". Chief reports only that a condition the owner defined has been met; it gives no buy recommendation (the stocks agent stays "monitoring only: no trades, no advice").

**Conditions.** Each is attached to a watch item in a new `watch_conditions` table, alongside the existing daily-drop threshold:

| Kind            | Parameters                                 | Trigger                                                                                | Reference source                                                                                                 |
| --------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `below_cost`    | `marginPct` (default 0)                    | price < average cost × (1 − margin)                                                    | `average_price` from the latest **complete** IBKR holdings snapshot, matched by exact identity and same currency |
| `below_average` | `weeks` (4–52, e.g. 12 or 52), `marginPct` | price < simple average of the last `weeks × 5` daily closes × (1 − margin)             | daily closes from the same quote provider that supplies the price; there is no mixing of providers               |
| `below_low`     | `weeks` (4–52)                             | price < lowest daily close of the previous `weeks × 5` sessions, i.e. a new N-week low | the same daily series as `below_average`                                                                         |

**Data rules.**

- **Daily series.** It is fetched at most once per trading day per symbol, from Twelve Data `time_series` with a 1-day interval (one credit). It is cached per symbol and trading date. It needs at least 90% of the requested sessions; otherwise the observation is `insufficient_history`, not an alert.
- **Below-cost data quality.** The condition becomes `not_held` when the latest complete snapshot no longer contains the position, and `cost_unknown` when the snapshot is stale or the connection is disconnected. It is never evaluated against a partial snapshot, and a sale never deletes the condition or its history.
- **Shared quote rules.** The same freshness, currency, suspicious-move and session/window gates as daily-drop apply. Conditions run on the existing monitor tick with no model calls.

**Alert semantics.** These are level conditions, so they alert **on crossing**, not every day while below:

- **Firing.** A condition is `armed` → it fires once when a valid observation is below the trigger → it becomes `triggered`.
- **Re-arming.** It re-arms only after a valid observation at or above the trigger × (1 + 1%) (hysteresis), so prices hovering near the trigger do not repeat alerts.
- **Starting state.** A new condition that is already below its trigger alerts once on the first valid observation, so the owner learns the current state.
- **Daily cap.** At most one alert per condition per trading day.
- **Pauses.** Item and master pauses, monitoring windows and delivery muting work as they do for daily-drop.
- **Outbox.** Alert rows gain a `condition_id`, so the daily-drop uniqueness of `(item, trading_date)` becomes `(item, condition, trading_date)`. Delivery keeps the uncertain-send outbox.

**Holdings linkage.**

- **Matching.** `watchlist_list` and `portfolio_read` cross-reference by exact listing identity. IBKR `BRK B` maps to the provider's `BRK.B` only through an explicit `watchlist_add` exchange confirmation, never by string munging alone.
- **"Watch my holdings below cost."** This is an explicit owner request, executed as confirmed `watchlist_add` plus `below_cost` per holding, with a capacity check against the 25-item limit. There is no silent subscription.
- **Unsupported holdings.** Non-US or unsupported instruments are listed as not monitorable, with the reason.

**Storage.** `watch_conditions` holds `id`, `user_id`, `item_id`, `kind`, `params jsonb`, `state` (`armed` | `triggered`), `last_evaluated_at`, `last_triggered_at` and timestamps. A small `price_history_cache` table holds `symbol`, `mic`, `trading_date`, `closes` (bounded) and `fetched_at`. The `stock_alerts.condition_id` column is nullable, so legacy daily-drop rows stay null. The observation `decision` set is extended with `condition_triggered`, `insufficient_history`, `not_held` and `cost_unknown`. These go in **migration 027**, with its own reviewed rollout. Migration 026 was kept to holdings, so Phase 1 could be reviewed and shipped first.

**Release order.** Holdings (Phase 1) ship with migration 026. Conditions follow with migration 027. `below_average` and `below_low` do not depend on IBKR, so they work even if the IBKR connection is off.

### Phase 3: quote-provider evaluation (shadow mode)

- Run only if G0 showed usable quotes.
- `IbkrQuoteProvider` implements `MarketDataProvider`. A **shadow sampler** queries IBKR on the same due ticks as the live monitor and writes `quote_comparisons` rows containing both sources' price, previous close, quote age, session and the decision each source would make. It **never alerts**. Twelve Data stays the only alert source.
- In parallel, as a cheap step with no IBKR involvement, measure Twelve Data's real delay from existing `stock_observations` (`observed_at − quote_time` during regular hours) through a private read-only query. Then fix or keep the `delayed ~15m` label with that evidence.
- **Thresholds are agreed before the window starts.** Proposed, for owner confirmation:
  - at least 10 US sessions, covering opens, closes and the configured SGT window boundaries;
  - IBKR fetch success of at least 99% of due ticks;
  - median quote age of at most 2 minutes, or the documented delay if IBKR is delayed;
  - previous close within 0.01 on at least 99% of samples;
  - median absolute price difference of at most 0.25% at matched times;
  - **no unexplained divergence** in alert decisions;
  - zero unattended reconnects required.

### Phase 4: decision and cutover

- Publish the evidence and apply the issue's decision table. If IBKR becomes primary:
  - make `MARKET_DATA_PROVIDER=ibkr` a reviewed configuration change;
  - leave the Twelve Data adapter dormant for one release, then remove it in a follow-up;
  - do not add automatic cross-provider failover.
- If IBKR is used only for holdings, keep the current alert path and close the evaluation with recorded evidence.

## 6. Fallback: Flex Web Service

[Flex Web Service](https://www.interactivebrokers.com/docs/web-api/flex-web-service/introduction) uses a token with configurable expiry that can be **IP-restricted** to the Lightsail static IP, with no interactive OAuth. It returns configured report data, such as open positions, with explicit report dates. Data is end-of-day or as of the report run, which suits holdings but not quotes. The `portfolio_*` schema above is source-agnostic: a `source` column distinguishes `ibkr_mcp` from `ibkr_flex`. If G0 fails, Phase 1 swaps the OAuth/MCP modules for a Flex fetcher, and the token goes in `.env` like other provider keys. Quotes then stay on Twelve Data.

## 6b. Fallback: vendor-client middleware proxy (only if Chief's own client is refused)

IBKR's guide names the Claude, ChatGPT, Grok and Perplexity connectors. If IBKR accepts those clients but refuses Chief's registration, one option is to run a vendor's CLI agent as a sidecar that holds the IBKR authorization and relays reads to Chief.

**How it would work with Claude Code.** These flags were checked against Claude Code 2.1.283's `--help` on 2 October 2026; the documentation references are code.claude.com/docs/en/mcp and code.claude.com/docs/en/headless.

1. In a **separate container**, not the gateway, run `claude mcp add --transport http --callback-port <port> ibkr https://api.ibkr.com/v1/api/mcp-public` and complete the OAuth login once. Claude Code uses dynamic client registration and refreshes tokens automatically. On Linux it stores them in `~/.claude/.credentials.json` (0600).
2. For each read, Chief runs `claude -p` with a fixed prompt, `--output-format stream-json`, `--strict-mcp-config` and `--permission-mode dontAsk`, plus `--allowedTools` limited to the verified `mcp__ibkr__<read tool>` names. Built-in tools such as Bash and file access are not allowed.
3. Chief parses the raw `tool_result` blocks from the stream, never the model's prose, and validates them with the same Zod schemas and snapshot rules as the direct client.

**Limits and costs:**

- **A model call on every read.** No documented way exists to call an MCP tool without a model turn. This conflicts with the "no model call per poll" requirement, so it is acceptable at most for occasional holdings sync and **never for quote monitoring**.
- **Paid model usage on the server.** It needs `ANTHROPIC_API_KEY` or a subscription token from `claude setup-token`, and both mean paid usage outside OpenRouter. It needs explicit owner authorization (AGENTS.md: no paid infrastructure without a request). Check the subscription terms for unattended server use before relying on them.
- **First login on a headless host is awkward.** The callback is loopback on the sidecar host, so the operator needs an SSH port forward. Moving tokens between machines is undocumented. This weakens the phone-only reconnect goal.
- **Unverified points.** Whether stream-json `tool_result` content is byte-for-byte verbatim must be tested, and so must Codex CLI or other vendor CLIs.
- **A model sits in the loop on a write-capable brokerage token.** The CLI allowlist becomes a security boundary that Chief does not own. That is weaker than §4's host-enforced allowlist.
- **It changes Compose and the production host.** A new container and a third-party agent runtime must go through the reviewed operator procedure.

**Probably little help.** Claude Code registers itself dynamically with a loopback redirect, which is the same mechanism Chief's registration just used. If IBKR refuses Chief at consent, it will likely refuse Claude Code too, unless it allowlists by client name or software statement. The hosted claude.ai and ChatGPT connectors that the guide describes keep their tokens in the vendor's cloud. Those connectors offer no CLI or API path for Chief: the Claude API MCP connector requires the caller to supply the `authorization_token` itself.

**Rejected:** copying a token that a vendor client obtained (for example from Claude Code's credentials file) and calling IBKR from Chief directly. That impersonates another client's registration, is likely to breach IBKR's and the vendor's terms, and breaks silently on rotation. It would be reconsidered only with written IBKR confirmation.

**Order of preference if G0 fails:** Flex for holdings (§6), then the vendor-CLI proxy for holdings only, and only if Phase 0 step 8 shows a vendor client succeeds where Chief's is refused and the owner accepts the model usage cost. Quotes stay on Twelve Data in both cases.

## 7. Owner decisions and authorizations needed

1. **Phase 0 (authorized 2 October 2026).** Covers registering an OAuth client with IBKR (done) and the owner completing read-only consent for chosen accounts with `scripts/ibkr-probe.mjs`. Still to decide: revoke the spike consent afterwards, or keep it for Phase 1.
2. **Which accounts, exchanges and instrument types matter.** For example: US equities and ETFs only, or also SGX, LSE, options or funds.
3. **Confirm or adjust the Phase 3 thresholds** before any comparison starts.
4. **Whether to set up a Flex query in parallel** as a cheap hedge. It needs the owner in the IBKR portal and costs nothing.
5. **Approve the about $0.04 `eval:picker` run** when the new tool domain lands.

## 8. Out of scope

- Order placement or cancellation, non-binding trade instructions, any `mcp.write` or `mcp.orders.submit` scope, and automated trading.
- Paid market-data subscriptions or infrastructure.
- Unrestricted MCP discovery, or a general MCP plugin client.
- Historical performance claims.
- Automatic watch creation from holdings.
- Automatic provider failover.
