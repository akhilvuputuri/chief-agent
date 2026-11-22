import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { migratedPGlite } from "./helpers/pglite.js";
import { ensureUser, type Database } from "../src/db.js";
import {
  GOOGLE_ACCOUNTS,
  GOOGLE_CALLBACK_PATH,
  GoogleConnect,
  googleRoutes,
  type GoogleAccount,
} from "../src/google-connect.js";
import {
  CalendarTools,
  GoogleAuthError,
  googleGrant,
} from "../src/calendar.js";
import { GmailTools } from "../src/gmail.js";
import { SheetsTools } from "../src/sheets.js";
import { toolError } from "../src/tool-errors.js";
import { runtimeContext } from "../src/runtime.js";
import { JobTools } from "../src/tools.js";
import { readConfig } from "../src/config.js";

// Synthetic addresses and credentials only.
const ORIGIN = "https://chief.example";
const PRIMARY = "owner@example.com";
const SECOND = "second@example.com";
const WEB = { id: "web-client", secret: "web-secret" };
const ENV = { clientId: "desktop-client", clientSecret: "desktop-secret" };

/** A fake Google: consent codes, refresh grants, and profiles keyed by access token. */
function fakeGoogle() {
  const g = {
    chosen: PRIMARY,
    scope: undefined as string | undefined,
    gone: new Set<string>(),
    refreshes: [] as { clientId: string; refreshToken: string }[],
    emails: new Map<string, string>(),
    lastConsentScope: "",
  };
  const http = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth =
      new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ??
      "";
    if (url.href === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== "good")
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        const access = "access-" + Math.random();
        g.emails.set(access, g.chosen);
        return Response.json({
          access_token: access,
          refresh_token: "refresh-for-" + g.chosen,
          expires_in: 3600,
          scope: g.scope ?? g.lastConsentScope,
        });
      }
      const refreshToken = form.get("refresh_token")!;
      g.refreshes.push({ clientId: form.get("client_id")!, refreshToken });
      if (g.gone.has(refreshToken))
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      const access = "a:" + refreshToken;
      return Response.json({ access_token: access, expires_in: 3600 });
    }
    const email =
      g.emails.get(auth) ??
      (auth.startsWith("a:refresh-for-") ? auth.slice(14) : undefined) ??
      (auth.startsWith("a:env-") ? auth.slice(6) : undefined);
    if (url.pathname.endsWith("/gmail/v1/users/me/profile"))
      return Response.json({ emailAddress: email });
    if (url.pathname === "/oauth2/v2/userinfo") return Response.json({ email });
    if (url.pathname.endsWith("/messages"))
      return Response.json({ messages: [] });
    if (url.hostname === "sheets.googleapis.com") return Response.json({});
    if (url.pathname.includes("/calendar/v3/"))
      return new Response(null, { status: 404 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { g, http };
}

async function fixture(env: Partial<Record<GoogleAccount, boolean>> = {}) {
  const pg = await migratedPGlite();
  const db = pg as unknown as Database;
  await ensureUser(db, "owner");
  const { g, http } = fakeGoogle();
  const connect = new GoogleConnect(
    db,
    "owner",
    WEB,
    ORIGIN + GOOGLE_CALLBACK_PATH,
    {
      gmail: { email: PRIMARY, envToken: !!env.gmail },
      gmail_secondary: { email: SECOND, envToken: !!env.gmail_secondary },
      calendar: { email: PRIMARY, envToken: !!env.calendar },
      sheets: { envToken: !!env.sheets },
    },
    http,
  );
  const sent: { user: string; text: string; button?: { url: string } }[] = [];
  connect.send = async (user, text, button) => {
    sent.push({ user, text, button });
  };
  const app = Fastify();
  googleRoutes(app, connect);
  // Opens the button and finishes on Google's page as `chosen`.
  const signIn = async (account: GoogleAccount, chosen = PRIMARY) => {
    const url = new URL((await connect.begin("owner", account)).url);
    g.chosen = chosen;
    g.lastConsentScope = url.searchParams.get("scope")!;
    return app.inject({
      method: "GET",
      url: `${GOOGLE_CALLBACK_PATH}?state=${url.searchParams.get("state")}&code=good`,
    });
  };
  return { db, g, http, connect, sent, app, signIn };
}

test("migration 037 applies on PGlite", async () => {
  const { db } = await fixture();
  const marker = await db.query(
    "SELECT 1 FROM runtime_migrations WHERE version=37",
  );
  assert.equal(marker.rows.length, 1);
});

test("the connect button opens Google's picker with each connection's scopes", async () => {
  const { connect } = await fixture();
  for (const account of Object.keys(GOOGLE_ACCOUNTS) as GoogleAccount[]) {
    const url = new URL((await connect.begin("owner", account)).url);
    assert.equal(
      url.origin + url.pathname,
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    const q = url.searchParams;
    assert.equal(q.get("client_id"), WEB.id);
    assert.equal(q.get("redirect_uri"), ORIGIN + "/oauth/google/callback");
    assert.equal(q.get("response_type"), "code");
    assert.equal(q.get("access_type"), "offline");
    assert.equal(q.get("prompt"), "consent select_account");
    assert.equal(q.get("code_challenge_method"), "S256");
    assert.match(q.get("state")!, /^[A-Za-z0-9_-]{40,}$/);
    assert.equal(q.get("scope"), GOOGLE_ACCOUNTS[account].scopes.join(" "));
    assert.equal(
      q.get("login_hint"),
      {
        gmail: PRIMARY,
        gmail_secondary: SECOND,
        calendar: PRIMARY,
        sheets: null,
      }[account],
    );
  }
  assert.equal(
    GOOGLE_ACCOUNTS.gmail.scopes.join(" "),
    "https://www.googleapis.com/auth/gmail.readonly",
  );
  await assert.rejects(
    () => connect.begin("someone-else", "gmail"),
    /Unauthorized/,
  );
});

test("the callback stores a sealed connection and confirms in the chat", async () => {
  const { db, sent, signIn } = await fixture();
  const page = await signIn("gmail");
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /return to Telegram/);
  const row = (
    await db.query(
      "SELECT state,email,token_box FROM google_connections WHERE account='gmail'",
    )
  ).rows[0];
  assert.equal(row.state, "connected");
  assert.equal(row.email, PRIMARY);
  assert(
    !Buffer.from(row.token_box).toString("latin1").includes("refresh-for"),
  );
  assert.deepEqual(
    sent.map((s) => s.text),
    [`Gmail is connected as ${PRIMARY}.`],
  );
});

test("a connection without a configured address records the chosen account", async () => {
  const { connect, signIn } = await fixture();
  assert.equal((await signIn("sheets", "sheets@example.com")).statusCode, 200);
  assert.equal(
    (await connect.credential("sheets"))?.email,
    "sheets@example.com",
  );
});

test("the callback rejects a wrong or reused state and the wrong account", async () => {
  const { db, g, connect, sent, app, signIn } = await fixture();
  const junk = await app.inject({
    method: "GET",
    url: `${GOOGLE_CALLBACK_PATH}?state=${"x".repeat(43)}&code=good`,
  });
  assert.equal(junk.statusCode, 400);

  const url = new URL((await connect.begin("owner", "calendar")).url);
  g.lastConsentScope = url.searchParams.get("scope")!;
  const callback = `${GOOGLE_CALLBACK_PATH}?state=${url.searchParams.get("state")}&code=good`;
  assert.equal(
    (await app.inject({ method: "GET", url: callback })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: "GET", url: callback })).statusCode,
    400,
  );

  sent.length = 0;
  const wrong = await signIn("gmail_secondary", "stranger@example.com");
  assert.equal(wrong.statusCode, 400);
  assert.match(sent[0]!.text, /stranger@example\.com.*second@example\.com/);
  assert.equal(
    (
      await db.query(
        "SELECT 1 FROM google_connections WHERE account='gmail_secondary'",
      )
    ).rows.length,
    0,
  );

  // Broader or different access than the connection asks for is refused.
  g.scope = "https://www.googleapis.com/auth/gmail.modify";
  assert.equal((await signIn("gmail")).statusCode, 400);
  assert.equal(await connect.credential("gmail"), undefined);
});

test("Gmail, Calendar and Sheets use a stored connection, else the .env token", async () => {
  const { db, g, http, connect, signIn } = await fixture({ gmail: true });
  const gmail = new GmailTools(
    {
      owner: "owner",
      email: PRIMARY,
      ...ENV,
      refreshToken: "env-" + PRIMARY,
      secondary: { email: SECOND, refreshToken: "" },
      connections: connect,
    },
    http,
  );
  await gmail.call("owner", "gmail_search", "from:x", undefined, "r");
  assert.deepEqual(g.refreshes.at(-1), {
    clientId: ENV.clientId,
    refreshToken: "env-" + PRIMARY,
  });
  // The secondary mailbox has no .env token: it waits for a chat connection.
  await assert.rejects(() =>
    gmail.call("owner", "gmail_search", "from:x", undefined, "r", "secondary"),
  );
  await signIn("gmail_secondary", SECOND);
  await gmail.call(
    "owner",
    "gmail_search",
    "from:x",
    undefined,
    "r",
    "secondary",
  );
  assert.deepEqual(g.refreshes.at(-1), {
    clientId: WEB.id,
    refreshToken: "refresh-for-" + SECOND,
  });

  await signIn("calendar");
  const calendar = new CalendarTools(
    {
      owner: "owner",
      email: PRIMARY,
      ...ENV,
      refreshToken: "",
      account: "calendar",
      connections: connect,
    },
    http,
  );
  assert.equal(
    await calendar.findCreated("owner", "00000000-0000-4000-8000-000000000000"),
    null,
  );
  assert.deepEqual(g.refreshes.at(-1), {
    clientId: WEB.id,
    refreshToken: "refresh-for-" + PRIMARY,
  });

  const sheets = new SheetsTools(
    db,
    {
      owner: "owner",
      ...ENV,
      refreshToken: "env-sheets@example.com",
      spreadsheetId: "sheet",
      connections: connect,
    },
    http,
  );
  await sheets.sync("owner");
  assert.deepEqual(g.refreshes.at(-1), {
    clientId: ENV.clientId,
    refreshToken: "env-sheets@example.com",
  });
  await signIn("sheets", "sheets@example.com");
  await sheets.sync("owner");
  assert.deepEqual(g.refreshes.at(-1), {
    clientId: WEB.id,
    refreshToken: "refresh-for-sheets@example.com",
  });
});

test("invalid_grant marks the connection disconnected and sends one reconnect button", async () => {
  const { db, g, http, connect, sent, signIn } = await fixture();
  await signIn("calendar");
  sent.length = 0;
  g.gone.add("refresh-for-" + PRIMARY);
  const config = {
    owner: "owner",
    email: PRIMARY,
    ...ENV,
    refreshToken: "",
    account: "calendar" as const,
    connections: connect,
  };
  const error = await googleGrant(config, http).catch((e) => e);
  assert(error instanceof GoogleAuthError && error.reconnectSent);
  assert.match(toolError(error).message, /reconnect button was sent/);
  assert.equal(toolError(error).code, "AUTHORIZATION_REQUIRED");
  // Later calls find no token (none in .env here) and send nothing more.
  await assert.rejects(() => googleGrant(config, http), /not configured/);
  assert.equal(sent.length, 1);
  assert.equal(
    new URL(sent[0]!.button!.url).searchParams.get("client_id"),
    WEB.id,
  );
  assert.equal(
    (
      await db.query(
        "SELECT state,token_box FROM google_connections WHERE account='calendar'",
      )
    ).rows[0].state,
    "disconnected",
  );
  // Reconnecting clears the marker, so a later break is announced again.
  g.gone.clear();
  await signIn("calendar");
  assert.equal((await googleGrant(config, http)).email, PRIMARY);
});

test("a broken .env token is announced once and cleared when it works again", async () => {
  const { db, g, http, connect, sent } = await fixture({ gmail: true });
  const config = {
    owner: "owner",
    email: PRIMARY,
    ...ENV,
    refreshToken: "env-" + PRIMARY,
    account: "gmail" as const,
    connections: connect,
  };
  g.gone.add("env-" + PRIMARY);
  await assert.rejects(
    () => googleGrant(config, http),
    /reconnect button was sent/,
  );
  await assert.rejects(
    () => googleGrant(config, http),
    /reconnect button was sent/,
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /Gmail access has stopped working/);
  g.gone.clear();
  await googleGrant(config, http);
  assert.equal(
    (await db.query("SELECT 1 FROM google_connections")).rows.length,
    0,
  );
});

test("/google lists each connection with a connect or reconnect button", async () => {
  const { connect, signIn } = await fixture({ calendar: true });
  await signIn("gmail");
  const view = await connect.command("owner");
  assert.match(view.text, new RegExp(`Gmail: connected as ${PRIMARY}`));
  assert.match(view.text, /Calendar: connected \(server setup\)/);
  assert.match(view.text, /Sheets: not connected/);
  assert.deepEqual(
    view.buttons.map((b) => b.text),
    [
      "Reconnect Gmail",
      "Connect Gmail (second mailbox)",
      "Reconnect Calendar",
      "Connect Sheets",
    ],
  );
});

test("without the two settings the feature is off", async () => {
  const config = readConfig(
    {
      DATABASE_URL: "postgres://x@localhost/x",
      TELEGRAM_BOT_TOKEN: "0000000000:test",
      TELEGRAM_ALLOWED_USER_IDS: "1",
    },
    {},
  );
  assert.equal(config.GOOGLE_OAUTH_CLIENT_ID, "");
  assert.equal(config.GOOGLE_OAUTH_CLIENT_SECRET, "");
  const names = (availability: Record<string, boolean>) =>
    runtimeContext(availability, null).tools.map((t) => t.name);
  assert(!names({}).includes("google_connect"));
  assert(names({ googleConnect: true }).includes("google_connect"));
  const db = (await migratedPGlite()) as unknown as Database;
  await ensureUser(db, "owner");
  const tools = new JobTools(db, { call: async () => ({}) });
  await assert.rejects(
    () =>
      tools.execute("owner", randomUUID(), {
        operation: "google_connect",
        account: "gmail",
      }),
    /not configured/,
  );
});
