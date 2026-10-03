# 59 — Can Chief read IBKR holdings without becoming a trading client?

Work date(s): 2026-10-02 to 2026-10-03. Written/revised: 2026-10-03.
Status: released in v0.3.37 and on (3 October 2026); owner connection and acceptance pending.

## User-visible problem and preceding iteration

[Issue #146](https://github.com/akhilvuputuri/chief-agent/issues/146) asks for read-only access to the owner's Interactive Brokers holdings, and then for an evidence-based decision on whether IBKR can replace Twelve Data for unattended price monitoring. The [stock watchlist](25-stock-watchlist.md) and its [monitoring windows](39-watch-monitoring-window.md) established a deterministic, model-free monitor keyed by symbol + MIC. Nothing in Chief reads brokerage state today. The plan and architecture are in [IBKR portfolio access](../ibkr-portfolio.md).

## Evidence

- **Measured on 2 October 2026 SGT, unauthenticated.** IBKR's protected-resource metadata advertises `mcp.read` and `mcp.write`. Its authorization-server metadata additionally lists `mcp.orders.submit`, `account-ids`, `openid`, the `client_credentials` grant and the public-client auth method `none`. An unauthenticated MCP `initialize` returns 401 with a `resource_metadata` challenge.
- **Measured on 2 October 2026 SGT, with owner authorization.** One dynamic client registration returned HTTP 201: a public client with a loopback redirect. The requested scope `mcp.read openid account-ids` was **replaced** by `mcp.orders.submit mcp.read mcp.write`. The response is stored privately with 0600 permissions; no identifier is recorded here.
- **Reported by IBKR's consent guide.** Access is set up by choosing named AI vendors' connectors. The guide states no consent lifetime.
- **Measured on 2 October 2026, about 23:43–23:45 SGT, during the owner's consent run.**
  - Consent succeeded for Chief's loopback client and the grant was exactly `mcp.read`. Access tokens last 599 seconds, and refresh tokens are issued and **rotate on every refresh**.
  - The server is `ibkr-cpapi-mcp` 1.2.2. It lists 34 tools, **including order-instruction, alert and watchlist write tools under the read token**. No write was attempted.
  - Positions, summary and balances returned the expected structure, with no account ID, listing exchange, pagination or source timestamp.
  - One AAPL snapshot reported `REALTIME`, 5–6 seconds old, with the previous close missing on the first call and present on the second.
  - Full details are in the [plan's Phase 0 progress](../ibkr-portfolio.md#phase-0-progress--2-october-2026-sgt).
- **Measured on 3 October 2026, 11:46 SGT.** A refresh 723 minutes after the previous one (an overnight idle gap) succeeded, still read-only, and rotated the token.
- **Reported by the owner on 3 October 2026 SGT.** At the owner's request, the three account reads were displayed once in the development session, fetched at 12:18 SGT. The owner confirmed that the positions and account figures matched the IBKR app. No values are recorded here.
  - **Measured:** the position market values summed exactly to the USD stock market value, and the positions' unrealized P&L to the USD unrealized P&L. The SGD totals equalled the USD totals multiplied by the reported exchange rate.
  - **Observed design inputs:**
    - Symbols use IBKR's local form (`BRK B`, not `BRK.B`).
    - ETFs are reported as `asset_class` `STK`.
    - The base currency is SGD, and positions are in USD.
    - Several summary fields (`equity_with_loan_value`, `buying_power`, `leverage`) do not look like conventional definitions, so they are not shown until verified.
- **Not tested.** Absolute refresh-token lifetime beyond 12 hours; mobile-session coexistence; revocation; pacing; the hosted redirect.

## Diagnosis and alternatives

- **Registration does not enforce read-only.** Read-only must be requested at authorization and verified in the token response. Chief then needs its own host-enforced tool allowlist as a second boundary. The probe fails closed: it revokes and stops if a broader `mcp.*` scope is granted.
- **Client eligibility is resolved for loopback clients.** Chief's own registration completed consent, so the remaining gating unknown is the absolute session lifetime. The hosted HTTPS redirect still needs its own test.
- **Alternatives, in order:**
  1. Flex Web Service for holdings. It uses an IP-restricted token and no interactive OAuth.
  2. A vendor-CLI proxy (Claude Code headless with a strict MCP tool allowlist), for holdings only. It costs a model call per read and adds paid usage. It is probably no help, because it uses the same registration mechanism.
  3. Copying a vendor client's token is rejected.

  See [§6/§6b](../ibkr-portfolio.md#6-fallback-flex-web-service).

## Implementation and review

- **Phase 1** (3 October 2026) is described in [the plan](../ibkr-portfolio.md#phase-1-holdings-foundation-migration-026-and-an-operator-rollout).
  - The design follows the Phase 0 measurements: a check for exactly `mcp.read`; rotating refresh tokens stored before use under single-flight, a lease and compare-and-set; a static three-tool read allowlist; and immutable snapshots that a failed or malformed read cannot replace.
  - `get_account_summary` is read only for the base currency, because its margin and leverage fields looked non-standard.
- **Two integration constraints shaped the tool wiring.** An agent disappears from the catalogue unless all of its tools are available, so a separate `core/portfolio` agent keeps the stocks agent visible when IBKR is off. Mapping `portfolio_` to the existing `watchlist` domain left the Jev picker configuration, and its paid eval, unchanged.
- **Independent review.** Opus 5.5 reviewed `4db3a33` on 3 October 2026 and returned **REQUEST CHANGES**, with two blocking findings:
  - An empty positions read would have become current holdings, which looks like a sale of everything.
  - The scope check accepted non-`mcp.` scopes besides `mcp.read`.
    Non-blocking findings covered a reproduced stale-refresh race that could wipe a reconnect, unrevoked rotated tokens, a sync left `running` after a store error, no backoff on read-triggered syncs, SSE id matching, contract multipliers and documentation slips. All were fixed with regression tests; see the [plan's review-fix notes](../ibkr-portfolio.md#phase-1-holdings-foundation-migration-026-and-an-operator-rollout). The reviewer's "Jev picker" typo note was not a defect, because Jev is the picker's name.
- **Second round.** The re-review of `7129786` **approved**, with non-blocking follow-ups: refuse connect while a grant is live, require a positive zero for an empty account, mark failed before deleting, and a test for revoking a rotated token. The automated Devin review raised further findings: account switching on reconnect, stale consent links after a disconnect, truncation in mixed-asset currencies, partial totals, pruning, and Telegram message length. These were fixed with regression tests; see the plan.
- **Conversational approval.** The owner asked why connecting needed a command and not "Chief figures it out and asks me". Commands had been chosen so the model could never start a brokerage grant by itself. The same boundary is kept with the existing approval-card pattern: Chief proposes a card; the owner's tap, and for connect the owner's IBKR login and consent, decides. The connect link is generated only when the card is sent, so it never reaches the model or the database in readable form.
- **One defect was found while testing.** The refresh compare-and-set used `rowCount`, which PGlite does not report. It now uses `RETURNING`, which behaves the same on `pg` and PGlite.

- **Plan:** [docs/ibkr-portfolio.md](../ibkr-portfolio.md).
- **Phase 0 probe:** [scripts/ibkr-probe.mjs](../../scripts/ibkr-probe.mjs). It runs on the owner's machine, stores tokens with 0600 permissions outside the repository and prints only structure. It refuses order and instruction tools.
- **Not yet reviewed:** no independent review has run; it happens on the implementation PRs.

## Verification and outcome

- **Offline:** the probe's output reducer masked account-like keys and printed no values for a synthetic positions payload.
- **Live:** the read calls above printed only structure, plus public quote facts for AAPL. No write tool was called.

## Follow-up and next iteration

The remaining Phase 0 measurements are any absolute refresh-token lifetime beyond 12 hours (the loop continues), mobile-session coexistence, and revocation. Gate G0 is decided after those.

### Release closure — 3 October 2026

- **Merged.** [PR #152](https://github.com/akhilvuputuri/chief-agent/pull/152) merged at `c3cea89d0a666ba1b64bb9235648358fce27ce7d`, with independent approval of exact head `b4e0ffb` and CI passing on that head.
- **Operator rollout (`scripts/deploy-portfolio.py`).**
  - It started from baseline `a3c428e`, whose live `RELEASE`, health and idle state were checked first. The archive and script hashes matched the merged files.
  - Result: deployed, healthy, migration 26, IBKR installed off.
  - Separate checks: `RELEASE`, health, marker 26, the new tables empty, the widened approvals check, and existing watch items and approvals preserved.
- **Activation.**
  - Backups of `.env` and the Caddyfile were taken first.
  - `IBKR_TOKEN_KEY` was generated on the host and never printed or copied off; `IBKR_PORTFOLIO=on` was set, and `.env` stayed at mode 0600.
  - The reviewed Caddyfile was validated and installed; the live file had matched the previous reviewed version exactly. The gateway was recreated while idle.
  - Checks: healthy; no startup error; the public callback route answered (HTTP 400 for an invalid state).
- **Automatic release.** The [release for `c3cea89`](https://github.com/akhilvuputuri/chief-agent/actions/runs/37135022555) then succeeded as a no-op redeploy, and the gateway stayed healthy with IBKR on.
- **Version.** Released in v0.3.37 together with the stock lookup.
- **Pending:** the owner's Telegram connect and holdings acceptance; IBKR's acceptance of the hosted HTTPS redirect; the absolute refresh-token lifetime; the revocation test.
