import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { ToolValidationError } from "./tool-errors.js";
import {
  permitted,
  routes,
  type PermittedUrl,
  type RouteKey,
} from "./library-routes.js";
import type { CallOutcome, PacingStore } from "./library-pacing.js";
export const libraryLimits = {
  minGapMs: 2000,
  minWriteGapMs: 60000,
  dailyCeiling: 200,
  readCeiling: 180,
  linkPollCeiling: 130, // per Singapore day; the hard bound on linking (two full 60-poll attempts), independent of attemptsPerDay
  turnWaitMs: 8000,
  backgroundWaitMs: 60000,
  timeoutMs: 15000,
  searchBodyBytes: 512 * 1024,
  bodyBytes: 64 * 1024,
  throttlePauseMs: 24 * 3600000,
  rateLimitPauseMs: 3600000,
  transientPauseMs: 30 * 60000,
  transientRetries: 2,
  failureTrip: 5,
};
export type LibraryErrorKind =
  | "throttled"
  | "unauthenticated"
  | "rejected"
  | "transient"
  | "paced"
  | "forbidden_route"
  | "invalid_response";
/**
 * Every library failure the model can see is a validation error: it never becomes an
 * uncertain write, and its wording avoids the tokens that make the agent loop retry.
 * Messages carry no titleIds, counts, URLs or upstream text.
 */
export class LibraryError extends ToolValidationError {
  constructor(
    readonly kind: LibraryErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super("Library validation: " + message);
  }
}
/** Opaque identity token: stringifies as a redaction and only builds its own header. */
export class Bearer {
  #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  header() {
    return "Bearer " + this.#value;
  }
  toString() {
    return "[REDACTED]";
  }
  toJSON() {
    return "[REDACTED]";
  }
}
export function singaporeDay(at: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}
export function singaporeClock(at: number) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));
}
export interface CallOptions<T> {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  bearer?: Bearer;
  schema: z.ZodType<T, any, any>;
  /** Turn calls refuse long pacing waits; background calls (callbacks, watcher) honour them. */
  context: "turn" | "background";
  /**
   * Libby's client issues every sentry request with credentials, so the chip session it
   * establishes at mint time travels on later calls. A ceremony passes one jar through its
   * whole handshake to do the same; without it the server may not recognise the chip.
   */
  jar?: CookieJar;
  /** Receives structural failure diagnostics (never values) for a refused call. */
  onFailure?: (diagnostic: CallDiagnostic) => void;
  /** In-flight values to redact from any diagnostic excerpt by literal match. */
  secrets?: string[];
}
export interface CallDiagnostic {
  route: string;
  status: number;
  /** Header names only; values may carry session secrets. */
  headers: string[];
  /** Bounded, scrubbed excerpt of the error body. */
  body: string;
}
/**
 * A minimal same-host cookie store. Values are held in memory for the life of one ceremony and
 * are never logged or persisted; only their names ever reach diagnostics.
 */
export class CookieJar {
  private jar = new Map<string, string>();
  absorb(response: Response) {
    const raw = (response.headers as any).getSetCookie?.() ?? [];
    const lines: string[] = raw.length
      ? raw
      : ((h) => (h ? [h] : []))(response.headers.get("set-cookie"));
    for (const line of lines) {
      const pair = line.split(";", 1)[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) continue;
      // An empty value is the standard clear; honour it rather than echoing a dead cookie.
      if (value) this.jar.set(name, value);
      else this.jar.delete(name);
    }
  }
  header() {
    if (!this.jar.size) return undefined;
    return [...this.jar].map(([n, v]) => `${n}=${v}`).join("; ");
  }
  /** Cookie names present, for diagnostics. Never the values. */
  names() {
    return [...this.jar.keys()];
  }
  /** Values, used only to redact them from diagnostics before they are journalled. */
  values() {
    return [...this.jar.values()];
  }
}
export interface LibraryClientDeps {
  pacing: PacingStore;
  request?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
  onBreakerOpen?: (until: number, reason: string) => Promise<void>;
  limits?: Partial<typeof libraryLimits>;
}
export class LibraryClient {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  readonly limits: typeof libraryLimits;
  constructor(private deps: LibraryClientDeps) {
    this.request = deps.request ?? fetch;
    this.now = deps.now ?? Date.now;
    this.sleep =
      deps.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.random = deps.random ?? Math.random;
    this.limits = { ...libraryLimits, ...deps.limits };
  }
  async usage() {
    const day = singaporeDay(this.now());
    const [usage, breaker] = await Promise.all([
      this.deps.pacing.usage(day),
      this.deps.pacing.breaker(),
    ]);
    return {
      day,
      callsToday: usage.calls,
      dailyCeiling: this.limits.dailyCeiling,
      breakerOpenUntil: breaker ? new Date(breaker.until).toISOString() : null,
    };
  }
  /** One request through the global serial queue: breaker, reservation, spacing, fetch, classify, record. */
  async call<T>(key: RouteKey, options: CallOptions<T>): Promise<T> {
    const route = routes[key];
    const url = permitted(key, options.params, options.query);
    if (route.host === "sentry" && !options.bearer && key !== "chipMint")
      throw new LibraryError("unauthenticated", "the Libby card is not linked");
    const run = async () => {
      let attempt = 0;
      for (;;) {
        attempt++;
        try {
          return await this.once(key, url, options);
        } catch (error) {
          const retryable =
            error instanceof LibraryError &&
            error.kind === "transient" &&
            route.kind === "read" &&
            attempt <= this.limits.transientRetries;
          if (!retryable) throw error;
          const base = attempt === 1 ? 3000 : 8000;
          await this.sleep(base + this.random() * base * 0.6, this.deps.signal);
        }
      }
    };
    const next = this.tail.catch(() => {}).then(run);
    this.tail = next;
    return next;
  }
  private async once<T>(
    key: RouteKey,
    url: PermittedUrl,
    options: CallOptions<T>,
  ): Promise<T> {
    const route = routes[key];
    const pacing = this.deps.pacing;
    const open = await pacing.breaker();
    if (open)
      throw new LibraryError(
        "paced",
        `library access is paused until ${singaporeClock(open.until)} Singapore time after ${open.reason === "failures" ? "repeated failed answers" : "a throttle signal"}`,
      );
    const now = this.now();
    const ceiling =
      route.kind === "link"
        ? this.limits.linkPollCeiling
        : route.kind === "read"
          ? this.limits.readCeiling
          : this.limits.dailyCeiling;
    if (!(await pacing.reserve(route.kind, singaporeDay(now), ceiling))) {
      await pacing.record({
        host: route.host,
        method: route.method,
        route: route.template,
        kind: route.kind,
        outcome: "refused",
        ms: 0,
      });
      throw new LibraryError(
        "paced",
        "today's library call allowance is used up; try again tomorrow",
      );
    }
    const timing = await pacing.timing();
    const gap = route.kind === "read" || route.kind === "link" ? 0 : 1;
    const wait = Math.max(
      0,
      timing.callAt + this.limits.minGapMs - now,
      gap ? timing.writeAt + this.limits.minWriteGapMs - now : 0,
    );
    const maxWait =
      options.context === "turn"
        ? this.limits.turnWaitMs
        : this.limits.backgroundWaitMs;
    if (wait > maxWait)
      throw new LibraryError(
        "paced",
        "another library action is still settling; try again in a minute",
      );
    if (wait > 0) await this.sleep(wait, this.deps.signal);
    const started = this.now();
    await pacing.markCall(route.kind, started);
    let response: Response;
    try {
      response = await this.request(url, {
        method: route.method,
        redirect: "error",
        signal: AbortSignal.timeout(this.limits.timeoutMs),
        headers: {
          accept: "application/json",
          ...(options.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...(options.bearer ? { authorization: options.bearer.header() } : {}),
          ...(route.host === "sentry" && options.jar?.header()
            ? { cookie: options.jar.header() as string }
            : {}),
        } as Record<string, string>,
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch {
      throw await this.transient(route, started, "timeout");
    }
    if (route.host === "sentry") options.jar?.absorb(response);
    const status = response.status;
    const limit =
      key === "mediaSearch"
        ? this.limits.searchBodyBytes
        : this.limits.bodyBytes;
    let text: string | null;
    try {
      text = await readBounded(response, limit);
    } catch (error) {
      if (!(error instanceof BodyTooLarge))
        throw await this.transient(route, started, "timeout");
      text = null;
    }
    const finish = (outcome: CallOutcome) =>
      pacing.record({
        host: route.host,
        method: route.method,
        route: route.template,
        kind: route.kind,
        outcome,
        status,
        ms: this.now() - started,
      });
    if (text === null) {
      await finish("rejected");
      throw new LibraryError(
        "invalid_response",
        "the catalogue answer was too large to read safely; try a more specific title",
        status,
      );
    }
    if (status === 429 || (status === 403 && /whoa/i.test(text))) {
      await finish("throttled");
      const until =
        this.now() +
        (status === 429
          ? this.limits.rateLimitPauseMs
          : this.limits.throttlePauseMs);
      if (await pacing.openBreaker(until, status === 429 ? "429" : "whoa"))
        await this.deps.onBreakerOpen?.(until, "throttle").catch(() => {});
      throw new LibraryError(
        "throttled",
        `the library asked us to slow down; library calls are paused until ${singaporeClock(until)} Singapore time`,
        status,
      );
    }
    if (status === 401 || (status === 403 && route.host === "sentry")) {
      await finish("unauthenticated");
      let code: string | undefined;
      try {
        code = upstreamCode(JSON.parse(text));
      } catch {
        code = undefined;
      }
      options.onFailure?.({
        route: route.template,
        status,
        headers: [...response.headers.keys()].slice(0, 40),
        body: scrubExcerpt(text, 400, [
          ...(options.secrets ?? []),
          ...(options.jar?.values() ?? []),
        ]),
      });
      throw new LibraryError(
        "unauthenticated",
        "the Libby link needs to be renewed; send /library link",
        status,
        code,
      );
    }
    if (status >= 500) throw await this.transient(route, started, "transient");
    let parsed: unknown = null;
    if (text.length)
      try {
        parsed = JSON.parse(text);
      } catch {
        if (status < 400)
          throw await this.transient(route, started, "transient");
      }
    if (status >= 400) {
      await finish("rejected");
      const code = upstreamCode(parsed);
      throw new LibraryError(
        "rejected",
        "the library declined the request",
        status,
        code,
      );
    }
    const projected = options.schema.safeParse(parsed);
    if (!projected.success) {
      await finish("rejected");
      throw new LibraryError(
        "invalid_response",
        "the library answered in an unexpected shape",
        status,
      );
    }
    await finish("ok");
    await pacing.failures("reset");
    return projected.data;
  }
  private async transient(
    route: (typeof routes)[RouteKey],
    started: number,
    outcome: "transient" | "timeout",
  ) {
    await this.deps.pacing.record({
      host: route.host,
      method: route.method,
      route: route.template,
      kind: route.kind,
      outcome,
      ms: this.now() - started,
    });
    const failures = await this.deps.pacing.failures("increment");
    if (failures >= this.limits.failureTrip) {
      const until = this.now() + this.limits.transientPauseMs;
      if (await this.deps.pacing.openBreaker(until, "failures"))
        await this.deps.onBreakerOpen?.(until, "failures").catch(() => {});
    }
    return new LibraryError(
      "transient",
      "the library did not answer after bounded retries; try again in a few minutes",
    );
  }
}
/** Upstream error identifiers are short tokens; the message text is never kept. */
function upstreamCode(body: unknown) {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const code = b.errorCode ?? b.code ?? b.result;
    if (typeof code === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(code))
      return code;
  }
  return undefined;
}
/**
 * A short, safe excerpt of an error body for diagnostics. Anything token-shaped is replaced
 * before it can reach the journal; the result is bounded so a hostile body cannot flood it.
 */
export function scrubExcerpt(
  text: string,
  limit = 400,
  secrets: string[] = [],
) {
  // Known in-flight values go first and by literal match: shape heuristics cannot catch a
  // short blessing or cookie, and a refused body most often echoes what we just sent.
  let out = text;
  for (const secret of secrets)
    if (secret && secret.length >= 4) out = out.split(secret).join("[SECRET]");
  // Scrub before bounding, so a token straddling the cut cannot survive as a fragment.
  return out
    .replace(
      /[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
      "[JWT]",
    )
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, "[LONG]")
    .slice(0, limit);
}
class BodyTooLarge extends Error {}
async function readBounded(response: Response, limit: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
