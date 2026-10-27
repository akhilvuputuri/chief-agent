import { boundedBytes, discardBody } from "../providers.js";
import {
  downloadLink,
  radarImageLink,
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
const IMAGE_LIMIT = 2 * 1024 * 1024;
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
   * 10 seconds without a key / with a production key: real-time 6 / 30, datastore 4 / 20,
   * (a developer key allows 12 / 8 / 4, and an invalid key is treated as anonymous),
   * downloads 2 / 10 (journal 99). DataMall documents only a daily ceiling.
   */
  gap(provider: Provider) {
    const keyed = !!this.options.dataGovKey;
    switch (provider) {
      case "dataMall":
        return 200;
      case "oneMap":
        return 500;
      case "radarImages":
        return 0;
      case "dataGovRadar":
        return 1_100;
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
    // Each key goes only to its own provider; OneMap search is keyless.
    if (provider === "dataMall") headers.AccountKey = this.options.dataMallKey!;
    else if (provider.startsWith("dataGov") && this.options.dataGovKey)
      headers["x-api-key"] = this.options.dataGovKey;
    const text = (
      await this.paced(provider, url, headers, JSON_LIMIT)
    ).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${provider} returned an unreadable response`);
    }
  }
  /** Fetches a data.gov.sg dataset file through its poll-download link. */
  async file(dataset: string): Promise<unknown> {
    type Poll = { data?: { url?: unknown } };
    const link = (body: unknown) => (body as Poll)?.data?.url;
    // GeoJSON files are documented as ready to poll directly; when a poll has no link,
    // start the download and poll again a few times.
    let raw = link(await this.json("download", {}, { dataset }));
    if (!raw) raw = link(await this.json("initiateDownload", {}, { dataset }));
    for (let attempt = 0; !raw && attempt < 3; attempt++) {
      await this.sleep(2_000);
      raw = link(await this.json("download", {}, { dataset }));
    }
    const url = downloadLink(raw);
    const text = (
      await this.paced(
        "dataGovFiles",
        url,
        { "user-agent": USER_AGENT },
        FILE_LIMIT,
        false,
      )
    ).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Dataset file is not JSON");
    }
  }
  /** Downloads one NEA radar PNG from its signed link (no API key is sent). */
  radarImage(link: unknown): Promise<Buffer> {
    const url = radarImageLink(link);
    return this.paced(
      "radarImages",
      url,
      { "user-agent": USER_AGENT },
      IMAGE_LIMIT,
      false,
    );
  }
  private paced(
    provider: Provider,
    url: URL,
    headers: Record<string, string>,
    limit: number,
    counted = true,
  ): Promise<Buffer> {
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
    try {
      if (response.status === 429) {
        this.blockedUntil.set(provider, this.now() + BREAKER_MS);
        throw new SgBusyError(provider, BREAKER_MS / 1000);
      }
      if (response.status >= 500) throw new SgBusyError(provider, 30);
      if (provider === "dataMall" && response.status === 401)
        throw new Error("LTA DataMall rejected the account key");
      if (!response.ok)
        throw new Error(`${provider} request failed (${response.status})`);
    } catch (error) {
      await discardBody(response);
      throw error;
    }
    // content-length counts compressed bytes, so the limit is applied again
    // to the decoded stream; boundedBytes cancels the body when it stops early.
    if (!response.body) return Buffer.alloc(0);
    let body: Buffer;
    try {
      body = Buffer.from(await boundedBytes(response, limit));
    } catch (error) {
      if (error instanceof Error && error.message === "Response too large")
        throw new Error(`${provider} response is too large`);
      throw error;
    }
    return body;
  }
}
