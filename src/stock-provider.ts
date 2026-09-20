/** Market data boundary for the stock watchlist monitor. No model involvement:
 * providers return validated quotes the monitor compares deterministically. */

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface SymbolHit {
  symbol: string;
  name: string;
  exchange: string;
  mic: string;
  timezone: string;
  currency: string;
  type: string;
  /** Provider plan/access note when reported (e.g. a paid-only symbol). */
  access?: string;
}

export interface SymbolRef {
  symbol: string;
  mic: string;
}

export interface Quote {
  price: number;
  prevClose: number;
  /** Provider-computed daily change percent when supplied; used to cross-check. */
  providerChangePct: number | null;
  currency: string;
  /** Provider's quote timestamp. */
  quoteTime: Date;
  /** Trading day in the exchange timezone (YYYY-MM-DD). */
  tradingDate: string;
  marketOpen: boolean;
  /** Pre/post-market quote when the provider supplies one and the owner opted in. */
  extended: { price: number; changePct: number | null } | null;
  /** True when the plan's quotes are known delayed (e.g. ~15m). */
  delayed: boolean;
}

export interface ExchangeSessions {
  timezone: string;
  /** Local-time windows; type is 'pre'|'regular'|'post' when the provider supplies it. */
  sessions: { open: string; close: string; type: string }[];
}

export interface MarketDataProvider {
  readonly name: string;
  search(query: string): Promise<SymbolHit[]>;
  quotes(refs: SymbolRef[]): Promise<Map<string, Quote>>;
  /** Sessions for a market date (YYYY-MM-DD in the exchange zone); empty list = holiday/closed. */
  schedule(mic: string, date: string): Promise<ExchangeSessions>;
}

export const quoteKey = (ref: SymbolRef) => `${ref.mic}:${ref.symbol}`;

/** Twelve Data REST adapter (free Basic plan: 8 credits/min, 800 credits/day).
 * Covers US markets on the free tier; other exchanges may report plan errors. */
export class TwelveDataProvider implements MarketDataProvider {
  readonly name = "twelvedata";
  constructor(
    private key: string,
    private base = "https://api.twelvedata.com",
  ) {}
  private async get(path: string, params: Record<string, string>) {
    const url = new URL(this.base + path);
    url.search = new URLSearchParams({
      ...params,
      apikey: this.key,
    }).toString();
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    } catch (error) {
      throw new ProviderError(
        error instanceof Error ? error.message : "request failed",
        true,
      );
    }
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status >= 500)
      throw new ProviderError(`Twelve Data HTTP ${res.status}`, true);
    if (body?.status === "error")
      throw new ProviderError(
        String(body.message ?? "provider error"),
        res.status >= 500,
      );
    if (!res.ok)
      throw new ProviderError(`Twelve Data HTTP ${res.status}`, false);
    return body;
  }
  async search(query: string): Promise<SymbolHit[]> {
    const body = await this.get("/symbol_search", {
      symbol: query,
      outputsize: "8",
      show_plan: "true",
    });
    const rows = Array.isArray(body?.data) ? body.data : [];
    return rows
      .filter((r: any) => /stock|etf/i.test(String(r.instrument_type ?? "")))
      .map((r: any) => ({
        symbol: String(r.symbol),
        name: String(r.instrument_name ?? ""),
        exchange: String(r.exchange ?? ""),
        mic: String(r.mic_code ?? ""),
        timezone: String(r.exchange_timezone ?? ""),
        currency: String(r.currency ?? ""),
        type: String(r.instrument_type ?? ""),
        access: r.access?.global != null ? String(r.access.global) : undefined,
      }));
  }
  async quotes(refs: SymbolRef[]): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    if (!refs.length) return out;
    const mic = refs[0]!.mic;
    if (!refs.every((r) => r.mic === mic))
      throw new ProviderError("quotes require one exchange per request", false);
    const body = await this.get("/quote", {
      symbol: refs.map((r) => r.symbol).join(","),
      mic_code: mic,
    });
    const rows: any[] = body?.symbol
      ? [body]
      : refs.map((r) => body?.[r.symbol]).filter(Boolean);
    for (const row of rows) {
      const ref = refs.find((r) => r.symbol === row.symbol);
      if (!ref) continue;
      const extended =
        row.extended_price != null
          ? {
              price: Number(row.extended_price),
              changePct:
                row.extended_percent_change != null
                  ? Number(row.extended_percent_change)
                  : null,
            }
          : null;
      out.set(quoteKey(ref), {
        price: Number(row.close ?? row.price),
        prevClose: Number(row.previous_close),
        providerChangePct:
          row.percent_change != null ? Number(row.percent_change) : null,
        currency: String(row.currency ?? ""),
        quoteTime: row.timestamp
          ? new Date(Number(row.timestamp) * 1000)
          : new Date(`${row.datetime}T00:00:00Z`),
        tradingDate: String(row.datetime ?? "").slice(0, 10),
        marketOpen: row.is_market_open === true,
        extended,
        delayed: true,
      });
    }
    return out;
  }
  async schedule(mic: string, date: string): Promise<ExchangeSessions> {
    const body = await this.get("/exchange_schedule", {
      mic_code: mic,
      date,
    });
    const rows = Array.isArray(body?.data) ? body.data : [];
    const sessions = rows.flatMap((r: any) =>
      (Array.isArray(r.sessions) ? r.sessions : []).map((s: any) => ({
        open: String(s.open_time ?? "").slice(0, 5),
        close: String(s.close_time ?? "").slice(0, 5),
        type: String(s.session_type ?? s.session_name ?? "regular")
          .toLowerCase()
          .replace(/[^a-z].*$/, ""),
      })),
    );
    return {
      timezone: String(rows[0]?.time_zone ?? ""),
      sessions: sessions.filter((s: { open: string }) =>
        /^\d\d:\d\d$/.test(s.open),
      ),
    };
  }
}
