import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import type { Action } from "./protocol.js";
import { ToolValidationError } from "./tool-errors.js";
import {
  ProviderError,
  quoteKey,
  type MarketDataProvider,
  type Quote,
  type SymbolHit,
} from "./stock-provider.js";
import { marketCalendar, sessionsFor } from "./market-calendar.js";

/** Terminal-suppress a user's queued alerts ('muted'); delivered or uncertain
 * rows are untouched. Used when an item or the whole feature is paused. */
async function mutePending(db: Database, userId: string, itemId?: string) {
  await db.query(
    `UPDATE stock_alerts SET state='muted' WHERE user_id=$1 AND state='pending'${
      itemId ? " AND item_id=$2" : ""
    }`,
    itemId ? [userId, itemId] : [userId],
  );
}

type WatchlistAction = Extract<Action, { operation: `watchlist_${string}` }>;

/** Owner-scoped conversational watchlist management. Mutations are foreground-only,
 * matching the routine boundary: market data must never authorize settings changes. */
export class WatchlistTools {
  constructor(
    private db: Database,
    private provider?: MarketDataProvider,
  ) {}
  private async requireForeground(user: string, run: string) {
    const turn = (
      await this.db.query(
        "SELECT background FROM work_turns WHERE run_id=$1 AND user_id=$2",
        [run, user],
      )
    ).rows[0];
    if (!turn || turn.background)
      throw new ToolValidationError(
        "Only a foreground user request may change the watchlist",
      );
  }
  async call(user: string, run: string, a: WatchlistAction): Promise<any> {
    if (a.operation === "watchlist_list") return this.list(user);
    await this.requireForeground(user, run);
    if (a.operation === "watchlist_add") return this.add(user, a);
    if (a.operation === "watchlist_remove") return this.remove(user, a.id);
    if (a.operation === "watchlist_update") return this.update(user, a);
    return this.settings(user, a);
  }
  private async list(user: string) {
    const settings = (
      await this.db.query("SELECT * FROM stock_settings WHERE user_id=$1", [
        user,
      ])
    ).rows[0];
    const items = (
      await this.db.query(
        `SELECT i.*,
          (SELECT jsonb_build_object('state',al.state,'tradingDate',al.trading_date,'sentAt',al.sent_at)
             FROM stock_alerts al WHERE al.item_id=i.id ORDER BY al.created_at DESC LIMIT 1) AS alert,
          (SELECT jsonb_build_object('decision',o.decision,'at',o.observed_at,'price',o.price,'prevClose',o.prev_close,
              'changePct',o.change_pct,'marketState',o.market_state,'detail',o.detail)
             FROM stock_observations o WHERE o.item_id=i.id ORDER BY o.observed_at DESC LIMIT 1) AS last_observation
         FROM watchlist_items i WHERE i.user_id=$1 ORDER BY i.symbol LIMIT 50`,
        [user],
      )
    ).rows;
    return {
      provider: this.provider?.name ?? null,
      settings: settings ?? {
        default_drop_pct: 5,
        paused: false,
        poll_minutes: 15,
        include_extended: false,
      },
      items,
      basis:
        "daily decline = (observed price / previous trading-session close - 1) x 100%",
    };
  }
  private pick(hits: SymbolHit[], query: string, exchange?: string) {
    let pool = hits;
    if (exchange) {
      const needle = exchange.toLowerCase();
      pool = hits.filter(
        (h) =>
          h.exchange.toLowerCase() === needle ||
          h.mic.toLowerCase() === needle ||
          h.exchange.toLowerCase().includes(needle),
      );
      if (!pool.length)
        throw new ToolValidationError(
          `No stock matching "${query}" on exchange "${exchange}"; check the exchange name or omit it to see all matches`,
        );
    }
    const ticker = /^[a-zA-Z0-9.\-]{1,15}$/.test(query.trim())
      ? query.trim().toUpperCase()
      : null;
    const exact = pool.filter((h) => h.symbol.toUpperCase() === ticker);
    if (exact.length === 1) return exact[0]!;
    if (!exact.length && pool.length === 1) return pool[0]!;
    const candidates = (exact.length ? exact : pool).slice(0, 5);
    if (!candidates.length)
      throw new ToolValidationError(
        `No stock found for "${query}"; try the exact ticker symbol`,
      );
    return {
      needsChoice: true,
      candidates: candidates.map((h) => ({
        symbol: h.symbol,
        name: h.name,
        exchange: h.exchange,
        currency: h.currency,
        type: h.type,
        access: h.access,
      })),
      instruction:
        "Multiple instruments match; ask the owner to pick an exchange, then call watchlist_add again with the symbol and that exchange.",
    };
  }
  private async add(
    user: string,
    a: Extract<WatchlistAction, { operation: "watchlist_add" }>,
  ) {
    if (!this.provider)
      throw new ToolValidationError(
        "Market data provider is not configured; the operator must set one up first",
      );
    let hits: SymbolHit[];
    try {
      hits = await this.provider.search(a.query);
    } catch (error) {
      throw new ToolValidationError(
        `Symbol lookup failed: ${error instanceof Error ? error.message : "provider error"}`,
      );
    }
    const hit = this.pick(hits, a.query, a.exchange);
    if ("needsChoice" in hit) return hit;
    if (!marketCalendar(hit.mic))
      throw new ToolValidationError(
        `${hit.exchange} isn't covered by the built-in US market calendar; only US exchanges (NYSE/Nasdaq hours) are supported`,
      );
    const row = (
      await this.db.query(
        `INSERT INTO watchlist_items(id,user_id,symbol,name,exchange,mic_code,exchange_timezone,currency,drop_pct)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
         WHERE (SELECT count(*) FROM watchlist_items WHERE user_id=$2)<25
         ON CONFLICT(user_id,symbol,mic_code) DO NOTHING RETURNING *`,
        [
          randomUUID(),
          user,
          hit.symbol,
          hit.name,
          hit.exchange,
          hit.mic,
          hit.timezone,
          hit.currency,
          a.dropPct ?? null,
        ],
      )
    ).rows[0];
    if (!row) {
      const existing = (
        await this.db.query(
          "SELECT id,status FROM watchlist_items WHERE user_id=$1 AND symbol=$2 AND mic_code=$3",
          [user, hit.symbol, hit.mic],
        )
      ).rows[0];
      if (existing)
        throw new ToolValidationError(
          `${hit.symbol} (${hit.exchange}) is already on the watchlist; use watchlist_update to change it`,
        );
      throw new ToolValidationError(
        "Maximum 25 watched stocks; remove one first",
      );
    }
    const notice =
      hit.access && !/basic|free/i.test(hit.access)
        ? `Provider marks this symbol as '${hit.access}' access; quotes may fail on the free plan.`
        : undefined;
    return {
      added: row,
      effectiveDropPct: a.dropPct ?? "account default",
      notice,
      basis:
        "Alert when (observed price / previous trading-session close - 1) falls below the threshold during the exchange's regular session; one alert per trading day.",
    };
  }
  private async remove(user: string, id: string) {
    const row = (
      await this.db.query(
        "DELETE FROM watchlist_items WHERE id=$1 AND user_id=$2 RETURNING symbol,exchange",
        [id, user],
      )
    ).rows[0];
    if (!row) throw new ToolValidationError("Watchlist item unavailable");
    return { removed: row };
  }
  private async update(
    user: string,
    a: Extract<WatchlistAction, { operation: "watchlist_update" }>,
  ) {
    const old = (
      await this.db.query(
        "SELECT * FROM watchlist_items WHERE id=$1 AND user_id=$2",
        [a.id, user],
      )
    ).rows[0];
    if (!old) throw new ToolValidationError("Watchlist item unavailable");
    const row = (
      await this.db.query(
        `UPDATE watchlist_items SET drop_pct=$3,status=$4,updated_at=now()
         WHERE id=$1 AND user_id=$2 RETURNING *`,
        [
          a.id,
          user,
          a.dropPct === undefined ? old.drop_pct : a.dropPct,
          a.status ?? old.status,
        ],
      )
    ).rows[0];
    if (row.status === "paused") await mutePending(this.db, user, a.id);
    return { updated: row };
  }
  private async settings(
    user: string,
    a: Extract<WatchlistAction, { operation: "watchlist_settings" }>,
  ) {
    if (a.includeExtended && !this.provider?.supportsExtended)
      throw new ToolValidationError(
        "Extended-hours quotes need a paid provider plan (prepost data); enable MARKET_DATA_EXTENDED after upgrading, or keep regular hours",
      );
    const row = (
      await this.db.query(
        `INSERT INTO stock_settings(user_id,default_drop_pct,paused,poll_minutes,include_extended)
         VALUES($1,COALESCE($2,5),COALESCE($3,false),COALESCE($4,15),COALESCE($5,false))
         ON CONFLICT(user_id) DO UPDATE SET
           default_drop_pct=COALESCE($2,stock_settings.default_drop_pct),
           paused=COALESCE($3,stock_settings.paused),
           poll_minutes=COALESCE($4,stock_settings.poll_minutes),
           include_extended=COALESCE($5,stock_settings.include_extended),
           updated_at=now()
         RETURNING *`,
        [
          user,
          a.defaultDropPct ?? null,
          a.paused ?? null,
          a.pollMinutes ?? null,
          a.includeExtended ?? null,
        ],
      )
    ).rows[0];
    if (row.paused) await mutePending(this.db, user);
    return { settings: row };
  }
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
function zoned(date: Date, tz: string) {
  let fmt = zoneFormats.get(tz);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      fmt = new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    }
    zoneFormats.set(tz, fmt);
  }
  const p = Object.fromEntries(
    fmt
      .formatToParts(date)
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}
function toMinutes(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}
/** True when `minutes` falls inside one session window. Sessions are local times;
 * a close earlier than open marks an overnight window. */
export function inSessions(
  minutes: number,
  sessions: { open: string; close: string; type: string }[],
  types: string[],
) {
  return sessions
    .filter((s) => types.includes(s.type))
    .some((s) => {
      const open = toMinutes(s.open);
      const close = toMinutes(s.close);
      return close > open
        ? minutes >= open && minutes < close
        : minutes >= open || minutes < close;
    });
}

const OBSERVATION_KEEP = 200;
const SUSPECT_MOVE_PCT = 40;

/** Deterministic poll: session gate, quote validation, threshold compare against the
 * previous trading-session close, one alert per item per exchange trading day. */
export class StockMonitor {
  private busy = false;
  constructor(
    private db: Database,
    private provider: MarketDataProvider,
    private allowed: (user: string) => boolean,
    private clock = () => new Date(),
  ) {}
  private async observe(
    item: { id: string; user_id: string },
    decision: string,
    fields: {
      quote?: Quote;
      marketState?: string;
      detail?: Record<string, unknown>;
    } = {},
  ) {
    const q = fields.quote;
    await this.db.query(
      `INSERT INTO stock_observations(user_id,item_id,quote_time,price,prev_close,change_pct,market_state,decision,detail)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        item.user_id,
        item.id,
        q?.quoteTime ?? null,
        q?.price ?? null,
        q?.prevClose ?? null,
        fields.detail?.changePct ?? null,
        fields.marketState ?? null,
        decision,
        JSON.stringify(fields.detail ?? {}),
      ],
    );
    await this.db.query(
      `DELETE FROM stock_observations WHERE item_id=$1 AND id NOT IN
       (SELECT id FROM stock_observations WHERE item_id=$1 ORDER BY observed_at DESC LIMIT ${OBSERVATION_KEEP})`,
      [item.id],
    );
  }
  private async backoff(
    item: any,
    pollMinutes: number,
    reason: string,
    now: Date,
    retryable = true,
  ) {
    // A permanent failure (bad plan, unknown symbol) pauses the item instead
    // of retrying on a schedule that would silently consume daily credits.
    if (!retryable) {
      await this.db.query(
        "UPDATE watchlist_items SET status='paused',error_count=0,next_retry_at=NULL,updated_at=now() WHERE id=$1 AND user_id=$2",
        [item.id, item.user_id],
      );
      await this.observe(item, "error", {
        detail: { reason, paused: "non-retryable provider error" },
      });
      return;
    }
    const errors = item.error_count + 1;
    const delay = Math.min(
      pollMinutes * Math.min(Math.pow(2, item.error_count), 16),
      240,
    );
    await this.db.query(
      "UPDATE watchlist_items SET error_count=$3,next_retry_at=$4,updated_at=now() WHERE id=$1 AND user_id=$2",
      [item.id, item.user_id, errors, new Date(now.getTime() + delay * 60000)],
    );
    await this.observe(item, "error", { detail: { reason } });
  }
  /** Per-minute allowance matching the provider's reset: Twelve Data
   * replenishes the full allowance at each minute boundary rather than
   * dripping credits, so a batch can never borrow from the next window
   * inside the same minute. */
  private bucket = { left: 0, minute: -1 };
  private creditsNow(now: Date) {
    const cap = this.provider.creditsPerMinute;
    const minute = Math.floor(now.getTime() / 60000);
    if (minute !== this.bucket.minute) this.bucket = { left: cap, minute };
    return this.bucket.left;
  }
  private evaluate(item: any, q: Quote) {
    if (!Number.isFinite(q.price) || q.price <= 0)
      return { decision: "invalid", reason: "missing or non-positive price" };
    if (!Number.isFinite(q.prevClose) || q.prevClose <= 0)
      return {
        decision: "invalid",
        reason: "missing or non-positive previous close",
      };
    if (q.currency && item.currency && q.currency !== item.currency)
      return {
        decision: "invalid",
        reason: `currency ${q.currency} != expected ${item.currency}`,
      };
    const changePct = (q.price / q.prevClose - 1) * 100;
    const suspect =
      Math.abs(changePct) >= SUSPECT_MOVE_PCT &&
      (q.providerChangePct == null ||
        Math.abs(changePct - q.providerChangePct) > 3);
    if (suspect)
      return {
        decision: "suspect",
        changePct,
        reason:
          "Move is too large to trust without provider corroboration; likely a split/adjustment artifact",
        providerChangePct: q.providerChangePct,
      };
    return { decision: null, changePct };
  }
  private alertText(item: any, q: Quote, price: number, changePct: number) {
    const zone = zoned(q.quoteTime, item.exchange_timezone);
    const threshold = item.drop_pct ?? item.eff_drop;
    return (
      `${item.name} (${item.symbol}, ${item.exchange}) is down ${Math.abs(changePct).toFixed(1)}% today.\n` +
      `Price ${price} ${q.currency || item.currency} vs previous close ${q.prevClose}.\n` +
      `Quote ${zone.date} ${zone.time} ${item.exchange_timezone}${q.delayed ? " (delayed ~15m)" : ""} · ${q.marketOpen ? "regular" : "extended"} session · ${this.provider.name}.\n` +
      `Basis: price vs previous trading-session close; threshold ${threshold}%.\n` +
      `https://finance.yahoo.com/quote/${encodeURIComponent(item.symbol)}`
    );
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.clock();
      const items = (
        await this.db.query(
          `SELECT i.*,COALESCE(s.default_drop_pct,5) AS eff_drop,
             COALESCE(s.paused,false) AS settings_paused,
             COALESCE(s.poll_minutes,15) AS eff_poll,
             COALESCE(s.include_extended,false) AS eff_extended
           FROM watchlist_items i LEFT JOIN stock_settings s ON s.user_id=i.user_id
           WHERE i.status='active' AND (i.next_retry_at IS NULL OR i.next_retry_at<=$1)
           ORDER BY i.last_polled_at ASC NULLS FIRST`,
          [now],
        )
      ).rows.filter(
        (i) =>
          this.allowed(i.user_id) &&
          !i.settings_paused &&
          (!i.last_polled_at ||
            now.getTime() - new Date(i.last_polled_at).getTime() >=
              i.eff_poll * 60000),
      );
      const groups = new Map<string, any[]>();
      for (const item of items) {
        const key = item.mic_code;
        groups.set(key, [...(groups.get(key) ?? []), item]);
      }
      for (const [mic, group] of groups) {
        const tz = marketCalendar(mic)?.timezone;
        if (!tz) {
          for (const item of group) {
            // Advance the poll cursor too, or an uncovered exchange would
            // churn an error observation every tick.
            await this.db.query(
              "UPDATE watchlist_items SET last_polled_at=$2,updated_at=now() WHERE id=$1",
              [item.id, now],
            );
            await this.observe(item, "error", {
              detail: { reason: `no built-in calendar for exchange ${mic}` },
            });
          }
          continue;
        }
        const date = zoned(now, tz).date;
        const sessions = sessionsFor(mic, date).sessions;
        // Session gating is per item: owners may differ in extended-hours opt-in.
        const local = zoned(now, tz).minutes;
        const openItems = [] as any[];
        for (const item of group) {
          const extendedOk =
            item.eff_extended && this.provider.supportsExtended;
          if (
            inSessions(
              local,
              sessions,
              extendedOk ? ["regular", "pre", "post"] : ["regular"],
            )
          ) {
            openItems.push(item);
            continue;
          }
          const last = (
            await this.db.query(
              "SELECT decision FROM stock_observations WHERE item_id=$1 ORDER BY observed_at DESC LIMIT 1",
              [item.id],
            )
          ).rows[0];
          if (last?.decision !== "market_closed")
            await this.observe(item, "market_closed", {
              marketState: "closed",
            });
          // Count the closed check as a poll so off-hours items are not
          // re-evaluated every tick.
          await this.db.query(
            "UPDATE watchlist_items SET last_polled_at=$2,updated_at=now() WHERE id=$1",
            [item.id, now],
          );
        }
        // Fetch in credit-sized chunks (one credit per symbol) so a due batch
        // can never exceed the plan's per-minute allowance; leftovers stay due
        // for the next tick.
        const pending = [...openItems];
        while (pending.length) {
          const budget = Math.floor(this.creditsNow(now));
          if (budget <= 0) break;
          const chunk = pending.splice(0, Math.min(8, budget));
          let quotes: Map<string, Quote>;
          const wantExtended = chunk.some(
            (i) => i.eff_extended && this.provider.supportsExtended,
          );
          // Reserve the credits before dispatch: a timed-out request may
          // still have been processed — and billed — provider-side.
          this.bucket.left -= chunk.length;
          try {
            quotes = await this.provider.quotes(
              chunk.map((i) => ({ symbol: i.symbol, mic: i.mic_code })),
              { extended: wantExtended },
            );
          } catch (error) {
            const retryable =
              !(error instanceof ProviderError) || error.retryable;
            for (const item of chunk)
              await this.backoff(
                item,
                item.eff_poll,
                `quotes: ${error instanceof Error ? error.message : "provider error"}`,
                now,
                retryable,
              );
            continue;
          }
          for (const item of chunk) {
            const q = quotes.get(
              quoteKey({ symbol: item.symbol, mic: item.mic_code }),
            );
            try {
              // Every quote we fetched counts as the item's poll, whatever the
              // verdict; otherwise rejected quotes would re-hit the provider
              // every tick.
              await this.db.query(
                "UPDATE watchlist_items SET last_polled_at=$2,error_count=0,next_retry_at=NULL,updated_at=now() WHERE id=$1 AND user_id=$3",
                [item.id, now, item.user_id],
              );
              const freshnessMs = Math.max(2 * item.eff_poll, 20) * 60000;
              if (!q) {
                await this.observe(item, "invalid", {
                  detail: { reason: "provider returned no quote" },
                });
                continue;
              }
              // Pick the session's own price and timestamp BEFORE checking
              // freshness: outside regular hours the regular `quoteTime` goes
              // quiet at the close, so it would discard fresh extended
              // prices. Substituting the regular price is never allowed — a
              // missing or stale extended quote skips the item instead.
              const wantExtendedQuote =
                !q.marketOpen &&
                item.eff_extended &&
                this.provider.supportsExtended;
              const basisTime = wantExtendedQuote
                ? (q.extended?.time ?? null)
                : q.quoteTime;
              const basisLabel = wantExtendedQuote
                ? "extended"
                : q.marketOpen
                  ? "regular"
                  : "closed";
              if (basisTime == null) {
                await this.observe(item, "stale", {
                  quote: q,
                  marketState: basisLabel,
                  detail: { reason: "extended quote missing" },
                });
                continue;
              }
              const age = now.getTime() - basisTime.getTime();
              if (age > freshnessMs || age < -5 * 60000) {
                await this.observe(item, "stale", {
                  quote: q,
                  marketState: basisLabel,
                  detail: {
                    ageMinutes: Math.round(age / 60000),
                    ...(wantExtendedQuote
                      ? { reason: "extended quote stale" }
                      : {}),
                  },
                });
                continue;
              }
              const useExtended = wantExtendedQuote;
              const price = useExtended ? q.extended!.price : q.price;
              const providerPct = useExtended
                ? q.extended!.changePct
                : q.providerChangePct;
              // Everything downstream — dedupe, observations and the alert
              // text — sees the selected session's timestamp, not the
              // regular quote's, so a pre/post-market alert lands on the
              // trading date its price actually belongs to.
              const basis = { ...q, price, quoteTime: basisTime };
              const verdict = this.evaluate(item, {
                ...q,
                price,
                providerChangePct: providerPct,
              });
              if (verdict.decision) {
                await this.observe(item, verdict.decision, {
                  quote: basis,
                  marketState: basisLabel,
                  detail: verdict,
                });
                continue;
              }
              const changePct = verdict.changePct!;
              const tradingDate = useExtended
                ? zoned(basisTime!, item.exchange_timezone).date
                : q.tradingDate ||
                  zoned(q.quoteTime, item.exchange_timezone).date;
              const existing = (
                await this.db.query(
                  "SELECT state FROM stock_alerts WHERE item_id=$1 AND trading_date=$2",
                  [item.id, tradingDate],
                )
              ).rows[0];
              // "Drops more than the threshold": compare price against the trigger
              // level directly so boundary math is exact.
              if (
                price <
                q.prevClose * (1 - (item.drop_pct ?? item.eff_drop) / 100)
              ) {
                // The owner may have paused the item or the whole feature while
                // the quote request was in flight — recheck before enqueueing.
                const still = (
                  await this.db.query(
                    `SELECT i.status,COALESCE(s.paused,false) AS paused
                   FROM watchlist_items i LEFT JOIN stock_settings s ON s.user_id=i.user_id
                   WHERE i.id=$1`,
                    [item.id],
                  )
                ).rows[0];
                // watchlist_remove may have deleted the item mid-poll; its
                // observation row would violate the FK, so skip silently.
                if (!still) continue;
                if (still.status !== "active" || still.paused) {
                  await this.observe(item, "suppressed_today", {
                    quote: basis,
                    marketState: basisLabel,
                    detail: { changePct, reason: "paused during poll" },
                  });
                } else if (existing) {
                  await this.observe(item, "suppressed_today", {
                    quote: basis,
                    marketState: basisLabel,
                    detail: { changePct, alertState: existing.state },
                  });
                } else {
                  const alertId = randomUUID();
                  const payload = {
                    alertId,
                    itemId: item.id,
                    symbol: item.symbol,
                    reply: this.alertText(item, basis, price, changePct),
                  };
                  await this.db.query(
                    `INSERT INTO stock_alerts(id,user_id,item_id,trading_date,payload)
                   VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(item_id,trading_date) DO NOTHING`,
                    [
                      alertId,
                      item.user_id,
                      item.id,
                      tradingDate,
                      JSON.stringify(payload),
                    ],
                  );
                  await this.observe(item, "alerted", {
                    quote: basis,
                    marketState: basisLabel,
                    detail: {
                      changePct,
                      alertId,
                      tradingDate,
                      threshold: item.drop_pct ?? item.eff_drop,
                    },
                  });
                }
              } else {
                await this.observe(item, "below_threshold", {
                  quote: basis,
                  marketState: basisLabel,
                  detail: { changePct },
                });
              }
            } catch (error) {
              await this.backoff(
                item,
                item.eff_poll,
                error instanceof Error ? error.message : "poll failed",
                now,
                !(error instanceof ProviderError) || error.retryable,
              );
            }
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

/** Persisted alert outbox, mirroring RoutineDelivery: pending → sending → sent,
 * with 'uncertain' on interruption. Never retried automatically. */
export class StockDelivery {
  private busy = false;
  constructor(
    private db: Database,
    private send: (user: string, payload: any) => Promise<unknown>,
  ) {}
  async recover() {
    await this.db.query(
      "UPDATE stock_alerts SET state='uncertain' WHERE state='sending'",
    );
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      // Pauses can land after an alert was queued: mute those rows, then only
      // claim an alert whose monitoring is still enabled.
      await this.db.query(
        `UPDATE stock_alerts SET state='muted' FROM watchlist_items i
         WHERE stock_alerts.item_id=i.id AND stock_alerts.state='pending'
           AND (i.status<>'active' OR EXISTS(
             SELECT 1 FROM stock_settings s
             WHERE s.user_id=stock_alerts.user_id AND s.paused))`,
      );
      const d = (
        await this.db.query(`UPDATE stock_alerts SET state='sending' WHERE id=(
          SELECT a.id FROM stock_alerts a
            JOIN watchlist_items i ON i.id=a.item_id AND i.status='active'
            LEFT JOIN stock_settings s ON s.user_id=a.user_id
          WHERE a.state='pending' AND COALESCE(s.paused,false)=false
          ORDER BY a.created_at FOR UPDATE OF a SKIP LOCKED LIMIT 1) RETURNING *`)
      ).rows[0];
      if (!d) return;
      try {
        await this.send(d.user_id, d.payload);
        await this.db.query(
          "UPDATE stock_alerts SET state='sent',sent_at=now() WHERE id=$1",
          [d.id],
        );
      } catch {
        await this.db.query(
          "UPDATE stock_alerts SET state='uncertain' WHERE id=$1",
          [d.id],
        );
      }
    } finally {
      this.busy = false;
    }
  }
}
