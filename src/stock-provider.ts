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
  /** When the quote was last updated — the freshness signal, NOT the interval-open `timestamp`. */
  quoteTime: Date;
  /** Trading day in the exchange timezone (YYYY-MM-DD). */
  tradingDate: string;
  marketOpen: boolean;
  /** Pre/post-market quote when the provider supplies one and the owner opted in. */
  extended: {
    price: number;
    changePct: number | null;
    time: Date | null;
  } | null;
  /** True when the plan's quotes are known delayed (e.g. ~15m). */
  delayed: boolean;
}

export interface MarketDataProvider {
  readonly name: string;
  /** API credits consumed per symbol per quote request; paces batches. */
  readonly creditsPerMinute: number;
  /** Whether the plan can serve pre/post-market quotes (prepost flag). */
  readonly supportsExtended: boolean;
  search(query: string): Promise<SymbolHit[]>;
  quotes(
    refs: SymbolRef[],
    opts?: { extended?: boolean },
  ): Promise<Map<string, Quote>>;
}

export const quoteKey = (ref: SymbolRef) => `${ref.mic}:${ref.symbol}`;

/** Map one Twelve Data quote row onto Quote. Freshness uses `last_quote_at`
 * (the last 1-minute candle's time): `timestamp`/`datetime` describe the open of
 * the requested interval — under the default 1day interval that is the day-open
 * time, which would mark every fresh intraday quote as stale. */
export function rowToQuote(row: any): Quote {
  const quoteSeconds =
    row.last_quote_at ??
    row.timestamp ??
    (row.datetime ? Date.parse(`${row.datetime}`) / 1000 : undefined);
  const extendedSeconds = row.extended_timestamp ?? null;
  const extendedTime = extendedSeconds
    ? new Date(Number(extendedSeconds) * 1000)
    : null;
  const quoteTime = quoteSeconds
    ? new Date(Number(quoteSeconds) * 1000)
    : new Date(0);
  // Non-numeric provider times must fail closed: an Invalid Date makes every
  // age comparison false, bypassing staleness — collapse to the epoch instead.
  if (Number.isNaN(quoteTime.getTime())) quoteTime.setTime(0);
  const extended =
    row.extended_price != null
      ? {
          price: Number(row.extended_price),
          changePct:
            row.extended_percent_change != null
              ? Number(row.extended_percent_change)
              : null,
          time:
            extendedTime && !Number.isNaN(extendedTime.getTime())
              ? extendedTime
              : null,
        }
      : null;
  return {
    price: Number(row.close ?? row.price),
    prevClose: Number(row.previous_close),
    providerChangePct:
      row.percent_change != null ? Number(row.percent_change) : null,
    currency: String(row.currency ?? ""),
    quoteTime,
    tradingDate: String(row.datetime ?? "").slice(0, 10),
    marketOpen: row.is_market_open === true,
    extended,
    delayed: true,
  };
}

/** Twelve Data REST adapter. Free plan: 8 credits/min, 800/day, US listings,
 * ~15m delayed quotes. Extended-hours quotes need `prepost=true`, which is a
 * Pro+ feature — enable via supportsExtended only when the plan has it. */
export class TwelveDataProvider implements MarketDataProvider {
  readonly name = "twelvedata";
  readonly creditsPerMinute: number;
  readonly supportsExtended: boolean;
  constructor(
    private key: string,
    opts: { supportsExtended?: boolean; creditsPerMinute?: number } = {},
    private base = "https://api.twelvedata.com",
  ) {
    this.supportsExtended = opts.supportsExtended ?? false;
    this.creditsPerMinute = opts.creditsPerMinute ?? 8;
  }
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
  async quotes(
    refs: SymbolRef[],
    opts: { extended?: boolean } = {},
  ): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    if (!refs.length) return out;
    const mic = refs[0]!.mic;
    if (!refs.every((r) => r.mic === mic))
      throw new ProviderError("quotes require one exchange per request", false);
    const body = await this.get("/quote", {
      symbol: refs.map((r) => r.symbol).join(","),
      mic_code: mic,
      interval: "1min",
      ...(opts.extended ? { prepost: "true" } : {}),
    });
    const rows: any[] = body?.symbol
      ? [body]
      : refs.map((r) => body?.[r.symbol]).filter(Boolean);
    for (const row of rows) {
      const ref = refs.find((r) => r.symbol === row.symbol);
      if (!ref) continue;
      out.set(quoteKey(ref), rowToQuote(row));
    }
    return out;
  }
}
