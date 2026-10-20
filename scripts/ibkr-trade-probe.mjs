// IBKR AI-instruction probe (issue #146, docs/ibkr-portfolio.md "AI instructions"). Operator-run
// on the owner's machine against a separate owner consent that requests every IBKR MCP scope.
// It measures what IBKR actually grants and how order instructions behave; it never submits an
// order (IBKR exposes no submit tool: an instruction becomes an order only when the owner taps
// Review & Submit in an IBKR app). Drafts are shares only (STK) and capped at MAX_VALUE.
// Tokens stay in 0600 files in DIR and are never printed. DIR is separate from the read-only
// probe's directory and needs its own copy of registration.json (the same loopback client).
import { createServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

const AS = "https://api.ibkr.com";
const RESOURCE = "https://api.ibkr.com/v1/api/mcp-public";
const SCOPE = "mcp.read mcp.write mcp.orders.submit";
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const MAX_VALUE = 100;
// The only tools this probe calls. Anything else IBKR lists is reported, never called.
const CALLABLE = new Set([
  "search_contracts",
  "get_price_snapshot",
  "create_order_instruction",
  "get_order_instructions",
  "delete_order_instruction",
]);

const [command, dir, ...rest] = process.argv.slice(2);
const usage = `Usage: node scripts/ibkr-trade-probe.mjs COMMAND DIR [ARGS]
  connect DIR                         consent in the browser; prints granted scopes
  refresh DIR                         rotate tokens; prints granted scopes
  tools DIR                           list tools; saves tools.json
  search DIR SYMBOL                   stock listings for SYMBOL
  quote DIR CONTRACT_ID               last price and data status
  draft DIR SYMBOL CONTRACT_ID BUY|SELL QTY LIMIT|MARKET [PRICE] [TIF] --confirm
  list DIR                            saved instructions
  delete DIR INSTRUCTION_ID --confirm
  revoke DIR                          revoke this consent's refresh token`;
if (!command || !dir) throw new Error(usage);
const file = (name) => join(dir, name);
const readJson = async (name) => JSON.parse(await readFile(file(name), "utf8"));
async function writePrivate(name, value) {
  const tmp = file(`${name}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(value, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(tmp, file(name));
}

const client = (await readJson("registration.json")).client_id;
if (!client) throw new Error("registration.json has no client_id");

async function post(url, body, headers = {}) {
  return fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers,
    body,
  });
}

function grantedScopes(t) {
  if (typeof t.scope === "string") return t.scope.split(/\s+/).filter(Boolean);
  const parts = String(t.access_token ?? "").split(".");
  if (parts.length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      const s = claims.scope ?? claims.scp;
      if (typeof s === "string") return s.split(/\s+/).filter(Boolean);
      if (Array.isArray(s)) return s.map(String);
    } catch {}
  }
  return null;
}

async function save(t, previous) {
  await writePrivate("tokens.json", {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? previous?.refresh_token ?? null,
    expires_at: t.expires_in ? Date.now() + Number(t.expires_in) * 1000 : null,
    obtained_at: new Date().toISOString(),
  });
  console.log(
    JSON.stringify(
      {
        requested: SCOPE.split(" "),
        granted: grantedScopes(t),
        expires_in: t.expires_in ?? null,
        refresh_token_issued: Boolean(t.refresh_token),
        refresh_token_rotated: previous
          ? Boolean(t.refresh_token) &&
            t.refresh_token !== previous.refresh_token
          : null,
      },
      null,
      2,
    ),
  );
}

async function connect() {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  let busy = false;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain");
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname !== "/callback" || req.method !== "GET")
      return void res.writeHead(404).end();
    const got = Buffer.from(u.searchParams.get("state") || "");
    if (
      got.length !== state.length ||
      !timingSafeEqual(got, Buffer.from(state))
    )
      return void res.writeHead(400).end("Invalid authorization state");
    if (busy) return void res.writeHead(409).end();
    busy = true;
    try {
      if (u.searchParams.has("error") || !u.searchParams.get("code")) {
        console.error(
          `Consent not completed: ${String(u.searchParams.get("error") ?? "no code").slice(0, 80)}`,
        );
        throw new Error("consent");
      }
      const r = await post(
        `${AS}/oauth2/api/v1/token`,
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client,
          code: u.searchParams.get("code"),
          code_verifier: verifier,
          redirect_uri: REDIRECT,
          resource: RESOURCE,
        }),
      );
      const t = await r.json().catch(() => ({}));
      if (!r.ok || !t.access_token) {
        console.error(
          `Token exchange failed: HTTP ${r.status} ${String(t.error ?? "").slice(0, 80)}`,
        );
        throw new Error("exchange");
      }
      await save(t);
      res.end("IBKR authorization saved. You can close this tab.");
    } catch (error) {
      if (!["consent", "exchange"].includes(error.message))
        console.error(error.message);
      res
        .writeHead(400)
        .end("Authorization did not complete. Return to setup.");
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
      server.close();
    }
  });
  const timer = setTimeout(() => server.close(), 15 * 60 * 1000);
  server.listen(PORT, "127.0.0.1", () => {
    const u = new URL(`${AS}/oauth2/authorize`);
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: client,
      redirect_uri: REDIRECT,
      scope: SCOPE,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();
    console.log("Open this URL in a browser on this machine and approve:");
    console.log(u.toString());
  });
}

async function tokens() {
  const t = await readJson("tokens.json");
  if (t.expires_at && Date.now() > t.expires_at - 30000)
    throw new Error("Access token expired; run refresh first.");
  return t;
}

// Minimal Streamable HTTP JSON-RPC: JSON or SSE response bodies, bounded size.
let session = null,
  protocol = "2025-06-18",
  nextId = 1;
async function rpc(method, params, notify = false) {
  const { access_token } = await tokens();
  const id = notify ? undefined : nextId++;
  const r = await post(
    RESOURCE,
    JSON.stringify({
      jsonrpc: "2.0",
      ...(notify ? {} : { id }),
      method,
      params,
    }),
    {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": protocol,
      ...(session ? { "Mcp-Session-Id": session } : {}),
    },
  );
  session = r.headers.get("mcp-session-id") ?? session;
  const text = await r.text();
  if (text.length > 2_000_000) throw new Error("Response too large");
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
  if (notify) return null;
  const messages = (r.headers.get("content-type") ?? "").includes(
    "text/event-stream",
  )
    ? text
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => {
          try {
            return JSON.parse(l.slice(5));
          } catch {
            return null;
          }
        })
    : [JSON.parse(text)];
  const m = messages.find((x) => x?.id === id);
  if (!m) throw new Error(`${method}: no response`);
  if (m.error)
    throw new Error(
      `${method}: error ${m.error.code} ${String(m.error.message).slice(0, 120)}`,
    );
  return m.result;
}
let opened = false;
async function call(name, args) {
  if (!CALLABLE.has(name)) throw new Error(`${name} is not callable here`);
  if (!opened) {
    const init = await rpc("initialize", {
      protocolVersion: protocol,
      capabilities: {},
      clientInfo: { name: "chief-ibkr-trade-probe", version: "0" },
    });
    protocol = init.protocolVersion ?? protocol;
    await rpc("notifications/initialized", {}, true);
    opened = true;
  }
  const result = await rpc("tools/call", { name, arguments: args });
  const text = (result.content ?? []).find((c) => c.type === "text")?.text;
  if (result.isError)
    throw new Error(`${name} returned an error: ${String(text).slice(0, 300)}`);
  if (result.structuredContent) return result.structuredContent;
  try {
    return JSON.parse(text ?? "{}");
  } catch {
    return { text: String(text).slice(0, 300) };
  }
}

async function stockListings(symbol) {
  const { results = [] } = await call("search_contracts", { query: symbol });
  return results
    .filter(
      (r) =>
        r.symbol === symbol &&
        (r.sections ?? []).some((s) => s.security_type === "STK"),
    )
    .map((r) => ({
      symbol: r.symbol,
      contract_id: r.underlying_contract_id,
      exchange: r.exchange,
      country: r.country_code,
      description: r.description,
    }));
}

async function lastPrice(contractId) {
  const q = await call("get_price_snapshot", {
    contract_id: contractId,
    market_data_names: ["last", "bid_ask", "top_status"],
  });
  return {
    last: q.last?.price ?? null,
    ask: q["bid-ask"]?.ask ?? null,
    status: q["top-status"]?.status ?? null,
  };
}

const confirmed = () => {
  if (!rest.includes("--confirm"))
    throw new Error("This changes the IBKR account; rerun with --confirm.");
};

if (command === "connect") await connect();
else if (command === "refresh") {
  const previous = await readJson("tokens.json");
  if (!previous.refresh_token) throw new Error("No refresh token stored");
  const r = await post(
    `${AS}/oauth2/api/v1/token`,
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client,
      refresh_token: previous.refresh_token,
      resource: RESOURCE,
    }),
  );
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token)
    throw new Error(
      `Refresh failed: HTTP ${r.status} ${String(t.error ?? "").slice(0, 80)}`,
    );
  await save(t, previous);
} else if (command === "revoke") {
  const t = await readJson("tokens.json");
  const r = await post(
    `${AS}/oauth2/api/v1/token/revoke`,
    new URLSearchParams({
      token: t.refresh_token,
      token_type_hint: "refresh_token",
      client_id: client,
    }),
  );
  console.log("refresh revoke HTTP", r.status);
} else if (command === "tools") {
  await tokens();
  const init = await rpc("initialize", {
    protocolVersion: protocol,
    capabilities: {},
    clientInfo: { name: "chief-ibkr-trade-probe", version: "0" },
  });
  protocol = init.protocolVersion ?? protocol;
  await rpc("notifications/initialized", {}, true);
  const tools = [];
  let cursor;
  do {
    const page = await rpc("tools/list", cursor ? { cursor } : {});
    tools.push(...(page.tools ?? []));
    cursor = page.nextCursor;
  } while (cursor && tools.length < 500);
  await writePrivate("tools.json", tools);
  for (const t of tools)
    console.log(
      `${t.name}\treadOnlyHint=${t.annotations?.readOnlyHint ?? "?"}\tdestructiveHint=${t.annotations?.destructiveHint ?? "?"}`,
    );
  console.log(`${tools.length} tools; schemas saved to tools.json`);
} else if (command === "search") {
  const [symbol] = rest;
  if (!/^[A-Z0-9.]{1,12}$/.test(symbol ?? ""))
    throw new Error("search SYMBOL (uppercase ticker)");
  console.log(JSON.stringify(await stockListings(symbol), null, 2));
} else if (command === "quote") {
  const id = Number(rest[0]);
  if (!Number.isSafeInteger(id)) throw new Error("quote CONTRACT_ID");
  console.log(JSON.stringify(await lastPrice(id)));
} else if (command === "draft") {
  confirmed();
  const [symbol, idText, side, qtyText, type, priceText, tif] = rest.filter(
    (a) => a !== "--confirm",
  );
  const id = Number(idText);
  const quantity = Number(qtyText);
  if (!Number.isSafeInteger(id)) throw new Error("CONTRACT_ID must be numeric");
  if (!["BUY", "SELL"].includes(side)) throw new Error("side is BUY or SELL");
  if (!(quantity > 0)) throw new Error("QTY must be positive");
  if (!["LIMIT", "MARKET"].includes(type))
    throw new Error("type is LIMIT or MARKET");
  if (tif && !["DAY", "GTC", "OVT", "OND", "OPG"].includes(tif))
    throw new Error("TIF is DAY, GTC, OVT, OND or OPG");
  // Shares only: the contract must be a stock listing of exactly this symbol.
  const listing = (await stockListings(symbol)).find(
    (l) => l.contract_id === id,
  );
  if (!listing)
    throw new Error(`${id} is not a ${symbol} stock listing; run search first`);
  const quote = await lastPrice(id);
  const limit = type === "LIMIT" ? Number(priceText) : null;
  if (type === "LIMIT" && !(limit > 0)) throw new Error("LIMIT needs a PRICE");
  const unit = limit ?? quote.ask ?? quote.last;
  if (!(unit > 0)) throw new Error("No price available to check the cap");
  const value = quantity * unit;
  if (value > MAX_VALUE)
    throw new Error(
      `Draft value ${value.toFixed(2)} exceeds the ${MAX_VALUE} cap; nothing was sent.`,
    );
  const created = await call("create_order_instruction", {
    contract_id_ex: String(id),
    side,
    quantity,
    order_type: type,
    ...(limit ? { limit_price: limit } : {}),
    ...(tif ? { time_in_force: tif } : {}),
  });
  await writePrivate("last-draft.json", { created, listing, quote });
  console.log(
    JSON.stringify(
      {
        id: created.id ?? null,
        url_returned: typeof created.url === "string",
        listing,
        quote,
        estimated_value: Number(value.toFixed(2)),
      },
      null,
      2,
    ),
  );
} else if (command === "list") {
  const { instructions = [] } = await call("get_order_instructions", {});
  console.log(
    JSON.stringify(
      instructions.map((i) => ({
        id: i.id,
        symbol: i.symbol,
        side: i.side,
        quantity: i.quantity,
        order_type: i.order_type,
        limit_price: i.limit_price ?? null,
        tif: i.tif ?? null,
        created: i.creation_time ?? null,
        expires: i.expiration ?? null,
        is_new: i.is_new ?? null,
      })),
      null,
      2,
    ),
  );
} else if (command === "delete") {
  confirmed();
  const [id] = rest;
  if (!/^\w{1,64}$/.test(id ?? "")) throw new Error("delete INSTRUCTION_ID");
  console.log(
    JSON.stringify(await call("delete_order_instruction", { id: String(id) })),
  );
} else throw new Error(usage);
