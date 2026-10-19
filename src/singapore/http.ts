import {
  downloadLink,
  routeUrl,
  type Provider,
  type RouteName,
} from "./routes.js";

/** A temporary provider refusal (429 or 5xx): the caller may say "try again shortly". */
export class SgBusyError extends Error {
  constructor(
    readonly provider: Provider,
    readonly retryAfterSeconds: number,
  ) {
    super(`${provider} is busy; retry in about ${retryAfterSeconds}s`);
  }
}

export interface SgHttpOptions {
  fetch?: typeof fetch;
  /** data.gov.sg API key; raises its rate limits. Optional. */
  dataGovKey?: string;
  /** LTA DataMall AccountKey; DataMall routes are refused without it. */
  dataMallKey?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const USER_AGENT =
  "ChiefAssistant/1.0 (personal assistant; +https://github.com/akhilvuputuri/chief-agent)";
const TIMEOUT_MS = 15_000;
const JSON_LIMIT = 4 * 1024 * 1024;
const FILE_LIMIT = 8 * 1024 * 1024;
/** After a 429 the anonymous data.gov.sg limit took up to a minute to recover (journal 99). */
const BREAKER_MS = 60_000;

/**
 * Serial, paced GET client for the routes in routes.ts. Each provider has one queue:
 * the anonymous data.gov.sg limit is shared across its endpoints, so requests are
 * spaced instead of fanned out.
 */
export class SgHttp {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tail = new Map<Provider, Promise<unknown>>();
  private readonly last = new Map<Provider, number>();
  private readonly blockedUntil = new Map<Provider, number>();
  constructor(private readonly options: SgHttpOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }
  get dataMallConfigured() {
    return !!this.options.dataMallKey;
  }
  /**
   * Minimum spacing between requests in one rate-limit group. Documented limits per
   * 10 seconds without / with a production key: real-time 6 / 30, datastore 4 / 20,
   * downloads 2 / 10 (journal 99). DataMall documents only a daily ceiling.
   */
  gap(provider: Provider) {
    const keyed = !!this.options.dataGovKey;
    switch (provider) {
      case "dataMall":
        return 200;
      case "dataGovLegacy":
        return 500;
      case "dataGovRealtime":
        return keyed ? 400 : 2_500;
      case "dataGovStore":
        return keyed ? 600 : 3_000;
      case "dataGovFiles":
        // The download guide also states 5 requests a minute; files are cached for a day.
        return 12_000;
    }
  }
  async json(
    name: RouteName,
    query: Record<string, string | number | undefined> = {},
    params: Record<string, string> = {},
  ): Promise<unknown> {
    const { url, provider } = routeUrl(name, params, query);
    if (provider === "dataMall" && !this.options.dataMallKey)
      throw new Error("LTA DataMall is not configured");
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      accept: "application/json",
    };
    if (provider === "dataMall") headers.AccountKey = this.options.dataMallKey!;
    else if (this.options.dataGovKey)
      headers["x-api-key"] = this.options.dataGovKey;
    const text = await this.paced(provider, url, headers, JSON_LIMIT);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${provider} returned an unreadable response`);
    }
  }
  /** Fetches a data.gov.sg dataset file through its poll-download link. */
  async file(dataset: string): Promise<unknown> {
    const poll = (await this.json("download", {}, { dataset })) as {
      data?: { url?: unknown };
    };
    const url = downloadLink(poll?.data?.url);
    const text = await this.paced(
      "dataGovFiles",
      url,
      { "user-agent": USER_AGENT },
      FILE_LIMIT,
      false,
    );
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Dataset file is not JSON");
    }
  }
  private paced(
    provider: Provider,
    url: URL,
    headers: Record<string, string>,
    limit: number,
    counted = true,
  ): Promise<string> {
    const run = (this.tail.get(provider) ?? Promise.resolve()).then(
      async () => {
        const blocked = (this.blockedUntil.get(provider) ?? 0) - this.now();
        if (blocked > 0)
          throw new SgBusyError(provider, Math.ceil(blocked / 1000));
        // Signed file links are not API calls and do not count against the rate limit.
        if (counted) {
          const wait =
            (this.last.get(provider) ?? -Infinity) +
            this.gap(provider) -
            this.now();
          if (wait > 0) await this.sleep(wait);
          this.last.set(provider, this.now());
        }
        try {
          return await this.request(provider, url, headers, limit);
        } catch (error) {
          // One patient retry for downloads: they are rare, cached and limited per minute.
          if (!(error instanceof SgBusyError) || provider !== "dataGovFiles")
            throw error;
          await this.sleep(15_000);
          this.blockedUntil.delete(provider);
          this.last.set(provider, this.now());
          return this.request(provider, url, headers, limit);
        }
      },
    );
    this.tail.set(
      provider,
      run.catch(() => undefined),
    );
    return run;
  }
  private async request(
    provider: Provider,
    url: URL,
    headers: Record<string, string>,
    limit: number,
  ) {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new SgBusyError(provider, 30);
    }
    if (response.status === 429) {
      this.blockedUntil.set(provider, this.now() + BREAKER_MS);
      throw new SgBusyError(provider, BREAKER_MS / 1000);
    }
    if (response.status >= 500) throw new SgBusyError(provider, 30);
    if (provider === "dataMall" && response.status === 401)
      throw new Error("LTA DataMall rejected the account key");
    if (!response.ok)
      throw new Error(`${provider} request failed (${response.status})`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > limit) throw new Error(`${provider} response is too large`);
    const body = await response.text();
    if (body.length > limit)
      throw new Error(`${provider} response is too large`);
    return body;
  }
}
