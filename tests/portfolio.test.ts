import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import Fastify from "fastify";
import { ensureUser, type Database } from "../src/db.js";
import { IBKR, IbkrAuth, readOnly } from "../src/ibkr/oauth.js";
import { IBKR_READ_TOOLS, IbkrMcp } from "../src/ibkr/mcp.js";
import { IBKR_CALLBACK_PATH, ibkrRoutes } from "../src/ibkr/routes.js";
import { Portfolio } from "../src/portfolio.js";
import { readOperations } from "../src/execution.js";
import { runtimeContext } from "../src/runtime.js";
import { action } from "../src/protocol.js";
import { domainOf } from "../src/tool-domains.js";

const REDIRECT = "https://chief.example" + IBKR_CALLBACK_PATH;
// Synthetic holdings in IBKR's measured response shapes; no real account data.
const POSITIONS = {
  positions: [
    {
      contract_id: 265598,
      contract_description: "AAPL",
      position: 5,
      market_price: 200,
      market_value: 1000,
      currency: "USD",
      average_price: 180,
      unrealized_pnl: 100,
      asset_class: "STK",
    },
    {
      contract_id: 72063691,
      contract_description: "BRK B",
      position: 1.5,
      market_price: 400,
      market_value: 600,
      currency: "USD",
      average_price: 420,
      unrealized_pnl: -30,
      asset_class: "STK",
    },
  ],
};
const BALANCES = {
  balances: [
    {
      currency: "BASE",
      cash_balance: 50,
      net_liquidation_value: 2100,
      stock_market_value: 2050,
      unrealized_pnl: 90,
      realized_pnl: 0,
      exchange_rate: 1,
    },
    {
      currency: "USD",
      cash_balance: 10,
      stock_market_value: 1600,
      exchange_rate: 1.3,
    },
  ],
};

/** A fake IBKR authorization server and MCP endpoint with rotating refresh tokens. */
function fakeIbkr() {
  const state = {
    scope: "mcp.read",
    refreshes: 0,
    registrations: 0,
    revoked: [] as string[],
    validRefresh: new Set<string>(),
    validAccess: new Set<string>(),
    positions: POSITIONS as unknown,
    balances: BALANCES as unknown,
    gate: null as null | Promise<void>,
    toolCalls: [] as string[],
    failToken: false,
    rejectAccess: false,
    counter: 0,
  };
  const issue = () => {
    const n = ++state.counter;
    state.validAccess.add(`a${n}`);
    state.validRefresh.add(`r${n}`);
    return {
      access_token: `a${n}`,
      refresh_token: `r${n}`,
      expires_in: 599,
      token_type: "Bearer",
      scope: state.scope,
    };
  };
  const json = (
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const http = (async (input: any, init: any = {}) => {
    const url = String(input);
    if (url === IBKR.registration) {
      state.registrations++;
      return json(
        {
          client_id: "client-1",
          scope: "mcp.orders.submit mcp.read mcp.write",
        },
        201,
      );
    }
    if (url === IBKR.revoke) {
      state.revoked.push(new URLSearchParams(String(init.body)).get("token")!);
      return new Response(null, { status: 200 });
    }
    if (url === IBKR.token) {
      if (state.failToken) throw new TypeError("network");
      const form = new URLSearchParams(String(init.body));
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== "good-code" || !form.get("code_verifier"))
          return json({ error: "invalid_grant" }, 400);
        return json(issue());
      }
      state.refreshes++;
      const old = form.get("refresh_token")!;
      if (state.gate) await state.gate;
      if (!state.validRefresh.has(old))
        return json({ error: "invalid_grant" }, 400);
      state.validRefresh.delete(old); // rotation: a refresh token works once
      return json(issue());
    }
    if (url === IBKR.resource) {
      const token = String(init.headers?.Authorization ?? "").replace(
        "Bearer ",
        "",
      );
      if (state.rejectAccess || !state.validAccess.has(token)) {
        state.rejectAccess = false;
        return new Response(null, { status: 401 });
      }
      const body = JSON.parse(String(init.body));
      if (body.method === "initialize")
        return json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18" },
          },
          200,
          { "mcp-session-id": "s1" },
        );
      if (body.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (body.method === "tools/call") {
        state.toolCalls.push(body.params.name);
        const data =
          body.params.name === "get_account_positions"
            ? state.positions
            : body.params.name === "get_account_balances"
              ? state.balances
              : { currency: "SGD", leverage: "0.78" };
        // IBKR answers as SSE with JSON text content and structuredContent.
        return new Response(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [{ type: "text", text: JSON.stringify(data) }],
              structuredContent: data,
            },
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { state, http };
}

async function fixture() {
  const pg = new PGlite();
  for (const name of (await readdir(new URL("../db/", import.meta.url)))
    .filter((n) => /^\d.*sql$/.test(n))
    .sort())
    await pg.exec(
      await readFile(new URL("../db/" + name, import.meta.url), "utf8"),
    );
  const faults = { positions: false };
  const db = {
    query: (text: string, values?: unknown[]) => {
      if (faults.positions && text.includes("INSERT INTO portfolio_positions"))
        return Promise.reject(new Error("disk full"));
      return (pg as unknown as Database).query(text, values);
    },
  } as Database;
  await ensureUser(db, "owner");
  await ensureUser(db, "other");
  const ibkr = fakeIbkr();
  let now = Date.parse("2026-10-03T04:00:00Z");
  const clock = () => now;
  const key = randomBytes(32);
  const auth = new IbkrAuth(db, key, REDIRECT, ibkr.http, clock);
  const notices: string[] = [];
  const portfolio = new Portfolio(
    db,
    auth,
    new IbkrMcp((user, force) => auth.accessToken(user, force), ibkr.http),
    (user) => user === "owner",
    async (_user, text) => {
      notices.push(text);
    },
    clock,
  );
  const connect = async () => {
    const { url } = await auth.begin("owner");
    const state = new URL(url).searchParams.get("state")!;
    return {
      url,
      state,
      result: await auth.complete(state, "good-code", undefined),
    };
  };
  return {
    db,
    ibkr,
    auth,
    portfolio,
    notices,
    faults,
    connect,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("consent requests only mcp.read with PKCE and connects exactly once per state", async () => {
  const f = await fixture();
  const { url, state, result } = await f.connect();
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, IBKR.authorize);
  assert.equal(u.searchParams.get("scope"), "mcp.read");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(u.searchParams.get("resource"), IBKR.resource);
  assert.deepEqual(result, { user: "owner", ok: true });
  // Replaying the same callback cannot connect anything again.
  assert.deepEqual(await f.auth.complete(state, "good-code", undefined), {
    ok: false,
    reason: "expired_or_unknown",
  });
  // Tokens are sealed at rest: no plaintext token appears in the row.
  const row = (await f.db.query("SELECT * FROM brokerage_connections")).rows[0];
  assert.equal(row.state, "connected");
  assert.deepEqual(row.scopes, ["mcp.read"]);
  assert(!Buffer.from(row.token_box).toString("latin1").includes("r1"));
  // The client is registered once and reused.
  await f.auth.begin("owner");
  assert.equal(f.ibkr.state.registrations, 1);
});

test("an expired, denied or broader-than-read consent never connects", async () => {
  const f = await fixture();
  const first = await f.auth.begin("owner");
  f.advance(11 * 60 * 1000);
  assert.equal(
    (
      await f.auth.complete(
        new URL(first.url).searchParams.get("state")!,
        "good-code",
        undefined,
      )
    ).reason,
    "expired_or_unknown",
  );
  const denied = await f.auth.begin("owner");
  assert.equal(
    (
      await f.auth.complete(
        new URL(denied.url).searchParams.get("state")!,
        undefined,
        "access_denied",
      )
    ).reason,
    "consent_not_completed",
  );
  f.ibkr.state.scope = "mcp.read mcp.write mcp.orders.submit";
  const broad = await f.auth.begin("owner");
  const r = await f.auth.complete(
    new URL(broad.url).searchParams.get("state")!,
    "good-code",
    undefined,
  );
  assert.equal(r.reason, "scope_rejected");
  assert.equal(f.ibkr.state.revoked.length, 1);
  assert.equal(
    (await f.db.query("SELECT count(*)::int n FROM brokerage_connections"))
      .rows[0].n,
    0,
  );
  assert.equal(readOnly(["mcp.read"]), true);
  assert.equal(readOnly(["mcp.read", "mcp.orders.submit"]), false);
  assert.equal(readOnly([]), false);
  // Exactly mcp.read: identity or unknown scopes are refused too (fail closed).
  assert.equal(readOnly(["mcp.read", "openid"]), false);
  assert.equal(readOnly(["mcp.read", "trade"]), false);
  assert.equal(readOnly(["mcp.read", "mcp.read"]), true);
});

test("refresh rotates the stored token, is single-flight, and invalid_grant disconnects", async () => {
  const f = await fixture();
  await f.connect();
  assert.equal(await f.auth.accessToken("owner"), "a1");
  f.advance(10 * 60 * 1000);
  const [x, y] = await Promise.all([
    f.auth.accessToken("owner"),
    f.auth.accessToken("owner"),
  ]);
  assert.equal(x, "a2");
  assert.equal(y, "a2");
  assert.equal(f.ibkr.state.refreshes, 1);
  f.advance(10 * 60 * 1000);
  assert.equal(await f.auth.accessToken("owner"), "a3");
  assert.equal(f.ibkr.state.refreshes, 2);
  // A lost token response keeps the stored token and marks the refresh uncertain.
  f.advance(10 * 60 * 1000);
  f.ibkr.state.failToken = true;
  await assert.rejects(f.auth.accessToken("owner"), {
    code: "token_unreachable",
  });
  assert.equal((await f.auth.status("owner")).state, "refresh_uncertain");
  f.ibkr.state.failToken = false;
  assert.equal(await f.auth.accessToken("owner"), "a4");
  assert.equal((await f.auth.status("owner")).state, "connected");
  // Revoked at IBKR: the next refresh disconnects and wipes local tokens.
  f.ibkr.state.validRefresh.clear();
  f.advance(10 * 60 * 1000);
  await assert.rejects(f.auth.accessToken("owner"), { code: "not_connected" });
  const row = (
    await f.db.query("SELECT state,token_box FROM brokerage_connections")
  ).rows[0];
  assert.equal(row.state, "disconnected");
  assert.equal(row.token_box, null);
});

test("sync stores validated holdings; failures and malformed reads never replace them", async () => {
  const f = await fixture();
  await f.connect();
  assert.equal((await f.portfolio.sync("owner", "connect")).status, "complete");
  assert.deepEqual(f.ibkr.state.toolCalls, [
    "get_account_positions",
    "get_account_balances",
    "get_account_summary",
  ]);
  const view: any = await f.portfolio.read("owner");
  assert.equal(view.freshness, "fresh");
  assert.equal(view.baseCurrency, "SGD");
  assert.deepEqual(
    view.positions.map((p: any) => [
      p.symbol,
      p.quantity,
      p.costBasis,
      p.unrealizedPct,
    ]),
    [
      ["AAPL", 5, 900, 11.1],
      ["BRK B", 1.5, 630, -4.8],
    ],
  );
  assert.deepEqual(view.totalsByCurrency.USD, {
    marketValue: 1600,
    costBasis: 1530,
    unrealizedPnl: 70,
    complete: true,
    unrealizedPct: 4.6,
  });
  assert.equal(view.account.netLiquidation, 2100);
  // A malformed response is recorded as failed; the earlier holdings stay current.
  f.ibkr.state.positions = { positions: [{ contract_id: "x" }] };
  f.advance(20 * 60 * 1000);
  const after: any = await f.portfolio.read("owner");
  assert.equal(after.positions.length, 2);
  assert.equal(after.lastAttempt.status, "failed");
  assert.equal(after.lastAttempt.errorCode, "malformed");
  assert.match(after.note, /last synced holdings/);
  // Duplicate contracts are refused rather than double counted.
  f.ibkr.state.positions = {
    positions: [POSITIONS.positions[0], POSITIONS.positions[0]],
  };
  assert.equal(
    (await f.portfolio.sync("owner", "owner")).errorCode,
    "duplicate_contract",
  );
  // An empty list the balances contradict is not a sale: it fails and holdings stay.
  f.ibkr.state.positions = { positions: [] };
  assert.equal(
    (await f.portfolio.sync("owner", "owner")).errorCode,
    "empty_unconfirmed",
  );
  // A truncated list fails reconciliation against the balance's stock value.
  f.ibkr.state.positions = { positions: [POSITIONS.positions[0]] };
  assert.equal(
    (await f.portfolio.sync("owner", "owner")).errorCode,
    "positions_incomplete",
  );
  assert.equal(
    (
      (await f.portfolio.call("owner", {
        operation: "portfolio_status",
      })) as any
    ).positionCount,
    2,
  );
  // A store failure is recorded, leaves no partial rows and keeps holdings.
  f.ibkr.state.positions = POSITIONS;
  f.faults.positions = true;
  assert.equal(
    (await f.portfolio.sync("owner", "owner")).errorCode,
    "store_failed",
  );
  f.faults.positions = false;
  assert.equal(
    (
      await f.db.query(
        "SELECT count(*)::int n FROM portfolio_syncs WHERE status='running'",
      )
    ).rows[0].n,
    0,
  );
  // A genuinely empty account (no stock value anywhere) is a valid snapshot.
  f.ibkr.state.positions = { positions: [] };
  f.ibkr.state.balances = {
    balances: [{ currency: "BASE", cash_balance: 50, stock_market_value: 0 }],
  };
  assert.equal((await f.portfolio.sync("owner", "owner")).status, "empty");
  assert.equal(
    ((await f.portfolio.call("owner", { operation: "portfolio_read" })) as any)
      .positions.length,
    0,
  );
  // Syncs never create, pause or delete watch items.
  assert.equal(
    (await f.db.query("SELECT count(*)::int n FROM watchlist_items")).rows[0].n,
    0,
  );
  // Other users have no access.
  await assert.rejects(
    f.portfolio.call("other", { operation: "portfolio_read" }),
  );
});

test("an access token rejected early is refreshed once; disconnection is announced once", async () => {
  const f = await fixture();
  await f.connect();
  f.ibkr.state.rejectAccess = true;
  assert.equal((await f.portfolio.sync("owner", "owner")).status, "complete");
  assert.equal(f.ibkr.state.refreshes, 1);
  f.ibkr.state.validRefresh.clear();
  f.ibkr.state.validAccess.clear();
  f.advance(10 * 60 * 1000);
  assert.equal(
    (await f.portfolio.sync("owner", "owner")).errorCode,
    "not_connected",
  );
  assert.equal(
    (await f.portfolio.sync("owner", "owner")).errorCode,
    "not_connected",
  );
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0]!, /\/portfolio connect/);
  // The last holdings remain visible and labelled disconnected.
  const view: any = await f.portfolio.read("owner");
  assert.equal(view.freshness, "disconnected");
  assert.equal(view.positions.length, 2);
});

test("scheduled syncs run every four hours and back off after failures", async () => {
  const f = await fixture();
  await f.connect();
  await f.portfolio.tick();
  assert.equal(f.ibkr.state.toolCalls.length, 3);
  await f.portfolio.tick();
  assert.equal(f.ibkr.state.toolCalls.length, 3);
  f.advance(4 * 60 * 60 * 1000 + 1);
  f.ibkr.state.positions = { bad: true };
  await f.portfolio.tick();
  assert.equal(f.ibkr.state.toolCalls.length, 6);
  f.advance(5 * 60 * 1000);
  await f.portfolio.tick(); // within backoff
  assert.equal(f.ibkr.state.toolCalls.length, 6);
  f.advance(30 * 60 * 1000);
  await f.portfolio.tick();
  assert.equal(f.ibkr.state.toolCalls.length, 9);
});

test("owner disconnect wipes local tokens before one remote revoke and keeps holdings", async () => {
  const f = await fixture();
  await f.connect();
  await f.portfolio.sync("owner", "connect");
  const result = await f.portfolio.command("owner", "disconnect");
  assert.match(result.text, /removed/);
  assert.deepEqual(f.ibkr.state.revoked, ["r1"]);
  const row = (
    await f.db.query("SELECT state,token_box FROM brokerage_connections")
  ).rows[0];
  assert.equal(row.state, "revoked");
  assert.equal(row.token_box, null);
  assert.equal(
    (await f.db.query("SELECT count(*)::int n FROM portfolio_positions"))
      .rows[0].n,
    2,
  );
  const shown = await f.portfolio.command("owner", "show");
  assert.match(
    shown.text,
    /AAPL · 5 @ 200\.00 = USD 1,000\.00 · \+100\.00 \(\+11\.1%\)/,
  );
  assert.match(shown.text, /Chief cannot trade/);
});

test("the callback route connects once, then syncs and notifies the owner", async () => {
  const f = await fixture();
  const app = Fastify();
  const sent: [string, string][] = [];
  ibkrRoutes(app, f.portfolio, async (user, text) => {
    sent.push([user, text]);
  });
  const { url } = await f.auth.begin("owner");
  const state = new URL(url).searchParams.get("state")!;
  const ok = await app.inject({
    method: "GET",
    url: `${IBKR_CALLBACK_PATH}?code=good-code&state=${state}`,
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.match(ok.body, /read-only access/);
  for (let i = 0; i < 50 && !sent.length; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent[0]![0], "owner");
  assert.match(sent[0]![1], /IBKR is connected with read-only access/);
  const replay = await app.inject({
    method: "GET",
    url: `${IBKR_CALLBACK_PATH}?code=good-code&state=${state}`,
  });
  assert.equal(replay.statusCode, 400);
  const junk = await app.inject({
    method: "GET",
    url: `${IBKR_CALLBACK_PATH}?state=%3Cscript%3E`,
  });
  assert.equal(junk.statusCode, 400);
  assert(!junk.body.includes("<script>"));
});

test("only allowlisted IBKR read tools can be called", async () => {
  const f = await fixture();
  await f.connect();
  const mcp = new IbkrMcp(
    (user, force) => f.auth.accessToken(user, force),
    f.ibkr.http,
  );
  await assert.rejects(mcp.read("owner", ["create_order_instruction" as any]), {
    code: "not_allowlisted",
  });
  assert.equal(f.ibkr.state.toolCalls.length, 0);
  // Write tools IBKR lists under mcp.read (measured catalogue) must never be allowlisted.
  for (const name of IBKR_READ_TOOLS) {
    assert.match(name, /^get_account_/);
    assert.doesNotMatch(
      name,
      /order|instruction|alert|watchlist|create|delete|edit|update|set_|feedback/,
    );
  }
});

test("portfolio tools are read operations, gated, and owned by a separate agent", () => {
  assert(readOperations.has("portfolio_read"));
  assert(readOperations.has("portfolio_status"));
  assert.equal(domainOf("portfolio_read"), "watchlist");
  assert.equal(
    action.parse({ operation: "portfolio_read" }).operation,
    "portfolio_read",
  );
  const base = {
    web: true,
    stocks: true,
    gmail: true,
    calendar: true,
    library: true,
    parcels: true,
    news: true,
  };
  const off = runtimeContext(base, null, undefined, undefined, true);
  const offTypes = JSON.parse(off.context).agentCatalogue.map(
    (a: any) => a.type,
  );
  assert(offTypes.includes("stocks"));
  assert(!offTypes.includes("portfolio"));
  assert(!off.allTools!.some((t) => t.name.startsWith("portfolio_")));
  const on = runtimeContext(
    { ...base, portfolio: true },
    null,
    undefined,
    undefined,
    true,
  );
  assert(
    JSON.parse(on.context).agentCatalogue.some(
      (a: any) => a.type === "portfolio",
    ),
  );
  // Delegated to the agent: the coordinator itself is not offered the tools.
  assert(!on.tools.some((t) => t.name.startsWith("portfolio_")));
  assert(on.allTools!.some((t) => t.name === "portfolio_read"));
});

test("a stale refresh's invalid_grant cannot wipe a newer reconnect, and an orphaned rotation is revoked", async () => {
  const f = await fixture();
  await f.connect();
  f.advance(10 * 60 * 1000);
  let open!: () => void;
  f.ibkr.state.gate = new Promise((r) => (open = r));
  const stale = f.auth.accessToken("owner").catch((e) => e);
  await new Promise((r) => setTimeout(r, 50));
  // The owner revokes in IBKR and reconnects while the old refresh is in flight.
  f.ibkr.state.validRefresh.delete("r1");
  f.ibkr.state.gate = null;
  assert.equal((await f.connect()).result.ok, true);
  open();
  assert.equal((await stale).code, "not_connected");
  const row = (
    await f.db.query("SELECT state,token_box FROM brokerage_connections")
  ).rows[0];
  assert.equal(row.state, "connected");
  assert.notEqual(row.token_box, null);
  assert.equal(await f.auth.accessToken("owner"), "a2");
  // The reconnect revoked the superseded grant's refresh token.
  assert(f.ibkr.state.revoked.includes("r1"));
});

test("a failed sync suppresses read-triggered re-syncs for the backoff window", async () => {
  const f = await fixture();
  await f.connect();
  f.ibkr.state.positions = { bad: true };
  await f.portfolio.read("owner");
  const calls = f.ibkr.state.toolCalls.length;
  await f.portfolio.read("owner");
  assert.equal(f.ibkr.state.toolCalls.length, calls);
  f.advance(16 * 60 * 1000);
  f.ibkr.state.positions = POSITIONS;
  const view: any = await f.portfolio.read("owner");
  assert.equal(view.positions.length, 2);
});
