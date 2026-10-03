// Phase 0 feasibility probe for issue #146 (docs/ibkr-portfolio.md). Operator-run on the
// owner's machine against the owner's own IBKR consent. It never prints tokens, codes,
// account identifiers or field values: token material goes to 0600 files in DIR, and tool
// results are reduced to their structure (keys, types, lengths). Requests only mcp.read,
// revokes and stops if any broader scope is granted, and refuses order/instruction tools.
import { createServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

const AS = "https://api.ibkr.com";
const RESOURCE = "https://api.ibkr.com/v1/api/mcp-public";
const SCOPE = "mcp.read";
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const WRITE_NAME =
  /order|trade|place|cancel|modify|submit|instruct|transfer|withdraw|deposit|write/i;

const [command, dir, ...rest] = process.argv.slice(2);
const usage =
  "Usage: node scripts/ibkr-probe.mjs connect|tools|call|quote|refresh|revoke DIR [TOOL [JSON_ARGS] [--confirm-read]]";
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

function tokenFacts(t, previous) {
  return {
    token_type: t.token_type ?? null,
    expires_in: t.expires_in ?? null,
    refresh_token_issued: Boolean(t.refresh_token),
    refresh_token_rotated: previous
      ? Boolean(t.refresh_token) && t.refresh_token !== previous.refresh_token
      : null,
    refresh_expires_in:
      t.refresh_token_expires_in ?? t.refresh_expires_in ?? null,
    id_token_issued: Boolean(t.id_token),
    scopes: grantedScopes(t),
    other_fields: Object.keys(t)
      .filter(
        (k) =>
          ![
            "access_token",
            "refresh_token",
            "id_token",
            "token_type",
            "expires_in",
            "scope",
            "refresh_token_expires_in",
            "refresh_expires_in",
          ].includes(k),
      )
      .sort(),
  };
}

async function revoke(token, hint) {
  const r = await post(
    `${AS}/oauth2/api/v1/token/revoke`,
    new URLSearchParams({ token, token_type_hint: hint, client_id: client }),
  );
  return r.status;
}

// Persists a token response only after the granted scope is verified to be read-only.
async function accept(t, previous) {
  const facts = tokenFacts(t, previous);
  const scopes = facts.scopes;
  if (!scopes || scopes.some((s) => s !== SCOPE && s.startsWith("mcp."))) {
    const status = await revoke(
      t.refresh_token ?? t.access_token,
      t.refresh_token ? "refresh_token" : "access_token",
    );
    console.log(JSON.stringify({ ...facts, revoked_status: status }, null, 2));
    throw new Error(
      scopes
        ? "Granted scope is broader than mcp.read; revoked and stopped."
        : "Granted scope could not be verified; revoked and stopped.",
    );
  }
  await writePrivate("tokens.json", {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? previous?.refresh_token ?? null,
    expires_at: t.expires_in ? Date.now() + Number(t.expires_in) * 1000 : null,
    obtained_at: new Date().toISOString(),
  });
  console.log(JSON.stringify(facts, null, 2));
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
      await accept(t);
      res.end("Read-only IBKR authorization saved. You can close this tab.");
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
    console.log(
      "Open this URL in a browser on this machine and approve read-only access:",
    );
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
async function open() {
  const init = await rpc("initialize", {
    protocolVersion: protocol,
    capabilities: {},
    clientInfo: { name: "chief-ibkr-probe", version: "0" },
  });
  protocol = init.protocolVersion ?? protocol;
  await rpc("notifications/initialized", {}, true);
  return init;
}

// Structure only: identifier-like keys are masked and no scalar value is printed.
function shape(v, depth = 0) {
  if (depth > 6) return "…";
  if (v === null) return "null";
  if (Array.isArray(v))
    return v.length
      ? { array: v.length, item: shape(v[0], depth + 1) }
      : { array: 0 };
  if (typeof v === "object") {
    const out = {};
    let masked = 0;
    for (const [k, x] of Object.entries(v)) {
      if (/^[A-Z]{1,3}\d{4,}$|^\d{4,}$/.test(k)) {
        if (!masked++) out["<id-key>"] = shape(x, depth + 1);
      } else out[k] = shape(x, depth + 1);
    }
    if (masked) out["<id-keys>"] = masked;
    return out;
  }
  if (typeof v === "string") {
    if (depth === 0 || /^\s*[[{]/.test(v)) {
      try {
        return { json: shape(JSON.parse(v), depth + 1) };
      } catch {}
    }
    return `string(${v.length})`;
  }
  return typeof v;
}

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
  console.log(
    `refresh after ${Math.round((Date.now() - Date.parse(previous.obtained_at)) / 60000)} min: HTTP ${r.status}`,
  );
  if (!r.ok || !t.access_token)
    throw new Error(`Refresh failed: ${String(t.error ?? "").slice(0, 80)}`);
  await accept(t, previous);
} else if (command === "revoke") {
  const t = await readJson("tokens.json");
  console.log(
    "refresh revoke HTTP",
    await revoke(t.refresh_token, "refresh_token"),
  );
} else if (command === "tools") {
  const init = await open();
  console.log(
    JSON.stringify(
      {
        protocolVersion: init.protocolVersion,
        capabilities: init.capabilities,
        serverInfo: init.serverInfo,
      },
      null,
      2,
    ),
  );
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
      `${t.name}\treadOnlyHint=${t.annotations?.readOnlyHint ?? "?"}\tdestructiveHint=${t.annotations?.destructiveHint ?? "?"}\targs=${Object.keys(t.inputSchema?.properties ?? {}).join(",")}`,
    );
  console.log(`${tools.length} tools; schemas saved to tools.json`);
} else if (command === "call") {
  const [name, args = "{}", flag] = rest;
  const tools = await readJson("tools.json");
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error("Unknown tool; run tools first");
  const text = `${tool.name} ${tool.description ?? ""}`;
  if (WRITE_NAME.test(tool.name) || tool.annotations?.destructiveHint === true)
    throw new Error("Refusing a tool that may place, change or instruct.");
  if (tool.annotations?.readOnlyHint !== true) {
    if (flag !== "--confirm-read" || /order|instruction|trade/i.test(text))
      throw new Error(
        "Tool is not annotated read-only; inspect its description and pass --confirm-read if it is a pure read.",
      );
  }
  await open();
  const result = await rpc("tools/call", { name, arguments: JSON.parse(args) });
  console.log(
    JSON.stringify(
      {
        isError: result.isError ?? false,
        content: (result.content ?? []).map((c) =>
          c.type === "text"
            ? { type: "text", body: shape(c.text) }
            : { type: c.type },
        ),
        structuredContent: result.structuredContent
          ? shape(result.structuredContent)
          : null,
      },
      null,
      2,
    ),
  );
} else if (command === "quote") {
  // Public market-data facts for one contract (no account data): feed status, quote age
  // and which reference fields are populated. Used to judge monitor suitability.
  const [contractId] = rest;
  if (!/^\d+$/.test(contractId ?? "")) throw new Error("quote CONTRACT_ID");
  await open();
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await rpc("tools/call", {
      name: "get_price_snapshot",
      arguments: {
        contract_id: Number(contractId),
        market_data_names: ["last", "prior_close", "change", "top_status"],
      },
    });
    const text = (result.content ?? []).find((c) => c.type === "text")?.text;
    const q = result.structuredContent ?? JSON.parse(text ?? "{}");
    const ts = Number(q.last?.ts);
    const ms = ts > 1e12 ? ts : ts * 1000;
    console.log(
      JSON.stringify({
        attempt,
        status: q["top-status"]?.status ?? null,
        last_present: q.last?.price != null,
        ts_digits: Number.isFinite(ts) ? String(Math.trunc(ts)).length : null,
        age_seconds: Number.isFinite(ms)
          ? Math.round((Date.now() - ms) / 1000)
          : null,
        halted: q.last?.halted ?? null,
        is_close: q.last?.is_close ?? null,
        prior_close_keys: Object.keys(q["prior-close"] ?? {}),
        change_present: q.change?.change != null,
        change_pct_present: q.change?.change_pct != null,
      }),
    );
    if (attempt === 1) await new Promise((r) => setTimeout(r, 3000));
  }
} else throw new Error(usage);
