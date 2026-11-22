import { createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ensureUser, type Database } from "./db.js";
import { errorFields, opsLog } from "./ops-log.js";
import { open, seal } from "./secret-box.js";

/**
 * Google connections made from the Telegram chat (docs/google-integrations.md). The owner taps
 * a link button, picks the account on Google's own page in the phone's browser, and the
 * callback stores the refresh token sealed in Postgres. A standard web-client OAuth flow with
 * PKCE and a single-use, expiring, server-stored state tied to the owner, shaped like the IBKR
 * flow (src/ibkr/oauth.ts). Gmail, Calendar and Sheets use a stored connection when there is
 * one and the .env token otherwise.
 */
export const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";
const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const ATTEMPT_MS = 10 * 60 * 1000;
const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export type GoogleAccount = "gmail" | "gmail_secondary" | "calendar" | "sheets";
/** The four connections and exactly the scopes scripts/connect-*.mjs request. */
export const GOOGLE_ACCOUNTS: Record<
  GoogleAccount,
  { label: string; scopes: string[] }
> = {
  gmail: { label: "Gmail", scopes: [GMAIL_SCOPE] },
  gmail_secondary: { label: "Gmail (second mailbox)", scopes: [GMAIL_SCOPE] },
  calendar: {
    label: "Calendar",
    scopes: [
      "openid",
      EMAIL_SCOPE,
      "https://www.googleapis.com/auth/calendar.events.owned",
    ],
  },
  sheets: {
    label: "Sheets",
    scopes: [
      "openid",
      EMAIL_SCOPE,
      "https://www.googleapis.com/auth/drive.file",
    ],
  },
};
export const GOOGLE_ACCOUNT_NAMES = Object.keys(
  GOOGLE_ACCOUNTS,
) as GoogleAccount[];

/** What the Gmail, Calendar and Sheets clients need from the stored connections. */
export interface GoogleConnections {
  /** The stored connection's credentials, or undefined to use the .env token. */
  credential(account: GoogleAccount): Promise<
    | {
        clientId: string;
        clientSecret: string;
        refreshToken: string;
        email: string | null;
      }
    | undefined
  >;
  /** The grant is gone (invalid_grant): mark it disconnected and tell the owner once. */
  broken(account: GoogleAccount): Promise<void>;
  /** The .env token refreshed: clear a disconnected marker it left. */
  working(account: GoogleAccount): Promise<void>;
}

/** Exactly the connection's scopes; Google may report userinfo.email as "email". */
export function grantedExactly(account: GoogleAccount, scope: unknown) {
  const got = new Set(
    String(scope ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => (s === "email" ? EMAIL_SCOPE : s)),
  );
  const want = GOOGLE_ACCOUNTS[account].scopes;
  return got.size === want.length && want.every((s) => got.has(s));
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

type Result = {
  ok: boolean;
  user?: string;
  account?: GoogleAccount;
  email?: string;
  reason?: string;
};

export class GoogleConnect implements GoogleConnections {
  private key: Buffer;
  /** Sends the owner a Telegram message, with a link button when given; set once the bot is up. */
  send: (
    user: string,
    text: string,
    button?: { text: string; url: string },
  ) => Promise<void> = async () => {};
  constructor(
    private db: Database,
    readonly owner: string,
    private client: { id: string; secret: string },
    readonly redirectUri: string,
    /** Per connection: the address it must use when one is configured, and whether .env has a token. */
    private accounts: Record<
      GoogleAccount,
      { email?: string; envToken: boolean }
    >,
    private http: typeof fetch = fetch,
    private now: () => number = Date.now,
  ) {
    // Sealed with a key derived from the web client secret, which already sits in the server
    // .env, so the feature needs no third setting.
    this.key = Buffer.from(
      hkdfSync("sha256", client.secret, "", "chief-google-connections-v1", 32),
    );
  }

  private request(url: string, init: RequestInit) {
    return this.http(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  }

  /** Starts a sign-in; the URL opens Google's account picker and consent page. */
  async begin(user: string, account: GoogleAccount) {
    if (user !== this.owner) throw new Error("Unauthorized Google connection");
    await ensureUser(this.db, user);
    const now = new Date(this.now());
    await this.db.query(
      "UPDATE google_oauth_attempts SET status='expired' WHERE user_id=$1 AND account=$2 AND status='pending'",
      [user, account],
    );
    const id = randomUUID();
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const expiresAt = new Date(now.getTime() + ATTEMPT_MS);
    await this.db.query(
      `INSERT INTO google_oauth_attempts(id,user_id,account,state_hash,verifier_box,created_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        user,
        account,
        sha256(state),
        seal(this.key, verifier, `google-attempt-v1:${id}`),
        now,
        expiresAt,
      ],
    );
    const hint = this.accounts[account].email;
    const url = new URL(AUTHORIZE);
    url.search = new URLSearchParams({
      client_id: this.client.id,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: GOOGLE_ACCOUNTS[account].scopes.join(" "),
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "false",
      ...(hint ? { login_hint: hint } : {}),
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString(), expiresAt };
  }

  /**
   * Completes a callback. The state is single-use: the attempt is claimed before the code is
   * exchanged, so a replayed or late callback connects nothing.
   */
  async complete(
    state: string,
    code: string | undefined,
    error: string | undefined,
  ): Promise<Result> {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(state))
      return { ok: false, reason: "invalid_state" };
    const claimed = (
      await this.db.query(
        `UPDATE google_oauth_attempts SET status='used',completed_at=$2
         WHERE state_hash=$1 AND status='pending' AND expires_at>$2
         RETURNING id,user_id,account,verifier_box`,
        [sha256(state), new Date(this.now())],
      )
    ).rows[0];
    if (!claimed) return { ok: false, reason: "expired_or_unknown" };
    const user = claimed.user_id as string;
    const account = claimed.account as GoogleAccount;
    const fail = async (reason: string, email?: string) => {
      await this.db.query(
        "UPDATE google_oauth_attempts SET status='failed',error_code=$2 WHERE id=$1",
        [claimed.id, reason],
      );
      return { ok: false, user, account, reason, email };
    };
    if (error || !code || code.length > 2000)
      return fail("consent_not_completed");
    const verifier = open(
      this.key,
      claimed.verifier_box,
      `google-attempt-v1:${claimed.id}`,
    );
    let body: any;
    try {
      const response = await this.request(TOKEN, {
        method: "POST",
        body: new URLSearchParams({
          client_id: this.client.id,
          client_secret: this.client.secret,
          code,
          code_verifier: verifier,
          redirect_uri: this.redirectUri,
          grant_type: "authorization_code",
        }),
      });
      body = await response.json().catch(() => ({}));
      if (!response.ok) return fail(`token_${response.status}`);
    } catch {
      return fail("token_unreachable");
    }
    if (
      typeof body.access_token !== "string" ||
      typeof body.refresh_token !== "string"
    )
      return fail("token_incomplete");
    // Not revoked when refused: a revoke ends every connection this account has with the client.
    if (!grantedExactly(account, body.scope)) return fail("scope_rejected");
    let email: string;
    try {
      email = await this.identity(account, body.access_token);
    } catch {
      return fail("identity_unavailable");
    }
    const expected = this.accounts[account].email;
    if (expected && email.toLowerCase() !== expected.toLowerCase())
      return fail("wrong_account", email);
    const at = new Date(this.now());
    await this.db.query(
      `INSERT INTO google_connections(account,user_id,state,email,scopes,token_box,connected_at,updated_at)
       VALUES($1,$2,'connected',$3,$4,$5,$6,$6)
       ON CONFLICT(account) DO UPDATE SET user_id=EXCLUDED.user_id,state='connected',email=EXCLUDED.email,
         scopes=EXCLUDED.scopes,token_box=EXCLUDED.token_box,last_error_code=NULL,
         disconnect_notified_at=NULL,connected_at=EXCLUDED.connected_at,updated_at=EXCLUDED.updated_at`,
      [
        account,
        user,
        email,
        GOOGLE_ACCOUNTS[account].scopes,
        seal(this.key, body.refresh_token, `google-connection-v1:${account}`),
        at,
      ],
    );
    return { ok: true, user, account, email };
  }

  /** The address a connection must use, when one is configured. */
  expected(account: GoogleAccount) {
    return this.accounts[account].email;
  }

  /** The signed-in address: Gmail's profile for the Gmail scope, userinfo otherwise. */
  private async identity(account: GoogleAccount, access: string) {
    const gmail = account === "gmail" || account === "gmail_secondary";
    const response = await this.request(
      gmail
        ? "https://gmail.googleapis.com/gmail/v1/users/me/profile"
        : "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${access}` } },
    );
    if (!response.ok) throw new Error("Google profile unavailable");
    const profile: any = await response.json();
    const email = gmail ? profile.emailAddress : profile.email;
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email))
      throw new Error("Google profile has no address");
    return email;
  }

  async credential(account: GoogleAccount) {
    const row = (
      await this.db.query(
        "SELECT email,token_box FROM google_connections WHERE account=$1 AND state='connected'",
        [account],
      )
    ).rows[0];
    if (!row) return undefined;
    return {
      clientId: this.client.id,
      clientSecret: this.client.secret,
      refreshToken: open(
        this.key,
        row.token_box,
        `google-connection-v1:${account}`,
      ),
      email: row.email as string | null,
    };
  }

  async broken(account: GoogleAccount) {
    await ensureUser(this.db, this.owner);
    await this.db.query(
      `INSERT INTO google_connections(account,user_id,state,last_error_code,updated_at)
       VALUES($1,$2,'disconnected','invalid_grant',$3)
       ON CONFLICT(account) DO UPDATE SET state='disconnected',token_box=NULL,
         last_error_code='invalid_grant',updated_at=EXCLUDED.updated_at`,
      [account, this.owner, new Date(this.now())],
    );
    const first = await this.db.query(
      `UPDATE google_connections SET disconnect_notified_at=$2
       WHERE account=$1 AND state='disconnected' AND disconnect_notified_at IS NULL RETURNING account`,
      [account, new Date(this.now())],
    );
    if (first.rows.length)
      await this.offer(
        this.owner,
        account,
        `Chief's ${GOOGLE_ACCOUNTS[account].label} access has stopped working (expired or revoked).`,
      );
  }

  async working(account: GoogleAccount) {
    await this.db.query(
      "DELETE FROM google_connections WHERE account=$1 AND token_box IS NULL",
      [account],
    );
  }

  /** Sends the owner a connect button for one connection; the link never reaches the model. */
  async offer(user: string, account: GoogleAccount, why?: string) {
    const { label } = GOOGLE_ACCOUNTS[account];
    const { url } = await this.begin(user, account);
    await this.send(
      user,
      `${why ? why + " " : ""}Tap the button within 10 minutes and choose ${this.accounts[account].email ?? "the account"} on Google's page to connect ${label}.`,
      { text: `Connect ${label}`, url },
    );
    return {
      status: "button_sent",
      note: `A Telegram message with a 'Connect ${label}' button was sent to the owner. Nothing changes until they open it and finish on Google's page; Chief confirms in the chat when it is connected.`,
    };
  }

  /** Telegram /google: each connection's state and a connect or reconnect button for each. */
  async command(user: string) {
    if (user !== this.owner) throw new Error("Unauthorized Google command");
    const rows = new Map(
      (
        await this.db.query(
          "SELECT account,state,email FROM google_connections",
        )
      ).rows.map((r) => [r.account as GoogleAccount, r]),
    );
    const lines = ["Google connections:"];
    const buttons: { text: string; url: string }[] = [];
    for (const account of GOOGLE_ACCOUNT_NAMES) {
      const { label } = GOOGLE_ACCOUNTS[account];
      const row = rows.get(account);
      const live =
        row?.state === "connected" || (!row && this.accounts[account].envToken);
      lines.push(
        `• ${label}: ${
          row?.state === "connected"
            ? `connected as ${row.email}`
            : row
              ? "stopped working; reconnect"
              : this.accounts[account].envToken
                ? "connected (server setup)"
                : "not connected"
        }`,
      );
      const { url } = await this.begin(user, account);
      buttons.push({
        text: `${live ? "Reconnect" : "Connect"} ${label}`,
        url,
      });
    }
    lines.push(
      "",
      "A button opens Google in your browser, where you choose the account. Buttons work for 10 minutes.",
    );
    return { text: lines.join("\n"), buttons };
  }
}

const page = (message: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chief · Google</title><p style="font:16px system-ui;margin:2rem">${message}</p>`;

/** What the owner is told in Telegram when a sign-in did not connect. */
function failure(result: Result, expected?: string) {
  const label = result.account
    ? GOOGLE_ACCOUNTS[result.account].label
    : "Google";
  const again = "Send /google to try again.";
  if (result.reason === "wrong_account")
    return `${label} was not connected: you chose ${result.email}, but Chief expects ${expected}. Nothing was saved. ${again}`;
  if (result.reason === "scope_rejected")
    return `${label} was not connected: Google did not grant exactly the access Chief asks for. Leave every box ticked on Google's page. Nothing was saved. ${again}`;
  return `${label} was not connected. Nothing was saved. ${again}`;
}

/**
 * The only public Google route: the OAuth redirect. It carries no session; the single-use state
 * ties the callback to the owner's attempt. Results go to the owner in Telegram.
 */
export function googleRoutes(app: FastifyInstance, connect: GoogleConnect) {
  app.get(GOOGLE_CALLBACK_PATH, async (request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff")
      .type("text/html; charset=utf-8");
    const query = request.query as Record<string, unknown>;
    const text = (key: string) =>
      typeof query[key] === "string" ? (query[key] as string) : undefined;
    let result: Result;
    try {
      result = await connect.complete(
        text("state") ?? "",
        text("code"),
        text("error"),
      );
    } catch (error) {
      opsLog("google.callback_failed", "error", errorFields(error));
      return reply
        .code(500)
        .send(
          page(
            "Something went wrong. Return to Telegram and send /google to try again.",
          ),
        );
    }
    opsLog("google.callback", result.ok ? "info" : "warn", {
      state: result.ok ? "connected" : "rejected",
      errorCode: result.reason,
    });
    if (!result.ok) {
      if (result.user)
        await connect
          .send(
            result.user,
            failure(result, result.account && connect.expected(result.account)),
          )
          .catch(() => {});
      return reply
        .code(400)
        .send(
          page(
            "The Google connection did not complete. Return to Telegram for details.",
          ),
        );
    }
    const label = GOOGLE_ACCOUNTS[result.account!].label;
    await connect
      .send(result.user!, `${label} is connected as ${result.email}.`)
      .catch(() => {});
    return reply.send(
      page(
        `${label} is connected. You can close this page and return to Telegram.`,
      ),
    );
  });
}
