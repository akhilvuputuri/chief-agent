import { opsLog } from "../ops-log.js";
import { ToolValidationError } from "../tool-errors.js";
import { IBKR, IbkrAuth, IbkrAuthError } from "./oauth.js";
import {
  IBKR_QUERY_TOOLS,
  IbkrMcp,
  IbkrMcpError,
  type IbkrCall,
} from "./mcp.js";

/**
 * IBKR order drafts ("AI instructions", docs/ibkr-portfolio.md#order-drafts). Chief creates
 * an instruction that the owner reviews and submits in an IBKR app; it never places,
 * changes or cancels an order. Owner rules (20 October 2026): review-and-approve sessions
 * only, US-listed shares only, whole units, and each draft worth at most `maxUsd` at its
 * limit price (or the current ask for a market draft).
 */

export interface DraftRequest {
  symbol: string;
  exchange?: string;
  side: "BUY" | "SELL";
  quantity: number;
  orderType: "LIMIT" | "MARKET";
  limitPrice?: number;
  timeInForce?: "DAY" | "GTC" | "OVT" | "OND" | "OPG";
}

/** Bound on a query result handed to the model. */
const MAX_RESULT_CHARS = 30000;
/** How far back a lost create's instruction may have been stamped (clock skew). */
const MATCH_SKEW_MS = 2 * 60 * 1000;
/** An identical draft is not sent again within this window (review, 20 October 2026). */
const REPEAT_MS = 10 * 60 * 1000;
const LIVE = ["connected", "refresh_uncertain"];

const round2 = (value: number) => Math.round(value * 100) / 100;

interface Listing {
  symbol: string;
  contractId: number;
  exchange: string;
  country: string;
  description: string;
}

/** Stock listings of exactly this symbol from search_contracts. */
function stockListings(raw: unknown, symbol: string): Listing[] {
  const rows = (raw as { results?: unknown[] } | null)?.results;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r: any) =>
    r?.symbol === symbol &&
    Number.isSafeInteger(r?.underlying_contract_id) &&
    Array.isArray(r?.sections) &&
    r.sections.some((s: any) => s?.security_type === "STK")
      ? [
          {
            symbol,
            contractId: r.underlying_contract_id,
            exchange: String(r.exchange ?? "").slice(0, 20),
            country: String(r.country_code ?? "").slice(0, 4),
            description: String(r.description ?? "").slice(0, 80),
          },
        ]
      : [],
  );
}

function instructions(raw: unknown) {
  const rows = (raw as { instructions?: unknown[] } | null)?.instructions;
  if (!Array.isArray(rows)) return null;
  return rows.map((i: any) => ({
    id: String(i?.id ?? ""),
    symbol: typeof i?.symbol === "string" ? i.symbol : null,
    contractId:
      typeof i?.contract_id_ex === "string"
        ? i.contract_id_ex
        : Number.isSafeInteger(i?.contract_id)
          ? String(i.contract_id)
          : null,
    side: typeof i?.side === "string" ? i.side : null,
    quantity: Number.isFinite(i?.quantity) ? i.quantity : null,
    orderType: typeof i?.order_type === "string" ? i.order_type : null,
    limitPrice: Number.isFinite(i?.limit_price) ? i.limit_price : null,
    timeInForce: typeof i?.tif === "string" ? i.tif : null,
    createdAt: typeof i?.creation_time === "string" ? i.creation_time : null,
    expiresAt: typeof i?.expiration === "string" ? i.expiration : null,
    awaitingReview: i?.is_new === true,
  }));
}

/** IBKR's deep link to the instruction, kept only if it points at IBKR. */
function ibkrLink(value: unknown) {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      /(^|\.)(interactivebrokers\.com|ibkr\.com)$/.test(url.hostname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export class OrderDrafts {
  /**
   * Identical drafts sent recently, by owner and terms, with IBKR's id once known. IBKR's
   * list can lag a create (measured once), so this in-process record covers the gap; the
   * list check covers a restart.
   */
  private sent = new Map<string, { at: number; id?: string }>();
  constructor(
    private auth: IbkrAuth,
    private mcp: IbkrMcp,
    readonly maxUsd: number,
    private now: () => number = Date.now,
  ) {}

  /** Connection problems become results the agent can report; other errors propagate. */
  private async guard<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof IbkrAuthError)
        return {
          status: "not_connected",
          code: error.code,
          note: "IBKR is not connected or its access ended. The owner can ask Chief to connect it.",
        };
      if (error instanceof IbkrMcpError)
        return {
          status: error.code === "tool_error" ? "ibkr_error" : "unavailable",
          code: error.code,
          ...(error.detail ? { detail: error.detail } : {}),
          note:
            error.code === "tool_error"
              ? "IBKR returned an error for this request."
              : "IBKR could not be reached or answered unreadably; try again shortly.",
        };
      throw error;
    }
  }

  /** One allowlisted read-only IBKR tool, by name, with its own arguments. */
  query(user: string, tool: string, args: Record<string, unknown> = {}) {
    if (!(IBKR_QUERY_TOOLS as readonly string[]).includes(tool))
      throw new ToolValidationError(`${tool} is not an allowed IBKR read tool`);
    return this.guard(async () => {
      const result = await this.mcp.run(user, (call) => call(tool, args));
      const text = JSON.stringify(result ?? null);
      return text.length <= MAX_RESULT_CHARS
        ? { tool, result }
        : {
            tool,
            truncated: true,
            text: text.slice(0, MAX_RESULT_CHARS),
            note: "The result was cut short; narrow the request if the answer needs the rest.",
          };
    });
  }

  /** The account's saved instructions, newest first as IBKR returns them. */
  list(user: string) {
    return this.guard(async () => {
      const rows = instructions(
        await this.mcp.run(user, (call) => call("get_order_instructions")),
      );
      if (!rows)
        return {
          status: "unavailable",
          note: "IBKR returned instructions in an unexpected shape.",
        };
      return {
        drafts: rows,
        note: "Drafts are not orders: each waits for the owner's Review & Submit or Reject in an IBKR app, and IBKR expires it at expiresAt.",
      };
    });
  }

  async remove(user: string, id: string) {
    const blocked = await this.writable(user);
    if (blocked) return blocked;
    return this.guard(async () => {
      // The delete is confirmed by listing afterwards; a failed list leaves it unconfirmed.
      const remaining = await this.mcp.run(user, async (call) => {
        await call("delete_order_instruction", { id });
        try {
          return instructions(await call("get_order_instructions"));
        } catch {
          return null;
        }
      });
      const confirmed = remaining?.every((i) => i.id !== id) ?? false;
      // The deleted draft's terms may be requested again; every other record stays.
      if (confirmed)
        for (const [key, entry] of this.sent)
          if (key.startsWith(`${user}|`) && entry.id === id)
            this.sent.delete(key);
      opsLog("portfolio.draft_deleted", confirmed ? "info" : "warn", {
        state: confirmed ? "deleted" : "unconfirmed",
      });
      return {
        status: confirmed ? "deleted" : "delete_unconfirmed",
        id,
        note: confirmed
          ? "The draft was deleted in IBKR. A draft the owner already submitted is an order and is not affected."
          : "IBKR accepted the delete, but the draft list could not confirm it. List drafts to check.",
      };
    });
  }

  private async writable(user: string) {
    const status = await this.auth.status(user);
    if (!LIVE.includes(status.state))
      return {
        status: "not_connected",
        note: "IBKR is not connected. The owner can ask Chief to connect it.",
      };
    if (!("scopes" in status) || !status.scopes?.includes(IBKR.draftScope))
      return {
        status: "reconnect_needed",
        note: "IBKR is connected with read-only access, which cannot create or delete drafts. The owner can ask Chief to disconnect IBKR and then connect it again to approve order drafts.",
      };
    return null;
  }

  async draft(user: string, r: DraftRequest) {
    if (
      r.orderType === "LIMIT"
        ? !(Number(r.limitPrice) > 0)
        : r.limitPrice != null
    )
      throw new ToolValidationError(
        "A LIMIT draft needs limitPrice; a MARKET draft takes none",
      );
    const blocked = await this.writable(user);
    if (blocked) return blocked;
    const symbol = r.symbol.trim().toUpperCase();
    const exchange = r.exchange?.trim().toUpperCase();
    const started = this.now();
    const result = await this.guard(() =>
      this.mcp.run(user, (call) =>
        this.create(call, user, r, symbol, exchange, started),
      ),
    );
    opsLog("portfolio.draft", result.status === "drafted" ? "info" : "warn", {
      state: result.status,
      errorCode:
        "reason" in result && typeof result.reason === "string"
          ? result.reason
          : undefined,
    });
    return result;
  }

  private async create(
    call: IbkrCall,
    user: string,
    r: DraftRequest,
    symbol: string,
    exchange: string | undefined,
    started: number,
  ): Promise<{ status: string; reason?: string; [k: string]: unknown }> {
    const refused = (reason: string, note: string, extra = {}) => ({
      status: "refused",
      reason,
      note: `${note} Nothing was sent to IBKR.`,
      ...extra,
    });
    // Live-order sessions are never used, whatever IBKR enables for this consent.
    const flow = (await call("get_flow_type")) as { flow_type?: unknown };
    if (flow?.flow_type !== "REVIEW_AND_APPROVE")
      return refused(
        "flow_not_review",
        "IBKR reports this connection is not in review-and-approve mode, so Chief will not create drafts.",
      );
    const listings = stockListings(
      await call("search_contracts", { query: symbol }),
      symbol,
    ).filter((l) => !exchange || l.exchange === exchange);
    const us = listings.filter((l) => l.country === "US");
    if (!us.length)
      return listings.length
        ? refused(
            "not_us_listed",
            `${symbol} has no US stock listing${exchange ? ` on ${exchange}` : ""}; drafts are limited to US-listed shares.`,
            { listings: listings.slice(0, 5) },
          )
        : refused(
            "not_found",
            `No stock listing with the exact symbol ${symbol}${exchange ? ` on ${exchange}` : ""} was found.`,
          );
    if (us.length > 1)
      return {
        status: "needs_exchange",
        listings: us.slice(0, 5),
        note: "Several US listings match. Ask the owner which exchange, then draft again with exchange. Nothing was sent to IBKR.",
      };
    const listing = us[0]!;
    // A buy limit fills at the limit or lower, so the limit bounds its value. A sell limit
    // is a floor that fills at the market when below it, and a market order fills at the
    // market: those are valued at the current price (a sell at the higher of the limit and
    // the market).
    let unit = r.side === "BUY" ? r.limitPrice : undefined;
    if (!unit) {
      const quote = (await call("get_price_snapshot", {
        contract_id: listing.contractId,
        market_data_names: ["last", "bid_ask"],
      })) as any;
      const price = (value: unknown) =>
        Number(value) > 0 ? Number(value) : undefined;
      const last = price(quote?.last?.price);
      const market =
        r.side === "BUY"
          ? (price(quote?.["bid-ask"]?.ask) ?? last)
          : (price(quote?.["bid-ask"]?.bid) ?? last);
      unit = market && Math.max(market, r.limitPrice ?? 0);
    }
    if (!(Number(unit) > 0))
      return refused(
        "no_price",
        "IBKR returned no current price to check the cap.",
      );
    const estimatedValueUsd = round2(r.quantity * unit!);
    if (estimatedValueUsd > this.maxUsd)
      return refused(
        "over_cap",
        `This draft is worth about USD ${estimatedValueUsd}, above the USD ${this.maxUsd} per-draft cap.`,
        { estimatedValueUsd, capUsd: this.maxUsd },
      );
    const draft = {
      symbol,
      exchange: listing.exchange,
      description: listing.description,
      side: r.side,
      quantity: r.quantity,
      orderType: r.orderType,
      limitPrice: r.orderType === "LIMIT" ? r.limitPrice : null,
      timeInForce: r.timeInForce ?? "IBKR default",
    };
    const match = {
      ...draft,
      contractId: String(listing.contractId),
      timeInForce: r.timeInForce ?? null,
    };
    const terms = [
      user,
      listing.contractId,
      r.side,
      r.quantity,
      r.orderType,
      r.limitPrice ?? "",
      r.timeInForce ?? "",
    ].join("|");
    for (const [key, entry] of this.sent)
      if (this.now() - entry.at > REPEAT_MS) this.sent.delete(key);
    const already = (id?: string) => ({
      status: "already_drafted",
      reason: "recent_duplicate",
      ...(id ? { id } : {}),
      draft,
      note: "An identical draft was sent to IBKR in the last 10 minutes, so Chief did not send it again. List drafts to see it; to have two, the owner can change the terms or wait.",
    });
    if (this.sent.has(terms)) return already();
    // Recorded before anything is awaited, so a concurrent identical request stops above,
    // and kept whatever the outcome: the same terms are never sent twice.
    this.sent.set(terms, { at: this.now() });
    // Without a readable list a duplicate cannot be ruled out (for example after a
    // restart), so nothing is sent: the check fails closed.
    let rows: Awaited<ReturnType<OrderDrafts["lookup"]>>;
    try {
      rows = await this.lookup(call, true);
    } catch (error) {
      // An expired token: nothing was created yet, so the session is retried once.
      this.sent.delete(terms);
      throw error;
    }
    if (!rows) {
      this.sent.delete(terms);
      return refused(
        "duplicate_check_unavailable",
        "IBKR's draft list could not be read to rule out a duplicate; try again shortly.",
      );
    }
    const listed = matching(rows, match, started - REPEAT_MS);
    if (listed) return already(listed.id);
    let created: any;
    try {
      created = await call("create_order_instruction", {
        contract_id_ex: String(listing.contractId),
        side: r.side,
        quantity: r.quantity,
        order_type: r.orderType,
        ...(r.orderType === "LIMIT" ? { limit_price: r.limitPrice } : {}),
        ...(r.timeInForce ? { time_in_force: r.timeInForce } : {}),
      });
    } catch (error) {
      // No token means nothing was sent. A 401 is assumed to mean IBKR processed nothing
      // (standard for a resource server; unmeasured for IBKR), so the session is retried
      // once: the record above is released, and the retry's list check still finds a
      // draft IBKR saved anyway.
      if (
        error instanceof IbkrAuthError ||
        (error instanceof IbkrMcpError &&
          ["http_401", "token_unavailable"].includes(error.code))
      ) {
        this.sent.delete(terms);
        throw error;
      }
      // An error result or a lost reply: IBKR may still have saved it. Look, never resend.
      const found = matching((await this.lookup(call)) ?? [], match, started);
      if (
        !found &&
        error instanceof IbkrMcpError &&
        error.code === "tool_error"
      )
        return {
          status: "refused_by_ibkr",
          reason: "ibkr_error",
          ...(error.detail ? { detail: error.detail } : {}),
          note: "IBKR reported an error and no matching draft is listed. Chief will not send the same draft again for 10 minutes; list drafts before trying again.",
        };
      return found
        ? {
            status: "drafted",
            id: found.id,
            link: null,
            draft,
            estimatedValueUsd,
            expiresAt: found.expiresAt,
            note: "IBKR's reply was lost, but the draft is in the account. It waits for the owner's Review & Submit in an IBKR app (AI Instructions). Chief cannot submit it.",
          }
        : {
            status: "unknown",
            reason: "outcome_unknown",
            draft,
            note: "IBKR's reply was lost and the draft could not be confirmed. Do not draft it again: ask the owner to check AI Instructions in an IBKR app, or list drafts shortly.",
          };
    }
    const returned =
      (typeof created?.id === "string" &&
        /^[A-Za-z0-9_-]{1,64}$/.test(created.id)) ||
      Number.isSafeInteger(created?.id)
        ? String(created.id)
        : null;
    // Expiry comes from the list; failing to read it never repeats the create. A reply
    // without a usable id is confirmed from the list, or reported unknown (review, Devin).
    const after = await this.lookup(call);
    const saved = returned
      ? after?.find((i) => i.id === returned)
      : matching(after ?? [], match, started);
    const id = returned ?? saved?.id ?? null;
    if (!id)
      return {
        status: "unknown",
        reason: "no_draft_id",
        draft,
        note: "IBKR answered without a draft id and no matching draft is listed. Do not draft it again: ask the owner to check AI Instructions in an IBKR app, or list drafts shortly.",
      };
    this.sent.set(terms, { at: this.now(), id });
    return {
      status: "drafted",
      id,
      link: ibkrLink(created?.url),
      draft,
      estimatedValueUsd,
      capUsd: this.maxUsd,
      expiresAt: saved?.expiresAt ?? null,
      note: "This is a draft, not an order. Nothing trades until the owner opens it in an IBKR app (AI Instructions) and taps Review & Submit; Reject discards it. Chief cannot submit it.",
    };
  }

  /**
   * The account's saved instructions, or null when they cannot be read. Never throws,
   * except that `beforeCreate` passes on a missing or rejected token, which `run` retries.
   */
  private async lookup(call: IbkrCall, beforeCreate = false) {
    try {
      return instructions(await call("get_order_instructions"));
    } catch (error) {
      if (
        beforeCreate &&
        (error instanceof IbkrAuthError ||
          (error instanceof IbkrMcpError &&
            ["http_401", "token_unavailable"].includes(error.code)))
      )
        throw error;
      return null;
    }
  }
}

/** The numeric contract id in IBKR's forms ("265598", "265598@NASDAQ"), if any. */
const contractNumber = (value: string | null) =>
  /^(\d+)/.exec(value ?? "")?.[1] ?? null;

/**
 * The newest saved instruction with these terms created since `since`. The listing is
 * compared by numeric contract id when both sides have one, otherwise by symbol (the
 * list's contract field is unmeasured, so an unknown form errs toward a match), and the
 * time in force when both sides state it.
 */
function matching(
  rows: NonNullable<ReturnType<typeof instructions>>,
  d: {
    symbol: string;
    contractId: string;
    side: string;
    quantity: number;
    orderType: string;
    limitPrice: number | null | undefined;
    timeInForce: string | null;
  },
  since: number,
) {
  return (
    rows.find(
      (i) =>
        (contractNumber(i.contractId) && contractNumber(d.contractId)
          ? contractNumber(i.contractId) === contractNumber(d.contractId)
          : i.symbol === d.symbol) &&
        i.side === d.side &&
        i.quantity === d.quantity &&
        i.orderType === d.orderType &&
        (d.limitPrice == null || i.limitPrice === d.limitPrice) &&
        (d.timeInForce == null ||
          i.timeInForce == null ||
          i.timeInForce === d.timeInForce) &&
        i.createdAt != null &&
        Date.parse(i.createdAt) >= since - MATCH_SKEW_MS,
    ) ?? null
  );
}
