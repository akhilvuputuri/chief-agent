import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "./db.js";
import { IbkrAuth, IbkrAuthError } from "./ibkr/oauth.js";
import { IbkrMcp, IbkrMcpError } from "./ibkr/mcp.js";
import { errorFields, opsLog } from "./ops-log.js";
import { ToolValidationError } from "./tool-errors.js";

/**
 * Read-only IBKR holdings (issue #146, docs/ibkr-portfolio.md). Each sync is an immutable
 * snapshot; only a validated complete (or genuinely empty) sync supersedes the holdings
 * shown, so a failed or malformed read never erases them or looks like a sale. Syncs are
 * deterministic and make no model calls. Nothing here can place, change or instruct trades.
 */

const money = z.number().finite();
const position = z
  .object({
    contract_id: z.number().int().positive(),
    contract_description: z.string().trim().min(1).max(64),
    position: money,
    market_price: money.nullable().optional(),
    market_value: money.nullable().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    average_price: money.nullable().optional(),
    unrealized_pnl: money.nullable().optional(),
    daily_pnl: money.nullable().optional(),
    asset_class: z.string().trim().min(1).max(16),
  })
  .passthrough();
const positionsBody = z.object({ positions: z.array(position).max(500) });
const balance = z
  .object({
    currency: z.string().regex(/^[A-Z]{3,4}$/),
    cash_balance: money,
    settled_cash: money.nullable().optional(),
    net_liquidation_value: money.nullable().optional(),
    stock_market_value: money.nullable().optional(),
    unrealized_pnl: money.nullable().optional(),
    realized_pnl: money.nullable().optional(),
    exchange_rate: money.nullable().optional(),
  })
  .passthrough();
const balancesBody = z.object({ balances: z.array(balance).max(50) });
const summaryBody = z
  .object({ currency: z.string().regex(/^[A-Z]{3}$/) })
  .passthrough();

/** Scheduled sync cadence; also keeps the rotating refresh token in regular use. */
const SYNC_EVERY_MS = 4 * 60 * 60 * 1000;
/** portfolio_read refreshes holdings older than this before answering. */
const READ_FRESH_MS = 15 * 60 * 1000;
const KEEP_SYNCS = 60;

type Notify = (user: string, text: string) => Promise<void>;

export interface SyncResult {
  id: string;
  status: "complete" | "empty" | "failed";
  errorCode?: string;
}

const round = (value: unknown, digits = 2) =>
  value == null || !Number.isFinite(Number(value))
    ? null
    : Math.round(Number(value) * 10 ** digits) / 10 ** digits;
const fmt = (value: number | null, digits = 2) =>
  value == null
    ? "—"
    : value.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
const signed = (value: number | null) =>
  value == null ? "—" : (value >= 0 ? "+" : "−") + fmt(Math.abs(value));
const pct = (value: number | null) =>
  value == null
    ? ""
    : ` (${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}%)`;
const sgt = (date: Date) =>
  date.toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/**
 * Cross-checks positions against the same read's balances, so an empty or truncated
 * positions list cannot pass as the owner having sold. An empty list is accepted only
 * when every balance reports no stock value; for currencies holding only stocks, the
 * positions' market values must sum to the balance's stock value (they matched exactly
 * when measured on 3 October 2026). Returns an error code, or null when consistent.
 */
export function reconcile(
  rows: z.infer<typeof position>[],
  balances: z.infer<typeof balance>[],
): string | null {
  const stockValue = (b: z.infer<typeof balance>) =>
    Math.abs(b.stock_market_value ?? 0);
  // Empty is believed only when balances positively report zero stock value.
  if (!rows.length)
    return balances.some((b) => b.stock_market_value != null) &&
      !balances.some((b) => stockValue(b) > 0.005)
      ? null
      : "empty_unconfirmed";
  for (const b of balances) {
    if (b.currency === "BASE" || b.stock_market_value == null) continue;
    const held = rows.filter((p) => p.currency === b.currency);
    if (!held.length) {
      if (stockValue(b) > 0.005) return "positions_incomplete";
      continue;
    }
    if (held.some((p) => p.market_value == null)) continue;
    // Whether IBKR's stock value includes other asset classes is unmeasured, so a
    // currency reconciles if either the stock-only or the full sum matches.
    const near = (sum: number) =>
      Math.abs(sum - b.stock_market_value!) <=
      Math.max(1, 0.01 * stockValue(b));
    const all = held.reduce((t, p) => t + p.market_value!, 0);
    const stocks = held
      .filter((p) => p.asset_class === "STK")
      .reduce((t, p) => t + p.market_value!, 0);
    if (!near(all) && !near(stocks)) return "positions_incomplete";
  }
  return null;
}

/** Splits at line boundaries into Telegram-sized messages (limit 4096). */
export function telegramChunks(text: string, limit = 3500) {
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const piece = line.length > limit ? line.slice(0, limit - 1) + "…" : line;
    if (current && current.length + 1 + piece.length > limit) {
      out.push(current);
      current = piece;
    } else current = current ? current + "\n" + piece : piece;
  }
  if (current) out.push(current);
  return out;
}

export class Portfolio {
  private inflight = new Map<string, Promise<SyncResult>>();
  private ticking = false;
  constructor(
    private db: Database,
    readonly auth: IbkrAuth,
    private mcp: IbkrMcp,
    private allowed: (user: string) => boolean,
    private notify: Notify = async () => {},
    private now: () => number = Date.now,
  ) {}

  /** A sync interrupted by a restart is recorded as failed; earlier holdings remain current. */
  async recover() {
    await this.db.query(
      "UPDATE portfolio_syncs SET status='failed',error_code='interrupted',finished_at=$1 WHERE status='running'",
      [new Date(this.now())],
    );
  }

  sync(user: string, reason: "connect" | "schedule" | "owner" | "read") {
    const running = this.inflight.get(user);
    if (running) return running;
    const next = this.runSync(user, reason).finally(() =>
      this.inflight.delete(user),
    );
    this.inflight.set(user, next);
    return next;
  }

  private async runSync(user: string, reason: string): Promise<SyncResult> {
    if (!this.allowed(user)) throw new Error("Unauthorized portfolio sync");
    const id = randomUUID();
    const started = this.now();
    await this.db.query(
      "INSERT INTO portfolio_syncs(id,user_id,provider,reason,status,started_at) VALUES($1,$2,'ibkr',$3,'running',$4)",
      [id, user, reason, new Date(started)],
    );
    const fail = async (code: string) => {
      // Mark failed first so no reader sees a current sync without its positions,
      // then remove any partial rows.
      await this.db.query(
        "UPDATE portfolio_syncs SET status='failed',error_code=$2,finished_at=$3 WHERE id=$1",
        [id, code.slice(0, 80), new Date(this.now())],
      );
      await this.db.query(
        "DELETE FROM portfolio_positions WHERE sync_id=$1 AND user_id=$2",
        [id, user],
      );
      opsLog("portfolio.sync", "warn", {
        state: "failed",
        errorCode: code,
        latencyMs: this.now() - started,
      });
      return { id, status: "failed" as const, errorCode: code };
    };
    let raw: Record<string, unknown>;
    try {
      raw = await this.mcp.read(user, [
        "get_account_positions",
        "get_account_balances",
        "get_account_summary",
      ]);
    } catch (error) {
      const code =
        error instanceof IbkrAuthError || error instanceof IbkrMcpError
          ? error.code
          : "read_failed";
      if (!(error instanceof IbkrAuthError || error instanceof IbkrMcpError))
        opsLog("portfolio.read_failed", "error", errorFields(error));
      if (code === "not_connected" || code === "scope_rejected")
        await this.noticeDisconnected(user);
      return fail(code);
    }
    const positions = positionsBody.safeParse(raw.get_account_positions);
    const balances = balancesBody.safeParse(raw.get_account_balances);
    const summary = summaryBody.safeParse(raw.get_account_summary);
    if (!positions.success || !balances.success || !summary.success)
      return fail("malformed");
    const rows = positions.data.positions;
    if (new Set(rows.map((p) => p.contract_id)).size !== rows.length)
      return fail("duplicate_contract");
    const unreconciled = reconcile(rows, balances.data.balances);
    if (unreconciled) return fail(unreconciled);
    // The owner may have disconnected (or reconnected) while the read was in flight:
    // keep nothing from it.
    const live = await this.auth.status(user);
    if (
      !["connected", "refresh_uncertain"].includes(live.state) ||
      (live.connectedAt && new Date(live.connectedAt).getTime() > started)
    )
      return fail("disconnected_during_sync");
    try {
      await this.store(
        id,
        user,
        rows,
        balances.data.balances,
        summary.data.currency,
      );
    } catch (error) {
      opsLog("portfolio.store_failed", "error", errorFields(error));
      return fail("store_failed");
    }
    // Retention is housekeeping: its failure never invalidates the stored snapshot.
    await this.prune(user).catch((error) =>
      opsLog("portfolio.prune_failed", "warn", errorFields(error)),
    );
    const status = rows.length ? "complete" : "empty";
    opsLog("portfolio.sync", "info", {
      state: status,
      positionCount: rows.length,
      latencyMs: this.now() - started,
    });
    return { id, status };
  }

  private async store(
    id: string,
    user: string,
    rows: z.infer<typeof position>[],
    balances: z.infer<typeof balance>[],
    baseCurrency: string,
  ) {
    for (const p of rows)
      await this.db.query(
        `INSERT INTO portfolio_positions(sync_id,user_id,contract_id,symbol,asset_class,currency,quantity,
           market_price,market_value,average_price,unrealized_pnl,daily_pnl)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          user,
          p.contract_id,
          p.contract_description,
          p.asset_class,
          p.currency,
          p.position,
          p.market_price ?? null,
          p.market_value ?? null,
          p.average_price ?? null,
          p.unrealized_pnl ?? null,
          p.daily_pnl ?? null,
        ],
      );
    const kept = balances.map((b) => ({
      currency: b.currency,
      cash: b.cash_balance,
      settledCash: b.settled_cash ?? null,
      netLiquidation: b.net_liquidation_value ?? null,
      stockValue: b.stock_market_value ?? null,
      unrealizedPnl: b.unrealized_pnl ?? null,
      realizedPnl: b.realized_pnl ?? null,
      exchangeRate: b.exchange_rate ?? null,
    }));
    const status = rows.length ? "complete" : "empty";
    await this.db.query(
      `UPDATE portfolio_syncs SET status=$2,position_count=$3,base_currency=$4,balances=$5::jsonb,finished_at=$6
       WHERE id=$1`,
      [
        id,
        status,
        rows.length,
        baseCurrency,
        JSON.stringify(kept),
        new Date(this.now()),
      ],
    );
  }

  /** Keeps the newest syncs, and never the latest successful one. */
  private async prune(user: string) {
    await this.db.query(
      `DELETE FROM portfolio_syncs WHERE user_id=$1 AND provider='ibkr' AND status<>'running'
         AND id IN (SELECT id FROM portfolio_syncs WHERE user_id=$1 AND provider='ibkr'
                    ORDER BY started_at DESC OFFSET $2)
         AND id NOT IN (SELECT id FROM portfolio_syncs WHERE user_id=$1 AND provider='ibkr'
                        AND status IN ('complete','empty') ORDER BY started_at DESC LIMIT 1)`,
      [user, KEEP_SYNCS],
    );
  }

  /** Tell the owner once that access ended; reconnecting clears the marker. */
  private async noticeDisconnected(user: string) {
    const marked = await this.db.query(
      `UPDATE brokerage_connections SET disconnect_notified_at=$3
       WHERE user_id=$1 AND provider=$2 AND state IN ('disconnected') AND disconnect_notified_at IS NULL
       RETURNING id`,
      [user, "ibkr", new Date(this.now())],
    );
    if (marked.rows.length)
      await this.notify(
        user,
        "IBKR access has ended (expired or revoked), so holdings are no longer updating. The last synced holdings are kept. Send /portfolio connect to reconnect read-only access.",
      ).catch(() => {});
  }

  /** Scheduled syncs for connected owners, with backoff after failures. */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.db.query(
        `SELECT c.user_id,
           (SELECT max(finished_at) FROM portfolio_syncs s WHERE s.user_id=c.user_id AND s.provider='ibkr' AND s.status IN ('complete','empty')
              AND s.started_at>=c.connected_at) AS last_ok,
           (SELECT max(started_at) FROM portfolio_syncs s WHERE s.user_id=c.user_id AND s.provider='ibkr') AS last_attempt,
           (SELECT count(*)::int FROM portfolio_syncs s WHERE s.user_id=c.user_id AND s.provider='ibkr' AND s.status='failed'
              AND s.started_at>=c.connected_at
              AND s.started_at > COALESCE((SELECT max(started_at) FROM portfolio_syncs t WHERE t.user_id=c.user_id AND t.provider='ibkr' AND t.status IN ('complete','empty')),'-infinity')) AS failures
         FROM brokerage_connections c WHERE c.provider='ibkr' AND c.state IN ('connected','refresh_uncertain')`,
      );
      for (const row of due.rows) {
        if (!this.allowed(row.user_id)) continue;
        const now = this.now();
        const lastOk = row.last_ok ? new Date(row.last_ok).getTime() : 0;
        const lastAttempt = row.last_attempt
          ? new Date(row.last_attempt).getTime()
          : 0;
        const backoff = Math.min(
          SYNC_EVERY_MS,
          15 * 60 * 1000 * 2 ** Math.min(row.failures, 6),
        );
        if (now - lastOk < SYNC_EVERY_MS) continue;
        if (row.failures > 0 && now - lastAttempt < backoff) continue;
        await this.sync(row.user_id, "schedule");
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Latest holdings (complete or empty sync) plus the most recent attempt. */
  async snapshot(user: string) {
    const connection = await this.auth.status(user);
    // While connected, only syncs under the current grant count: a reconnect may have
    // selected a different IBKR account. After a disconnect the last holdings remain.
    const since =
      connection.connectedAt &&
      ["connected", "refresh_uncertain"].includes(connection.state)
        ? new Date(connection.connectedAt)
        : new Date(0);
    const current = (
      await this.db.query(
        `SELECT * FROM portfolio_syncs WHERE user_id=$1 AND provider='ibkr' AND status IN ('complete','empty')
           AND started_at>=$2
         ORDER BY started_at DESC LIMIT 1`,
        [user, since],
      )
    ).rows[0];
    const last = (
      await this.db.query(
        `SELECT status,started_at,finished_at,error_code FROM portfolio_syncs WHERE user_id=$1 AND provider='ibkr'
         ORDER BY started_at DESC LIMIT 1`,
        [user],
      )
    ).rows[0];
    if (!current) return { connection, current: null, last, positions: [] };
    const positions = (
      await this.db.query(
        `SELECT * FROM portfolio_positions WHERE sync_id=$1 AND user_id=$2 ORDER BY market_value DESC NULLS LAST, symbol`,
        [current.id, user],
      )
    ).rows;
    return { connection, current, last, positions };
  }

  /** Model-facing view: exact broker figures with explicit freshness and provenance. */
  async read(user: string) {
    const status = await this.auth.status(user);
    let snap = await this.snapshot(user);
    const age = snap.current
      ? this.now() - new Date(snap.current.finished_at).getTime()
      : Infinity;
    let refreshed: SyncResult | undefined;
    const lastFailedRecently =
      snap.last?.status === "failed" &&
      this.now() - new Date(snap.last.started_at).getTime() < READ_FRESH_MS;
    if (
      ["connected", "refresh_uncertain"].includes(status.state) &&
      age > READ_FRESH_MS &&
      !lastFailedRecently &&
      snap.last?.status !== "running"
    ) {
      refreshed = await this.sync(user, "read");
      snap = await this.snapshot(user);
    }
    return this.describe(snap, refreshed);
  }

  private describe(
    snap: Awaited<ReturnType<Portfolio["snapshot"]>>,
    refreshed?: SyncResult,
  ) {
    const connected = ["connected", "refresh_uncertain"].includes(
      snap.connection.state,
    );
    const lastAttempt = snap.last
      ? {
          status: snap.last.status,
          at: new Date(snap.last.started_at).toISOString(),
          errorCode: snap.last.error_code ?? null,
        }
      : null;
    if (!snap.current)
      return {
        connection: snap.connection.state,
        holdings: null,
        lastAttempt,
        note: connected
          ? "No successful IBKR sync yet."
          : "IBKR is not connected. The owner can send /portfolio connect in Telegram to grant read-only access.",
      };
    const finished = new Date(snap.current.finished_at);
    const ageMinutes = Math.round((this.now() - finished.getTime()) / 60000);
    const positions = snap.positions.map((p: any) => {
      const quantity = Number(p.quantity);
      const avg = p.average_price == null ? null : Number(p.average_price);
      // Options/futures carry contract multipliers IBKR does not report here, so their
      // cost basis (and the totals that include them) is left unknown rather than wrong.
      const cost =
        avg == null || p.asset_class !== "STK" ? null : avg * quantity;
      const pnl = p.unrealized_pnl == null ? null : Number(p.unrealized_pnl);
      return {
        symbol: p.symbol,
        contractId: Number(p.contract_id),
        assetClass: p.asset_class,
        currency: p.currency,
        quantity,
        price: round(p.market_price, 4),
        marketValue: round(p.market_value),
        averageCost: round(avg, 4),
        costBasis: round(cost),
        unrealizedPnl: round(pnl),
        unrealizedPct:
          cost && pnl != null ? round((pnl / Math.abs(cost)) * 100, 1) : null,
        dailyPnl: round(p.daily_pnl),
      };
    });
    const totals: Record<string, any> = {};
    for (const p of positions) {
      const t = (totals[p.currency] ??= {
        marketValue: 0,
        costBasis: 0,
        unrealizedPnl: 0,
        complete: true,
      });
      if (
        p.marketValue == null ||
        p.costBasis == null ||
        p.unrealizedPnl == null
      )
        t.complete = false;
      if (p.marketValue == null) t.missingValue = true;
      if (p.unrealizedPnl == null) t.missingPnl = true;
      t.marketValue += p.marketValue ?? 0;
      t.costBasis += p.costBasis ?? 0;
      t.unrealizedPnl += p.unrealizedPnl ?? 0;
    }
    for (const t of Object.values(totals)) {
      // A partial sum is not a total: any unknown figure makes that total unknown.
      t.marketValue = t.missingValue ? null : round(t.marketValue);
      t.costBasis = t.complete ? round(t.costBasis) : null;
      t.unrealizedPnl = t.missingPnl ? null : round(t.unrealizedPnl);
      t.unrealizedPct =
        t.costBasis && t.unrealizedPnl != null
          ? round((t.unrealizedPnl / Math.abs(t.costBasis)) * 100, 1)
          : null;
      delete t.missingValue;
      delete t.missingPnl;
    }
    const balances: any[] = snap.current.balances ?? [];
    const base = balances.find((b) => b.currency === "BASE");
    return {
      connection: snap.connection.state,
      asOf: finished.toISOString(),
      ageMinutes,
      freshness: !connected
        ? "disconnected"
        : ageMinutes <= SYNC_EVERY_MS / 60000 + 30
          ? "fresh"
          : "stale",
      source:
        "IBKR account data (read-only). Prices are IBKR's marks at sync time, not live quotes.",
      baseCurrency: snap.current.base_currency,
      positions,
      totalsByCurrency: totals,
      account: base
        ? {
            currency: snap.current.base_currency,
            netLiquidation: round(base.netLiquidation),
            stockValue: round(base.stockValue),
            unrealizedPnl: round(base.unrealizedPnl),
            realizedPnl: round(base.realizedPnl),
          }
        : null,
      cash: balances
        .filter((b) => b.currency !== "BASE")
        .map((b) => ({
          currency: b.currency,
          cash: round(b.cash),
          rateToBase: round(b.exchangeRate, 6),
        })),
      lastAttempt,
      ...(refreshed?.status === "failed"
        ? {
            note: `A fresh sync just failed (${refreshed.errorCode}); these are the last synced holdings.`,
          }
        : {}),
    };
  }

  /**
   * Chief may only propose: this queues a Telegram card. Connecting needs the owner to
   * open the card's IBKR link and approve there; disconnecting needs the owner's tap.
   */
  async propose(user: string, run: string, kind: "connect" | "disconnect") {
    const turn = (
      await this.db.query(
        "SELECT background FROM work_turns WHERE run_id=$1 AND user_id=$2",
        [run, user],
      )
    ).rows[0];
    if (!turn || turn.background)
      throw new ToolValidationError(
        "Only a foreground owner request may propose connecting or disconnecting IBKR",
      );
    const live = ["connected", "refresh_uncertain"].includes(
      (await this.auth.status(user)).state,
    );
    if (kind === "connect" && live)
      return {
        status: "already_connected",
        note: "IBKR is already connected; no card was created.",
      };
    if (kind === "disconnect" && !live)
      return {
        status: "not_connected",
        note: "IBKR is not connected; no card was created.",
      };
    const operation = `portfolio_${kind}`;
    // One open card per kind: a newer request supersedes an unanswered one.
    await this.db.query(
      "UPDATE approvals SET status='denied',payload=payload || '{\"superseded\":true}'::jsonb WHERE user_id=$1 AND operation=$2 AND status='pending'",
      [user, operation],
    );
    // Approval expiry uses database time, like every other approval card.
    const expiresAt = (
      await this.db.query(
        "INSERT INTO approvals(id,user_id,run_id,operation,payload,expires_at) VALUES($1,$2,$3,$4,'{}'::jsonb,now()+interval '15 minutes') RETURNING expires_at",
        [randomUUID(), user, run, operation],
      )
    ).rows[0].expires_at as Date;
    return {
      status: "awaiting_owner_tap",
      card: kind,
      expiresAt: new Date(expiresAt).toISOString(),
      note:
        kind === "connect"
          ? "A Telegram card with an 'Open IBKR (read-only)' button is sent after this reply. Nothing is connected until the owner opens it and approves on IBKR's site."
          : "A Telegram card asks the owner to confirm. Nothing is disconnected until they tap Disconnect.",
    };
  }

  /** The owner's tap on a disconnect card: the exact sent message, pending, unexpired, once. */
  async decideDisconnect(
    user: string,
    approvalId: string,
    messageId: number | undefined,
    approve: boolean,
  ): Promise<{
    status: "disconnected" | "kept" | "unavailable";
    text: string;
  }> {
    if (!this.allowed(user)) throw new Error("Unauthorized portfolio decision");
    const claimed = (
      await this.db.query(
        `UPDATE approvals SET status=$3 WHERE id=$1 AND user_id=$2 AND operation='portfolio_disconnect'
           AND status='pending' AND expires_at>now() AND (payload->>'telegramMessageId')::bigint=$4
         RETURNING id`,
        [approvalId, user, approve ? "approved" : "denied", messageId ?? -1],
      )
    ).rows[0];
    if (!claimed)
      return {
        status: "unavailable",
        text: "This card is expired or already used. Ask Chief again if you still want to disconnect.",
      };
    if (!approve) return { status: "kept", text: "IBKR stays connected." };
    return {
      status: "disconnected",
      text: (await this.command(user, "disconnect")).text,
    };
  }

  async call(user: string, a: { operation: string }, run?: string) {
    if (!this.allowed(user)) throw new Error("Unauthorized portfolio access");
    if (
      a.operation === "portfolio_connect" ||
      a.operation === "portfolio_disconnect"
    ) {
      if (!run)
        throw new ToolValidationError("A conversation turn is required");
      return this.propose(
        user,
        run,
        a.operation === "portfolio_connect" ? "connect" : "disconnect",
      );
    }
    if (a.operation === "portfolio_read") return this.read(user);
    if (a.operation === "portfolio_status") {
      const snap = await this.snapshot(user);
      return {
        connection: snap.connection,
        lastSuccessfulSync: snap.current
          ? new Date(snap.current.finished_at).toISOString()
          : null,
        positionCount: snap.current?.position_count ?? null,
        lastAttempt: snap.last
          ? {
              status: snap.last.status,
              at: new Date(snap.last.started_at).toISOString(),
              errorCode: snap.last.error_code ?? null,
            }
          : null,
      };
    }
    throw new Error("Unknown portfolio operation");
  }

  /** Telegram /portfolio [connect|refresh|disconnect]; host commands, not model tools. */
  async command(
    user: string,
    kind: "show" | "connect" | "refresh" | "disconnect",
  ): Promise<{ text: string; url?: string }> {
    if (!this.allowed(user)) throw new Error("Unauthorized portfolio command");
    if (kind === "connect") {
      // One live grant at a time: reconnecting would revoke the old refresh token, which
      // some servers treat as revoking the whole grant (unverified for IBKR).
      if (
        ["connected", "refresh_uncertain"].includes(
          (await this.auth.status(user)).state,
        )
      )
        return {
          text: "IBKR is already connected. Send /portfolio disconnect first if you want to reconnect.",
        };
      try {
        const { url } = await this.auth.begin(user);
        return {
          text: "Open the button within 10 minutes, log in on IBKR's own site and approve read-only access. Chief requests read-only access and refuses anything broader; it cannot place or change trades.",
          url,
        };
      } catch (error) {
        if (error instanceof IbkrAuthError)
          return {
            text: error.transient
              ? "IBKR could not be reached to start the connection. Try /portfolio connect again shortly."
              : error.code === "attempt_limit"
                ? error.message
                : "IBKR refused to start the connection. Nothing was changed.",
          };
        throw error;
      }
    }
    if (kind === "disconnect") {
      const done = await this.auth.disconnect(user, "owner");
      return {
        text: done
          ? "IBKR access removed from Chief and a revoke was sent to IBKR. Synced holdings are kept. You can also check Settings → Manage Third-Party Consents in IBKR."
          : "IBKR is not connected.",
      };
    }
    const status = await this.auth.status(user);
    if (kind === "refresh") {
      if (!["connected", "refresh_uncertain"].includes(status.state))
        return { text: "IBKR is not connected. Send /portfolio connect." };
      await this.sync(user, "owner");
    }
    return { text: this.render(this.describe(await this.snapshot(user))) };
  }

  /** Phone-friendly text: one line per holding, no tables. */
  render(view: ReturnType<Portfolio["describe"]>) {
    if (!("positions" in view))
      return view.connection === "never_connected" ||
        !["connected", "refresh_uncertain"].includes(view.connection)
        ? "IBKR is not connected. Send /portfolio connect to grant Chief read-only access to your holdings."
        : `No IBKR holdings synced yet${view.lastAttempt?.errorCode ? ` (last attempt: ${view.lastAttempt.errorCode})` : ""}. Try /portfolio refresh.`;
    const lines = [
      `IBKR holdings · as of ${sgt(new Date(view.asOf))} SGT${view.freshness === "fresh" ? "" : ` (${view.freshness})`}`,
      "",
    ];
    if (!view.positions.length) lines.push("No open positions.");
    for (const p of view.positions)
      lines.push(
        `${p.symbol} · ${fmt(p.quantity, Number.isInteger(p.quantity) ? 0 : 4)} @ ${fmt(p.price)} = ${p.currency} ${fmt(p.marketValue)} · ${signed(p.unrealizedPnl)}${pct(p.unrealizedPct)}`,
      );
    for (const [currency, t] of Object.entries(view.totalsByCurrency))
      lines.push(
        "",
        `Total ${currency} ${fmt(t.marketValue)} · cost ${fmt(t.costBasis)} · ${signed(t.unrealizedPnl)}${pct(t.unrealizedPct)}${t.complete ? "" : " (some figures missing)"}`,
      );
    if (view.account)
      lines.push(
        `Account (${view.account.currency}): net liquidation ${fmt(view.account.netLiquidation)}`,
      );
    if (view.cash.length)
      lines.push(
        "Cash: " +
          view.cash.map((c) => `${c.currency} ${fmt(c.cash)}`).join(", "),
      );
    if (view.lastAttempt?.status === "failed")
      lines.push(
        "",
        `Latest sync attempt failed (${view.lastAttempt.errorCode}); showing the last successful one.`,
      );
    lines.push(
      "",
      "Prices are IBKR's marks at sync time, not live quotes. Read-only: Chief cannot trade.",
    );
    return lines.join("\n");
  }
}
