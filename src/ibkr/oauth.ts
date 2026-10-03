import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "../db.js";
import { open, seal } from "../secret-box.js";

/**
 * Host-side OAuth for IBKR's hosted MCP server (issue #146). Chief is a public client
 * (PKCE S256, no secret). It requests only `mcp.read`; IBKR registers every client with
 * `mcp.read mcp.write mcp.orders.submit`, so the granted scope is checked on every token
 * response and anything broader is revoked and refused. Access tokens last ~10 minutes
 * and refresh tokens rotate on every use, so a refresh is single-flight in process and
 * leased in Postgres, and the rotated token is stored before the access token is used.
 */
export const IBKR = {
  issuer: "https://api.ibkr.com",
  resource: "https://api.ibkr.com/v1/api/mcp-public",
  registration: "https://api.ibkr.com/oauth2/register",
  authorize: "https://api.ibkr.com/oauth2/authorize",
  token: "https://api.ibkr.com/oauth2/api/v1/token",
  revoke: "https://api.ibkr.com/oauth2/api/v1/token/revoke",
  scope: "mcp.read",
} as const;
const PROVIDER = "ibkr";
const ATTEMPT_MS = 10 * 60 * 1000;
const ATTEMPTS_PER_DAY = 5;
const EARLY_REFRESH_MS = 60 * 1000;
const LEASE_MS = 30 * 1000;

export class IbkrAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly transient = false,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;
interface Tokens {
  access: string;
  refresh: string;
}
interface TokenResponse extends Tokens {
  expiresIn: number;
  scopes: string[];
}

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Exactly mcp.read; any other mcp.* scope means IBKR granted more than read access. */
export function readOnly(scopes: string[]) {
  return (
    scopes.includes(IBKR.scope) &&
    !scopes.some((s) => s.startsWith("mcp.") && s !== IBKR.scope)
  );
}

function scopesOf(body: any): string[] {
  if (typeof body.scope === "string")
    return body.scope.split(/\s+/).filter(Boolean);
  const parts = String(body.access_token ?? "").split(".");
  if (parts.length === 3) {
    try {
      const claims = JSON.parse(
        Buffer.from(parts[1]!, "base64url").toString("utf8"),
      );
      const s = claims.scope ?? claims.scp;
      if (typeof s === "string") return s.split(/\s+/).filter(Boolean);
      if (Array.isArray(s)) return s.map(String);
    } catch {
      /* unverifiable scope is refused below */
    }
  }
  return [];
}

export class IbkrAuth {
  private inflight = new Map<string, Promise<string>>();
  constructor(
    private db: Database,
    private key: Buffer,
    readonly redirectUri: string,
    private http: Fetch = fetch,
    private now: () => number = Date.now,
  ) {}

  private request(url: string, init: RequestInit) {
    return this.http(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  }

  /** The registered public client for this redirect URI; registers once if absent. */
  async clientId(): Promise<string> {
    const saved = await this.db.query(
      "SELECT client_id FROM brokerage_clients WHERE provider=$1 AND redirect_uri=$2",
      [PROVIDER, this.redirectUri],
    );
    if (saved.rows[0]) return saved.rows[0].client_id;
    let response: Response;
    try {
      response = await this.request(IBKR.registration, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Chief personal assistant (read-only portfolio)",
          redirect_uris: [this.redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: IBKR.scope,
        }),
      });
    } catch {
      throw new IbkrAuthError(
        "IBKR registration unreachable",
        "register_unreachable",
        true,
      );
    }
    const body: any = await response.json().catch(() => ({}));
    const id = typeof body.client_id === "string" ? body.client_id : "";
    if (!response.ok || !id || id.length > 200)
      throw new IbkrAuthError(
        "IBKR refused client registration",
        `register_${response.status}`,
      );
    await this.db.query(
      "INSERT INTO brokerage_clients(provider,redirect_uri,client_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [PROVIDER, this.redirectUri, id],
    );
    return (
      await this.db.query(
        "SELECT client_id FROM brokerage_clients WHERE provider=$1 AND redirect_uri=$2",
        [PROVIDER, this.redirectUri],
      )
    ).rows[0].client_id;
  }

  /** Starts a consent attempt; the URL opens IBKR's own login and consent pages. */
  async begin(user: string) {
    const now = new Date(this.now());
    await this.db.query(
      "UPDATE brokerage_oauth_attempts SET status='expired' WHERE user_id=$1 AND provider=$2 AND status='pending'",
      [user, PROVIDER],
    );
    const today = (
      await this.db.query(
        "SELECT count(*)::int AS n FROM brokerage_oauth_attempts WHERE user_id=$1 AND provider=$2 AND created_at>$3",
        [user, PROVIDER, new Date(this.now() - 86400000)],
      )
    ).rows[0].n;
    if (today >= ATTEMPTS_PER_DAY)
      throw new IbkrAuthError(
        "Too many IBKR connection attempts in the last day; try again tomorrow.",
        "attempt_limit",
      );
    const client = await this.clientId();
    const id = randomUUID();
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const expiresAt = new Date(now.getTime() + ATTEMPT_MS);
    await this.db.query(
      `INSERT INTO brokerage_oauth_attempts(id,user_id,provider,state_hash,verifier_box,created_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        user,
        PROVIDER,
        sha256(state),
        seal(this.key, verifier, `ibkr-attempt-v1:${id}`),
        now,
        expiresAt,
      ],
    );
    const url = new URL(IBKR.authorize);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: client,
      redirect_uri: this.redirectUri,
      scope: IBKR.scope,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: IBKR.resource,
    }).toString();
    return { url: url.toString(), expiresAt };
  }

  /**
   * Completes a callback. The state is single-use: the attempt is claimed before the
   * code is exchanged, so a replayed or late callback cannot connect anything.
   */
  async complete(
    state: string,
    code: string | undefined,
    error: string | undefined,
  ): Promise<{ user?: string; ok: boolean; reason?: string }> {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(state))
      return { ok: false, reason: "invalid_state" };
    const claimed = (
      await this.db.query(
        `UPDATE brokerage_oauth_attempts SET status='used',completed_at=$3
         WHERE state_hash=$1 AND provider=$2 AND status='pending' AND expires_at>$3
         RETURNING id,user_id,verifier_box`,
        [sha256(state), PROVIDER, new Date(this.now())],
      )
    ).rows[0];
    if (!claimed) return { ok: false, reason: "expired_or_unknown" };
    const fail = async (reason: string) => {
      await this.db.query(
        "UPDATE brokerage_oauth_attempts SET status='failed',error_code=$2 WHERE id=$1",
        [claimed.id, reason],
      );
      return { user: claimed.user_id as string, ok: false, reason };
    };
    if (error || !code || code.length > 2000)
      return fail("consent_not_completed");
    const verifier = open(
      this.key,
      claimed.verifier_box,
      `ibkr-attempt-v1:${claimed.id}`,
    );
    let tokens: TokenResponse;
    try {
      tokens = await this.tokenRequest({
        grant_type: "authorization_code",
        client_id: await this.clientId(),
        code,
        code_verifier: verifier,
        redirect_uri: this.redirectUri,
        resource: IBKR.resource,
      });
    } catch (e) {
      return fail(e instanceof IbkrAuthError ? e.code : "exchange_failed");
    }
    if (!readOnly(tokens.scopes)) {
      await this.revokeRemote(tokens.refresh);
      return fail("scope_rejected");
    }
    await this.db.query(
      `INSERT INTO brokerage_connections(id,user_id,provider,state,scopes,token_box,access_expires_at,last_refresh_at,created_at,updated_at)
       VALUES($1,$2,$3,'connected',$4,$5,$6,$7,$7,$7)
       ON CONFLICT(user_id,provider) DO UPDATE SET state='connected',scopes=EXCLUDED.scopes,
         token_box=EXCLUDED.token_box,token_version=brokerage_connections.token_version+1,
         access_expires_at=EXCLUDED.access_expires_at,last_refresh_at=EXCLUDED.last_refresh_at,
         refresh_lease_until=NULL,last_error_code=NULL,disconnect_notified_at=NULL,updated_at=EXCLUDED.updated_at`,
      [
        randomUUID(),
        claimed.user_id,
        PROVIDER,
        tokens.scopes,
        this.box(claimed.user_id, tokens),
        new Date(this.now() + tokens.expiresIn * 1000),
        new Date(this.now()),
      ],
    );
    return { user: claimed.user_id, ok: true };
  }

  /** A valid access token, refreshing (and rotating) when it is about to expire. */
  accessToken(user: string, force = false): Promise<string> {
    const running = this.inflight.get(user);
    if (running) return running;
    const next = this.resolve(user, force).finally(() =>
      this.inflight.delete(user),
    );
    this.inflight.set(user, next);
    return next;
  }

  async status(user: string) {
    const row = (
      await this.db.query(
        "SELECT state,scopes,last_refresh_at,last_error_code,created_at,updated_at FROM brokerage_connections WHERE user_id=$1 AND provider=$2",
        [user, PROVIDER],
      )
    ).rows[0];
    return row
      ? {
          state: row.state as string,
          scopes: row.scopes as string[],
          lastRefreshAt: row.last_refresh_at as Date | null,
          lastErrorCode: row.last_error_code as string | null,
        }
      : { state: "never_connected" };
  }

  /**
   * Local tokens are wiped first so nothing can use them afterwards; the remote revoke is
   * a single best-effort call. Holdings snapshots are kept.
   */
  async disconnect(user: string, reason: "owner" | string) {
    const row = (
      await this.db.query(
        `WITH old AS (
           SELECT id,token_box FROM brokerage_connections
           WHERE user_id=$1 AND provider=$2 AND token_box IS NOT NULL FOR UPDATE)
         UPDATE brokerage_connections c SET state=$3,token_box=NULL,refresh_lease_until=NULL,
           last_error_code=$4,updated_at=$5
         FROM old WHERE c.id=old.id
         RETURNING old.token_box AS old_box`,
        [
          user,
          PROVIDER,
          reason === "owner" ? "revoked" : "disconnected",
          reason === "owner" ? null : reason.slice(0, 80),
          new Date(this.now()),
        ],
      )
    ).rows[0];
    if (reason === "owner" && row?.old_box) {
      try {
        await this.revokeRemote(this.unbox(user, row.old_box).refresh);
      } catch {
        /* local access is already gone */
      }
    }
    return !!row;
  }

  private box(user: string, t: Tokens) {
    return seal(
      this.key,
      JSON.stringify({ access: t.access, refresh: t.refresh }),
      `ibkr-connection-v1:${user}`,
    );
  }
  private unbox(user: string, box: Uint8Array): Tokens {
    return JSON.parse(open(this.key, box, `ibkr-connection-v1:${user}`));
  }

  private async resolve(user: string, force: boolean): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = (
        await this.db.query(
          "SELECT state,token_box,token_version,access_expires_at FROM brokerage_connections WHERE user_id=$1 AND provider=$2",
          [user, PROVIDER],
        )
      ).rows[0];
      if (!row || !row.token_box)
        throw new IbkrAuthError("IBKR is not connected", "not_connected");
      const tokens = this.unbox(user, row.token_box);
      if (
        !force &&
        row.state === "connected" &&
        new Date(row.access_expires_at).getTime() - this.now() >
          EARLY_REFRESH_MS
      )
        return tokens.access;
      // Lease the stored refresh token; another holder means a refresh is in progress.
      const leased = (
        await this.db.query(
          `UPDATE brokerage_connections SET refresh_lease_until=$4
           WHERE user_id=$1 AND provider=$2 AND token_version=$3 AND token_box IS NOT NULL
             AND (refresh_lease_until IS NULL OR refresh_lease_until<$5)
           RETURNING token_version`,
          [
            user,
            PROVIDER,
            row.token_version,
            new Date(this.now() + LEASE_MS),
            new Date(this.now()),
          ],
        )
      ).rows[0];
      if (!leased) {
        await new Promise((r) => setTimeout(r, 1000));
        force = false;
        continue;
      }
      return this.refresh(user, row.token_version, tokens);
    }
    throw new IbkrAuthError("IBKR token refresh is busy", "refresh_busy", true);
  }

  private async refresh(user: string, version: number, tokens: Tokens) {
    const release = (code: string, state?: string) =>
      this.db.query(
        `UPDATE brokerage_connections SET refresh_lease_until=NULL,last_error_code=$4,
           state=COALESCE($5,state),updated_at=$6
         WHERE user_id=$1 AND provider=$2 AND token_version=$3`,
        [user, PROVIDER, version, code, state ?? null, new Date(this.now())],
      );
    let next: TokenResponse;
    try {
      next = await this.tokenRequest({
        grant_type: "refresh_token",
        client_id: await this.clientId(),
        refresh_token: tokens.refresh,
        resource: IBKR.resource,
      });
    } catch (e) {
      const error =
        e instanceof IbkrAuthError
          ? e
          : new IbkrAuthError("IBKR refresh failed", "refresh_failed", true);
      if (error.code === "invalid_grant") {
        await this.disconnect(user, "invalid_grant");
        throw new IbkrAuthError(
          "IBKR authorization expired or was revoked",
          "not_connected",
        );
      }
      // The response was lost: IBKR may already have rotated the token. Keep the stored
      // one; a later attempt either succeeds or reports invalid_grant and disconnects.
      await release(
        error.code,
        error.code === "token_unreachable" ? "refresh_uncertain" : undefined,
      );
      throw error;
    }
    if (!readOnly(next.scopes)) {
      await this.revokeRemote(next.refresh);
      await this.disconnect(user, "scope_rejected");
      throw new IbkrAuthError(
        "IBKR granted more than read access",
        "scope_rejected",
      );
    }
    const stored = await this.db.query(
      `UPDATE brokerage_connections SET token_box=$4,token_version=token_version+1,state='connected',
         scopes=$5,access_expires_at=$6,last_refresh_at=$7,refresh_lease_until=NULL,last_error_code=NULL,updated_at=$7
       WHERE user_id=$1 AND provider=$2 AND token_version=$3 AND token_box IS NOT NULL
       RETURNING token_version`,
      [
        user,
        PROVIDER,
        version,
        this.box(user, next),
        next.scopes,
        new Date(this.now() + next.expiresIn * 1000),
        new Date(this.now()),
      ],
    );
    if (!stored.rows.length)
      throw new IbkrAuthError(
        "IBKR connection changed during refresh",
        "not_connected",
      );
    return next.access;
  }

  private async tokenRequest(
    form: Record<string, string>,
  ): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await this.request(IBKR.token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
      });
    } catch {
      throw new IbkrAuthError(
        "IBKR token endpoint unreachable",
        "token_unreachable",
        true,
      );
    }
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code =
        body?.error === "invalid_grant"
          ? "invalid_grant"
          : `token_${response.status}`;
      throw new IbkrAuthError(
        "IBKR token request failed",
        code,
        response.status === 429 || response.status >= 500,
      );
    }
    const refresh = body.refresh_token ?? form.refresh_token;
    if (
      typeof body.access_token !== "string" ||
      typeof refresh !== "string" ||
      !(Number(body.expires_in) > 0)
    )
      throw new IbkrAuthError(
        "IBKR token response incomplete",
        "token_incomplete",
      );
    return {
      access: body.access_token,
      refresh,
      expiresIn: Math.min(Number(body.expires_in), 86400),
      scopes: scopesOf(body),
    };
  }

  private async revokeRemote(token: string) {
    try {
      await this.request(IBKR.revoke, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token,
          token_type_hint: "refresh_token",
          client_id: await this.clientId(),
        }),
      });
    } catch {
      /* best effort */
    }
  }
}
