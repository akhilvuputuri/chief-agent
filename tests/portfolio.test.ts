import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import Fastify from "fastify";
import { ensureUser, type Database } from "../src/db.js";
import { IBKR, IbkrAuth, permitted, readOnly } from "../src/ibkr/oauth.js";
import {
  IBKR_DRAFT_TOOLS,
  IBKR_QUERY_TOOLS,
  IBKR_READ_TOOLS,
  IbkrMcp,
} from "../src/ibkr/mcp.js";
import { OrderDrafts } from "../src/ibkr/orders.js";
import { IBKR_CALLBACK_PATH, ibkrRoutes } from "../src/ibkr/routes.js";
import { Portfolio, reconcile, telegramChunks } from "../src/portfolio.js";
import { readOperations } from "../src/execution.js";
import { runtimeContext } from "../src/runtime.js";
import { action } from "../src/protocol.js";
import { domainOf } from "../src/tool-domains.js";
import { sendPortfolioApprovals } from "../src/telegram.js";
import { randomUUID } from "node:crypto";

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
    /** Per-tool fakes for order-draft and query tests; others use the holdings data. */
    tools: {} as Record<string, (args: any) => unknown>,
    toolArgs: [] as { name: string; args: any }[],
    /** Answer this tool's next call with 401, before processing it. */
    rejectTool: null as string | null,
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
        if (state.rejectTool === body.params.name) {
          state.rejectTool = null;
          return new Response(null, { status: 401 });
        }
        state.toolCalls.push(body.params.name);
        state.toolArgs.push({
          name: body.params.name,
          args: body.params.arguments,
        });
        const fake = state.tools[body.params.name];
        const data = fake
          ? fake(body.params.arguments)
          : body.params.name === "get_account_positions"
            ? state.positions
            : body.params.name === "get_account_balances"
              ? state.balances
              : { currency: "SGD", leverage: "0.78" };
        if (data && typeof data === "object" && "toolError" in data)
          return new Response(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                isError: true,
                content: [{ type: "text", text: (data as any).toolError }],
              },
            })}\n\n`,
            { status: 200, headers: { "content-type": "text/event-stream" } },
          );
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

async function fixture({ drafts = false, maxUsd = 100 } = {}) {
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
  const auth = new IbkrAuth(db, key, REDIRECT, ibkr.http, clock, drafts);
  const notices: string[] = [];
  const mcp = new IbkrMcp(
    (user, force) => auth.accessToken(user, force),
    ibkr.http,
  );
  const portfolio = new Portfolio(
    db,
    auth,
    mcp,
    (user) => user === "owner",
    async (_user, text) => {
      notices.push(text);
    },
    clock,
    drafts ? new OrderDrafts(auth, mcp, maxUsd, clock) : undefined,
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
    clock,
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
  // No stock value reported anywhere is not confirmation of an empty account.
  f.ibkr.state.balances = {
    balances: [{ currency: "BASE", cash_balance: 50 }],
  };
  assert.equal(
    (await f.portfolio.sync("owner", "owner")).errorCode,
    "empty_unconfirmed",
  );
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

test("an owner disconnect during a refresh revokes the rotated token, and connect refuses a live grant", async () => {
  const f = await fixture();
  await f.connect();
  assert.match(
    (await f.portfolio.command("owner", "connect")).text,
    /already connected/,
  );
  f.advance(10 * 60 * 1000);
  let open!: () => void;
  f.ibkr.state.gate = new Promise((r) => (open = r));
  const inflight = f.auth.accessToken("owner").catch((e) => e);
  await new Promise((r) => setTimeout(r, 50));
  await f.portfolio.command("owner", "disconnect");
  open();
  assert.equal((await inflight).code, "not_connected");
  // Both the stored token and the rotation IBKR issued meanwhile are revoked.
  assert.deepEqual(f.ibkr.state.revoked.sort(), ["r1", "r2"]);
  const row = (
    await f.db.query("SELECT state,token_box FROM brokerage_connections")
  ).rows[0];
  assert.equal(row.state, "revoked");
  assert.equal(row.token_box, null);
});

test("a reconnect never presents the previous grant's holdings as current", async () => {
  const f = await fixture();
  await f.connect();
  await f.portfolio.sync("owner", "connect");
  await f.portfolio.command("owner", "disconnect");
  // Holdings stay visible, labelled disconnected, after an owner disconnect.
  assert.equal(
    ((await f.portfolio.read("owner")) as any).freshness,
    "disconnected",
  );
  f.advance(60 * 1000);
  // A consent link opened before the disconnect cannot restore access.
  const early = await f.auth.begin("owner");
  await f.portfolio.command("owner", "disconnect");
  assert.equal(
    (
      await f.auth.complete(
        new URL(early.url).searchParams.get("state")!,
        "good-code",
        undefined,
      )
    ).reason,
    "expired_or_unknown",
  );
  // Reconnect (possibly to another account) whose first sync fails: no old holdings shown.
  await f.connect();
  f.ibkr.state.positions = { bad: true };
  const view: any = await f.portfolio.read("owner");
  assert.equal(view.holdings, null);
  assert.equal(view.lastAttempt.errorCode, "malformed");
});

test("reconcile accepts stock-only or full sums and refuses truncated mixed currencies", () => {
  const stk = { ...POSITIONS.positions[0], market_value: 1000 };
  const opt = {
    ...POSITIONS.positions[1],
    contract_id: 9,
    asset_class: "OPT",
    market_value: 200,
  };
  const usd = (value: number) => [
    { currency: "BASE", cash_balance: 0, stock_market_value: value },
    { currency: "USD", cash_balance: 0, stock_market_value: value },
  ];
  assert.equal(reconcile([stk, opt] as any, usd(1000)), null); // stock-only sum
  assert.equal(reconcile([stk, opt] as any, usd(1200)), null); // full sum
  assert.equal(reconcile([opt] as any, usd(1000)), "positions_incomplete");
  assert.equal(reconcile([], usd(0)), null);
  assert.equal(
    reconcile([], [{ currency: "BASE", cash_balance: 1 }] as any),
    "empty_unconfirmed",
  );
});

test("totals with an unknown cost are reported unknown, and long text is chunked", async () => {
  const f = await fixture();
  await f.connect();
  const option = { ...POSITIONS.positions[1], asset_class: "OPT" };
  f.ibkr.state.positions = { positions: [POSITIONS.positions[0], option] };
  assert.equal((await f.portfolio.sync("owner", "owner")).status, "complete");
  const view: any = await f.portfolio.read("owner");
  assert.equal(view.totalsByCurrency.USD.costBasis, null);
  assert.equal(view.totalsByCurrency.USD.unrealizedPct, null);
  assert.equal(view.totalsByCurrency.USD.marketValue, 1600);
  const long = Array.from(
    { length: 400 },
    (_, i) => `line ${i} ${"x".repeat(40)}`,
  ).join("\n");
  const parts = telegramChunks(long);
  assert(parts.length > 1 && parts.every((p) => p.length <= 3500));
  assert.equal(parts.join("\n"), long);
});

test("the scheduler does not count a previous grant's sync as recent", async () => {
  const f = await fixture();
  await f.connect();
  await f.portfolio.sync("owner", "connect");
  await f.portfolio.command("owner", "disconnect");
  f.advance(60 * 1000);
  await f.connect();
  const before = f.ibkr.state.toolCalls.length;
  await f.portfolio.tick();
  assert.equal(f.ibkr.state.toolCalls.length, before + 3);
});

async function turn(
  f: Awaited<ReturnType<typeof fixture>>,
  background = false,
) {
  const run = randomUUID();
  await f.db.query(
    "INSERT INTO work_turns(run_id,user_id,request,background) VALUES($1,'owner','x',$2)",
    [run, background],
  );
  return run;
}
function fakeBot() {
  const sent: { text: string; options: any }[] = [];
  let id = 100;
  return {
    sent,
    bot: {
      api: {
        sendMessage: async (_chat: string, text: string, options: any) => {
          sent.push({ text, options });
          return { message_id: ++id };
        },
      },
    } as any,
  };
}

test("Chief can only propose connecting: the IBKR link goes straight to the owner's card", async () => {
  const f = await fixture();
  // Background work cannot propose.
  await assert.rejects(
    f.portfolio.call(
      "owner",
      { operation: "portfolio_connect" },
      await turn(f, true),
    ),
    /foreground/,
  );
  const run = await turn(f);
  const proposed: any = await f.portfolio.call(
    "owner",
    { operation: "portfolio_connect" },
    run,
  );
  assert.equal(proposed.status, "awaiting_owner_tap");
  // The model-visible result carries no link or state.
  assert.doesNotMatch(JSON.stringify(proposed), /https?:|state=|client_id/);
  assert.equal(
    (await f.db.query("SELECT count(*)::int n FROM brokerage_connections"))
      .rows[0].n,
    0,
  );
  const { bot, sent } = fakeBot();
  await sendPortfolioApprovals(
    bot,
    f.db,
    f.portfolio,
    "owner",
    undefined,
    undefined,
    run,
  );
  assert.equal(sent.length, 1);
  const button = sent[0]!.options.reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, "Open IBKR (read-only)");
  assert.equal(new URL(button.url).searchParams.get("scope"), "mcp.read");
  // Sent once; the link is not stored in readable form.
  await sendPortfolioApprovals(bot, f.db, f.portfolio, "owner");
  assert.equal(sent.length, 1);
  const stored = JSON.stringify(
    (await f.db.query("SELECT payload FROM approvals")).rows,
  );
  assert.doesNotMatch(stored, /state=|https?:/);
  // The owner's own consent on IBKR completes the connection.
  const state = new URL(button.url).searchParams.get("state")!;
  assert.equal((await f.auth.complete(state, "good-code", undefined)).ok, true);
  // Once connected, a new connect proposal makes no card.
  assert.equal(
    (
      (await f.portfolio.call(
        "owner",
        { operation: "portfolio_connect" },
        run,
      )) as any
    ).status,
    "already_connected",
  );
});

test("a disconnect card acts only on the owner's tap on that exact card, once", async () => {
  const f = await fixture();
  assert.equal(
    (
      (await f.portfolio.call(
        "owner",
        { operation: "portfolio_disconnect" },
        await turn(f),
      )) as any
    ).status,
    "not_connected",
  );
  await f.connect();
  const run = await turn(f);
  await f.portfolio.call("owner", { operation: "portfolio_disconnect" }, run);
  // Nothing happens until the tap.
  assert.equal((await f.auth.status("owner")).state, "connected");
  const { bot, sent } = fakeBot();
  await sendPortfolioApprovals(
    bot,
    f.db,
    f.portfolio,
    "owner",
    undefined,
    undefined,
    run,
  );
  const [yes, no] = sent[0]!.options.reply_markup.inline_keyboard[0];
  assert.equal(yes.text, "Disconnect IBKR");
  assert.equal(no.text, "Keep connected");
  const id = yes.callback_data.split(":")[2];
  // A tap on a different message, or by another user, does nothing.
  assert.equal(
    (await f.portfolio.decideDisconnect("owner", id, 999, true)).status,
    "unavailable",
  );
  await assert.rejects(f.portfolio.decideDisconnect("other", id, 101, true));
  assert.equal((await f.auth.status("owner")).state, "connected");
  assert.equal(
    (await f.portfolio.decideDisconnect("owner", id, 101, true)).status,
    "disconnected",
  );
  assert.equal((await f.auth.status("owner")).state, "revoked");
  // Single use.
  assert.equal(
    (await f.portfolio.decideDisconnect("owner", id, 101, true)).status,
    "unavailable",
  );
  // "Keep connected" and expiry leave the connection alone.
  await f.connect();
  const run2 = await turn(f);
  await f.portfolio.call("owner", { operation: "portfolio_disconnect" }, run2);
  await sendPortfolioApprovals(
    bot,
    f.db,
    f.portfolio,
    "owner",
    undefined,
    undefined,
    run2,
  );
  const id2 =
    sent[1]!.options.reply_markup.inline_keyboard[0][0].callback_data.split(
      ":",
    )[2];
  assert.equal(
    (await f.portfolio.decideDisconnect("owner", id2, 102, false)).status,
    "kept",
  );
  assert.equal((await f.auth.status("owner")).state, "connected");
  const run3 = await turn(f);
  await f.portfolio.call("owner", { operation: "portfolio_disconnect" }, run3);
  await sendPortfolioApprovals(
    bot,
    f.db,
    f.portfolio,
    "owner",
    undefined,
    undefined,
    run3,
  );
  const id3 =
    sent[2]!.options.reply_markup.inline_keyboard[0][0].callback_data.split(
      ":",
    )[2];
  await f.db.query(
    "UPDATE approvals SET expires_at=now()-interval '1 minute' WHERE id=$1",
    [id3],
  );
  assert.equal(
    (await f.portfolio.decideDisconnect("owner", id3, 103, true)).status,
    "unavailable",
  );
  assert.equal((await f.auth.status("owner")).state, "connected");
});

test("portfolio proposals are writes, not reads", () => {
  assert(!readOperations.has("portfolio_connect"));
  assert(!readOperations.has("portfolio_disconnect"));
  assert.equal(domainOf("portfolio_connect"), "watchlist");
});

test("a connect card whose link cannot be built is released for retry, not stranded", async () => {
  const f = await fixture();
  const run = await turn(f);
  await f.portfolio.call("owner", { operation: "portfolio_connect" }, run);
  const { bot, sent } = fakeBot();
  const broken = {
    command: async () => {
      throw new Error("database unavailable");
    },
  } as any;
  await sendPortfolioApprovals(
    bot,
    f.db,
    broken,
    "owner",
    undefined,
    undefined,
    run,
  );
  assert.equal(sent.length, 0);
  const row = (await f.db.query("SELECT payload FROM approvals")).rows[0];
  assert.equal(row.payload.telegramDeliveryState, undefined);
  // The next delivery sends it.
  await sendPortfolioApprovals(
    bot,
    f.db,
    f.portfolio,
    "owner",
    undefined,
    undefined,
    run,
  );
  assert.equal(sent.length, 1);
});

/** IBKR's order-instruction tools as measured on 20 October 2026, with synthetic data. */
function broker(f: Awaited<ReturnType<typeof fixture>>) {
  const s = {
    flow: "REVIEW_AND_APPROVE",
    instructions: [] as any[],
    next: 100,
    ask: 12.22 as number | null,
    bid: 12.2 as number | null,
    last: 12.21 as number | null,
  };
  const listing = (
    symbol: string,
    id: number,
    exchange: string,
    country: string,
    type = "STK",
  ) => ({
    symbol,
    underlying_contract_id: id,
    exchange,
    country_code: country,
    description: `${symbol} TEST CO`,
    sections: [{ security_type: type }],
  });
  const listings: Record<string, unknown[]> = {
    F: [
      listing("F", 9599491, "NYSE", "US"),
      listing("F", 38708330, "MEXI", "MX"),
    ],
    FX: [listing("FX", 5, "TSE", "CA")],
    DUAL: [
      listing("DUAL", 7, "NYSE", "US"),
      listing("DUAL", 8, "NASDAQ", "US"),
    ],
    OPTONLY: [listing("OPTONLY", 9, "NYSE", "US", "OPT")],
  };
  Object.assign(f.ibkr.state.tools, {
    get_flow_type: () => ({ flow_type: s.flow }),
    search_contracts: (a: any) => ({ results: listings[a.query] ?? [] }),
    get_price_snapshot: () => ({
      last: { price: s.last },
      "bid-ask": { ask: s.ask, bid: s.bid },
    }),
    create_order_instruction: (a: any) => {
      const id = String(s.next++);
      s.instructions.push({
        id,
        symbol: "F",
        side: a.side,
        quantity: a.quantity,
        order_type: a.order_type,
        limit_price: a.limit_price,
        tif: a.time_in_force,
        creation_time: new Date(f.clock()).toISOString(),
        expiration: new Date(f.clock() + 7 * 86400000).toISOString(),
        is_new: true,
      });
      return {
        id,
        url: `https://ndcdyn.interactivebrokers.com/sso/resolver?action=AI#${id}`,
      };
    },
    get_order_instructions: () => ({ instructions: s.instructions }),
    delete_order_instruction: (a: any) => {
      s.instructions = s.instructions.filter((i) => i.id !== a.id);
      return {};
    },
  });
  return s;
}

async function draftFixture(scope = "mcp.read mcp.write") {
  const f = await fixture({ drafts: true });
  f.ibkr.state.scope = scope;
  await f.connect();
  const b = broker(f);
  const run = await turn(f);
  const draft = (args: Record<string, unknown>) =>
    f.portfolio.call(
      "owner",
      { operation: "portfolio_order_draft", ...args },
      run,
    ) as Promise<any>;
  const creates = () =>
    f.ibkr.state.toolCalls.filter((t) => t === "create_order_instruction")
      .length;
  return { f, b, run, draft, creates };
}

test("drafts request read and write, and never accept direct order submission", async () => {
  assert.equal(permitted(["mcp.read", "mcp.write"], true), true);
  assert.equal(permitted(["mcp.read"], true), true);
  assert.equal(permitted(["mcp.read", "mcp.write"], false), false);
  assert.equal(
    permitted(["mcp.read", "mcp.write", "mcp.orders.submit"], true),
    false,
  );
  assert.equal(permitted(["mcp.write"], true), false);
  assert.equal(permitted(["mcp.read", "openid"], true), false);
  const f = await fixture({ drafts: true });
  const { url } = await f.auth.begin("owner");
  assert.equal(new URL(url).searchParams.get("scope"), "mcp.read mcp.write");
  // IBKR granting submission as well is revoked and refused, as on 2 October.
  f.ibkr.state.scope = "mcp.read mcp.write mcp.orders.submit";
  assert.equal((await f.connect()).result.reason, "scope_rejected");
  assert.equal(f.ibkr.state.revoked.length, 1);
  f.ibkr.state.scope = "mcp.read mcp.write";
  assert.equal((await f.connect()).result.ok, true);
  const row = (await f.db.query("SELECT scopes FROM brokerage_connections"))
    .rows[0];
  assert.deepEqual(row.scopes, ["mcp.read", "mcp.write"]);
});

test("switching drafts off refuses a write grant at its next refresh", async () => {
  const on = await fixture({ drafts: true });
  on.ibkr.state.scope = "mcp.read mcp.write";
  await on.connect();
  // The same stored grant, read by a server with drafts off.
  const off = new IbkrAuth(
    on.db,
    (on.auth as any).key,
    REDIRECT,
    on.ibkr.http,
    on.clock,
    false,
  );
  on.advance(10 * 60 * 1000);
  await assert.rejects(off.accessToken("owner"), { code: "scope_rejected" });
  assert.equal((await off.status("owner")).state, "disconnected");
});

test("a draft is US shares only, within the cap, and only in review-and-approve sessions", async () => {
  const { f, b, draft, creates } = await draftFixture();
  const made = await draft({
    symbol: "f",
    side: "BUY",
    quantity: 1,
    orderType: "LIMIT",
    limitPrice: 6,
    timeInForce: "DAY",
  });
  assert.equal(made.status, "drafted");
  assert.equal(made.id, "100");
  assert.match(made.link, /^https:\/\/ndcdyn\.interactivebrokers\.com\//);
  assert.equal(made.draft.exchange, "NYSE");
  assert.equal(made.estimatedValueUsd, 6);
  assert.equal(made.expiresAt, "2026-10-10T04:00:00.000Z");
  assert.match(made.note, /Review & Submit/);
  const sent = f.ibkr.state.toolArgs.find(
    (c) => c.name === "create_order_instruction",
  )!.args;
  assert.deepEqual(sent, {
    contract_id_ex: "9599491",
    side: "BUY",
    quantity: 1,
    order_type: "LIMIT",
    limit_price: 6,
    time_in_force: "DAY",
  });
  // Over the cap: 20 x 6 = 120 > 100. Nothing is sent.
  const over = await draft({
    symbol: "F",
    side: "BUY",
    quantity: 20,
    orderType: "LIMIT",
    limitPrice: 6,
  });
  assert.equal(over.reason, "over_cap");
  assert.equal(over.estimatedValueUsd, 120);
  // A sell limit is a floor that fills at the market when below it: valued at the
  // higher of the limit and the bid (review finding, 20 October 2026).
  const lowSell = await draft({
    symbol: "F",
    side: "SELL",
    quantity: 40,
    orderType: "LIMIT",
    limitPrice: 2.5,
  });
  assert.equal(lowSell.reason, "over_cap");
  assert.equal(lowSell.estimatedValueUsd, 488);
  const highSell = await draft({
    symbol: "F",
    side: "SELL",
    quantity: 1,
    orderType: "LIMIT",
    limitPrice: 20,
  });
  assert.equal(highSell.status, "drafted");
  assert.equal(highSell.estimatedValueUsd, 20);
  // A market draft is valued at the current ask (falling back to last).
  const market = await draft({
    symbol: "F",
    side: "BUY",
    quantity: 9,
    orderType: "MARKET",
  });
  assert.equal(market.reason, "over_cap");
  assert.equal(market.estimatedValueUsd, 109.98);
  b.ask = null;
  const cheap = await draft({
    symbol: "F",
    side: "BUY",
    quantity: 8,
    orderType: "MARKET",
  });
  assert.equal(cheap.status, "drafted");
  assert.equal(cheap.estimatedValueUsd, 97.68);
  assert(
    !(
      "limit_price" in
      f.ibkr.state.toolArgs
        .filter((c) => c.name === "create_order_instruction")
        .at(-1)!.args
    ),
  );
  b.last = null;
  assert.equal(
    (
      await draft({
        symbol: "F",
        side: "BUY",
        quantity: 1,
        orderType: "MARKET",
      })
    ).reason,
    "no_price",
  );
  // Listings: not US, not a stock, unknown, or ambiguous until an exchange is given.
  for (const [symbol, reason] of [
    ["FX", "not_us_listed"],
    ["OPTONLY", "not_found"],
    ["NOPE", "not_found"],
  ])
    assert.equal(
      (
        await draft({
          symbol,
          side: "BUY",
          quantity: 1,
          orderType: "LIMIT",
          limitPrice: 1,
        })
      ).reason,
      reason,
    );
  const ambiguous = await draft({
    symbol: "DUAL",
    side: "BUY",
    quantity: 1,
    orderType: "LIMIT",
    limitPrice: 1,
  });
  assert.equal(ambiguous.status, "needs_exchange");
  assert.equal(ambiguous.listings.length, 2);
  assert.equal(
    (
      await draft({
        symbol: "DUAL",
        exchange: "nasdaq",
        side: "BUY",
        quantity: 1,
        orderType: "LIMIT",
        limitPrice: 1,
      })
    ).status,
    "drafted",
  );
  // A session IBKR reports as autonomous is never used.
  b.flow = "AUTONOMOUS";
  const autonomous = await draft({
    symbol: "F",
    side: "BUY",
    quantity: 1,
    orderType: "LIMIT",
    limitPrice: 6,
  });
  assert.equal(autonomous.reason, "flow_not_review");
  assert.equal(creates(), 4);
  // Limit price and order type must agree.
  await assert.rejects(
    draft({ symbol: "F", side: "BUY", quantity: 1, orderType: "LIMIT" }),
    /LIMIT draft needs limitPrice/,
  );
  await assert.rejects(
    draft({
      symbol: "F",
      side: "BUY",
      quantity: 1,
      orderType: "MARKET",
      limitPrice: 5,
    }),
    /MARKET draft takes none/,
  );
});

test("a lost create is never sent again; it is found or reported unknown", async () => {
  const { f, b, draft, creates } = await draftFixture();
  const create = f.ibkr.state.tools.create_order_instruction!;
  // IBKR saved the draft but the reply never arrived.
  f.ibkr.state.tools.create_order_instruction = (a) => {
    create(a);
    throw new TypeError("connection reset");
  };
  const lost = await draft({
    symbol: "F",
    side: "BUY",
    quantity: 2,
    orderType: "LIMIT",
    limitPrice: 5,
  });
  assert.equal(lost.status, "drafted");
  assert.equal(lost.id, "100");
  assert.equal(creates(), 1);
  // Nothing saved and no reply: unknown, still sent only once.
  f.ibkr.state.tools.create_order_instruction = () => {
    throw new TypeError("connection reset");
  };
  const unknown = await draft({
    symbol: "F",
    side: "SELL",
    quantity: 3,
    orderType: "LIMIT",
    limitPrice: 5,
  });
  assert.equal(unknown.status, "unknown");
  assert.match(unknown.note, /Do not draft it again/);
  assert.equal(creates(), 2);
  // Asking again with the same terms does not resend, although the list shows nothing.
  const again = await draft({
    symbol: "F",
    side: "SELL",
    quantity: 3,
    orderType: "LIMIT",
    limitPrice: 5,
  });
  assert.equal(again.status, "already_drafted");
  assert.equal(creates(), 2);
  // Two identical requests at once: only one reaches IBKR.
  const twice = await Promise.all(
    [0, 1].map(() =>
      draft({
        symbol: "F",
        side: "SELL",
        quantity: 4,
        orderType: "LIMIT",
        limitPrice: 5,
      }),
    ),
  );
  assert.deepEqual(twice.map((d) => d.status).sort(), [
    "already_drafted",
    "unknown",
  ]);
  assert.equal(creates(), 3);
  // After a restart (a fresh process), a recent identical draft in IBKR's list is found.
  const restarted = new OrderDrafts(
    f.auth,
    new IbkrMcp((user, force) => f.auth.accessToken(user, force), f.ibkr.http),
    100,
    f.clock,
  );
  const listed: any = await restarted.draft("owner", {
    symbol: "F",
    side: "BUY",
    quantity: 2,
    orderType: "LIMIT",
    limitPrice: 5,
  });
  assert.equal(listed.status, "already_drafted");
  assert.equal(listed.id, "100");
  assert.equal(creates(), 3);
  // IBKR's own rejection is reported with its text, control characters removed.
  f.ibkr.state.tools.create_order_instruction = () => ({
    toolError: "Contract\u0000 not tradable",
  });
  const rejected = await draft({
    symbol: "F",
    side: "BUY",
    quantity: 1,
    orderType: "LIMIT",
    limitPrice: 5,
  });
  assert.equal(rejected.status, "refused_by_ibkr");
  assert.equal(rejected.detail, "Contract not tradable");
  assert.doesNotMatch(rejected.note, /nothing was created/);
  // An error result after IBKR saved the draft is reported as the draft it is.
  f.ibkr.state.tools.create_order_instruction = (a) => {
    create(a);
    return { toolError: "backend timeout" };
  };
  const saved = await draft({
    symbol: "F",
    side: "BUY",
    quantity: 3,
    orderType: "LIMIT",
    limitPrice: 5,
  });
  assert.equal(saved.status, "drafted");
  assert.equal(saved.id, "101");
  // A 401 on create is assumed unprocessed: refreshed, then created once.
  f.ibkr.state.tools.create_order_instruction = create;
  f.ibkr.state.rejectTool = "create_order_instruction";
  const retried = await draft({
    symbol: "F",
    side: "BUY",
    quantity: 1,
    orderType: "LIMIT",
    limitPrice: 4,
  });
  assert.equal(retried.status, "drafted");
  assert.equal(b.instructions.length, 3);
});

test("drafts need a foreground owner request and a write grant; listing and deleting work", async () => {
  const { f, b, draft } = await draftFixture();
  await assert.rejects(
    f.portfolio.call(
      "owner",
      {
        operation: "portfolio_order_draft",
        symbol: "F",
        side: "BUY",
        quantity: 1,
        orderType: "LIMIT",
        limitPrice: 6,
      },
      await turn(f, true),
    ),
    /foreground/,
  );
  await draft({
    symbol: "F",
    side: "BUY",
    quantity: 1,
    orderType: "LIMIT",
    limitPrice: 6,
  });
  const listed: any = await f.portfolio.call("owner", {
    operation: "portfolio_order_drafts",
  });
  assert.equal(listed.drafts.length, 1);
  assert.equal(listed.drafts[0].awaitingReview, true);
  const removed: any = await f.portfolio.call(
    "owner",
    { operation: "portfolio_order_draft_delete", id: "100" },
    await turn(f),
  );
  assert.equal(removed.status, "deleted");
  assert.equal(b.instructions.length, 0);
  // After a confirmed delete, the same terms can be drafted again.
  const redrafted = await draft({
    symbol: "F",
    side: "BUY",
    quantity: 1,
    orderType: "LIMIT",
    limitPrice: 6,
  });
  assert.equal(redrafted.status, "drafted");
  assert.equal(redrafted.id, "101");
  // A delete the list does not confirm is reported as unconfirmed.
  await draft({
    symbol: "F",
    side: "BUY",
    quantity: 2,
    orderType: "LIMIT",
    limitPrice: 6,
  });
  f.ibkr.state.tools.delete_order_instruction = () => ({});
  const kept: any = await f.portfolio.call(
    "owner",
    { operation: "portfolio_order_draft_delete", id: "102" },
    await turn(f),
  );
  assert.equal(kept.status, "delete_unconfirmed");
  // A read-only grant (an earlier connection) cannot draft: reconnect first.
  const ro = await draftFixture("mcp.read");
  const calls = ro.f.ibkr.state.toolCalls.length;
  assert.equal(
    (
      await ro.draft({
        symbol: "F",
        side: "BUY",
        quantity: 1,
        orderType: "LIMIT",
        limitPrice: 6,
      })
    ).status,
    "reconnect_needed",
  );
  assert.equal(ro.f.ibkr.state.toolCalls.length, calls);
});

test("only allowlisted IBKR tools are callable; live-order tools never are", async () => {
  const { f } = await draftFixture();
  const mcp = new IbkrMcp(
    (user, force) => f.auth.accessToken(user, force),
    f.ibkr.http,
  );
  for (const name of [
    "submit_order",
    "modify_order",
    "cancel_order",
    "answer_order_question",
    "preview_order",
    "create_alert",
    "edit_watchlist",
  ])
    await assert.rejects(
      mcp.run("owner", (call) => call(name)),
      { code: "not_allowlisted" },
    );
  const live =
    /submit|modify|cancel|answer_order|preview|order_rules|order_status|create_|edit_|update_|delete_|set_|feedback/;
  for (const name of IBKR_QUERY_TOOLS) assert.doesNotMatch(name, live);
  assert.deepEqual([...IBKR_DRAFT_TOOLS].sort(), [
    "create_order_instruction",
    "delete_order_instruction",
  ]);
  // The model can only name query tools, never a write or live-order tool.
  assert.throws(() =>
    action.parse({ operation: "portfolio_ibkr_query", tool: "submit_order" }),
  );
  assert.throws(() =>
    action.parse({
      operation: "portfolio_ibkr_query",
      tool: "create_order_instruction",
    }),
  );
  // Queries return IBKR's result, bounded, and report IBKR errors as data.
  f.ibkr.state.tools.get_price_history = () => ({ bars: "x".repeat(40000) });
  const big: any = await f.portfolio.call("owner", {
    operation: "portfolio_ibkr_query",
    tool: "get_price_history",
    arguments: { contract_id: 1 },
  });
  assert.equal(big.truncated, true);
  assert.equal(big.text.length, 30000);
  f.ibkr.state.tools.get_alerts = () => ({ toolError: "no alerts service" });
  const failed: any = await f.portfolio.call("owner", {
    operation: "portfolio_ibkr_query",
    tool: "get_alerts",
  });
  assert.equal(failed.status, "ibkr_error");
  assert.equal(failed.detail, "no alerts service");
});

test("drafts belong to a separate brokerage agent, offered only when enabled", () => {
  assert(readOperations.has("portfolio_ibkr_query"));
  assert(readOperations.has("portfolio_order_drafts"));
  assert(!readOperations.has("portfolio_order_draft"));
  assert(!readOperations.has("portfolio_order_draft_delete"));
  const base = { web: true, stocks: true, portfolio: true };
  const types = (availability: Record<string, boolean>) => {
    const ctx = runtimeContext(availability, null, undefined, undefined, true);
    return {
      agents: JSON.parse(ctx.context).agentCatalogue.map((a: any) => a.type),
      tools: ctx.allTools!.map((t) => t.name),
      coordinator: ctx.tools.map((t) => t.name),
    };
  };
  const holdings = types(base);
  assert(holdings.agents.includes("portfolio"));
  assert(!holdings.agents.includes("brokerage"));
  assert(!holdings.tools.includes("portfolio_order_draft"));
  const drafting = types({ ...base, portfolioDrafts: true });
  assert(drafting.agents.includes("portfolio"));
  assert(drafting.agents.includes("brokerage"));
  assert(drafting.tools.includes("portfolio_order_draft"));
  assert(!drafting.coordinator.some((t: string) => t.startsWith("portfolio_")));
});
