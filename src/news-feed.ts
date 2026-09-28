/** Feed boundary for the news bulletin: bounded RSS/Atom parsing, URL
 * canonicalization, feed discovery from a site address and a public-only HTTPS
 * fetcher. Feed text is untrusted data: it is sanitized for display and never
 * interpreted as instructions or markup. Adapted from the closed PR #83. */
import https from "node:https";
import dns from "node:dns";
import { BlockList, isIP } from "node:net";
import { publicHttps } from "./security.js";

export interface FeedEntry {
  title: string;
  url: string;
  summary: string | null;
  categories: string[];
  publishedAt: Date | null;
}
export interface ParsedFeed {
  title: string | null;
  language: string | null;
  entries: FeedEntry[];
}

const MAX_ENTRIES = 100;
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  eacute: "é",
  egrave: "è",
  aacute: "á",
  oacute: "ó",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
};
/** Only fixed named and numeric entities are expanded; DTD-declared entities are
 * never resolved, so entity-expansion and external-entity payloads stay inert. */
export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X"
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10);
      // Lone surrogates would make the stored JSON invalid; drop them.
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : "";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
const LONE_SURROGATE = new RegExp(
  "[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]",
  "g",
);
// Zero-width and bidirectional-override characters can disguise a title or link.
const INVISIBLE = new RegExp(
  "[\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]",
  "g",
);
/** Plain display text: markup removed, control and bidi-override characters
 * dropped, whitespace collapsed. */
/** Unwraps CDATA sections with forward-only searches (an unterminated
 * section keeps its remaining text). */
function stripCdata(s: string) {
  let out = "";
  let pos = 0;
  for (;;) {
    const at = s.indexOf("<![CDATA[", pos);
    if (at < 0) return out + s.slice(pos);
    const end = s.indexOf("]]>", at + 9);
    if (end < 0) return out + s.slice(pos, at) + s.slice(at + 9);
    out += s.slice(pos, at) + s.slice(at + 9, end);
    pos = end + 3;
  }
}
/** Removes <script>/<style> elements in one forward pass; an unclosed one
 * drops the rest of the text rather than rescanning for every opening. */
function stripCode(s: string) {
  const lower = asciiLower(s);
  let out = "";
  let pos = 0;
  // Next-occurrence caches, recomputed only once passed, keep this linear.
  let script = -2;
  let style = -2;
  for (;;) {
    if (script !== -1 && script < pos) script = lower.indexOf("<script", pos);
    if (style !== -1 && style < pos) style = lower.indexOf("<style", pos);
    const at =
      script < 0 ? style : style < 0 ? script : Math.min(script, style);
    if (at < 0) return out + s.slice(pos);
    const close = lower.indexOf(at === script ? "</script" : "</style", at);
    const end = close < 0 ? -1 : lower.indexOf(">", close);
    out += s.slice(pos, at) + " ";
    if (end < 0) return out;
    pos = end + 1;
  }
}
export function cleanText(raw: string, max: number) {
  // Bound the input and use only linear steps: feed text is hostile input
  // and parsing runs on the gateway's event loop.
  let s = stripCdata(
    raw.slice(0, Math.max(4000, max * 12)).replace(LONE_SURROGATE, ""),
  );
  s = decodeEntities(s);
  // [^<>] keeps each tag match local: a run of "<" without ">" is linear.
  s = stripCode(s).replace(/<[^<>]*>/g, " ");
  s = decodeEntities(s)
    .replace(/<[^<>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sentence = cut.lastIndexOf(". ");
  if (sentence > max * 0.4) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut) + "…";
}
/** Lowercase copy with the same indexes. Native lowercasing only ever grows
 * a string (e.g. "İ"), so equal length means every index still lines up;
 * otherwise fall back to ASCII-only lowercasing. */
const asciiLower = (s: string) => {
  const native = s.toLowerCase();
  return native.length === s.length
    ? native
    : s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
};
const MAX_OPEN_TAG = 4000;
interface Element {
  open: string;
  /** Text between the start and end tags; null when self-closing or unclosed. */
  inner: string | null;
}
/** Linear scan for <name …>…</name> elements. Each search for ">" and for the
 * closing tag moves only forward and is reused across opening tags, so a feed
 * full of unclosed or unterminated tags cannot make parsing quadratic (a
 * regex like /<item>([\s\S]*?)<\/item>/g rescans to the end per opening). */
function* elements(
  text: string,
  name: string,
  pairs = true,
): Generator<Element> {
  const lower = asciiLower(text);
  const opening = "<" + name.toLowerCase();
  const closing = "</" + name.toLowerCase();
  let pos = 0;
  let gt = -2; // cached next ">" (-2 unknown, -1 none left)
  let close = -2; // cached next closing tag
  for (;;) {
    const at = lower.indexOf(opening, pos);
    if (at < 0) return;
    const next = lower.charCodeAt(at + opening.length);
    // The name must end here: whitespace, ">" or "/".
    if (!(
      next === 62 ||
      next === 47 ||
      next === 32 ||
      (next >= 9 && next <= 13)
    )) {
      pos = at + opening.length;
      continue;
    }
    if (gt !== -1 && gt < at) gt = lower.indexOf(">", at);
    if (gt === -1) return;
    const end = gt;
    if (end - at > MAX_OPEN_TAG) {
      pos = at + opening.length;
      continue;
    }
    const open = text.slice(at, end + 1);
    if (!pairs || text.charCodeAt(end - 1) === 47) {
      yield { open, inner: null };
      pos = end + 1;
      continue;
    }
    // The closing name must end too: "</linkedin>" does not close <link>.
    while (close !== -1 && close < end) {
      close = lower.indexOf(closing, end);
      while (close !== -1) {
        const c = lower.charCodeAt(close + closing.length);
        if (c === 62 || c === 32 || (c >= 9 && c <= 13)) break;
        close = lower.indexOf(closing, close + 1);
      }
    }
    if (close === -1) {
      yield { open, inner: null };
      pos = end + 1;
      continue;
    }
    yield { open, inner: text.slice(end + 1, close) };
    pos = close + closing.length;
  }
}
function take<T>(items: Iterable<T>, n: number) {
  const out: T[] = [];
  for (const item of items) {
    if (out.length >= n) break;
    out.push(item);
  }
  return out;
}
/** Rejects when `ms` elapses first; the underlying request keeps its own timeout. */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new Error("time limit reached"));
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("time limit reached")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
function tag(block: string, names: string[]) {
  for (const name of names)
    for (const e of elements(block, name)) if (e.inner?.trim()) return e.inner;
  return null;
}
function firstOpen(text: string, names: string[]) {
  for (const name of names) for (const e of elements(text, name)) return e.open;
  return "";
}
function attr(element: string, name: string) {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(
    element,
  );
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : null;
}
/** Absolute http(s) article link or null; javascript:, data: and credentialed URLs are refused. */
export function articleUrl(raw: string | null, base: string) {
  if (!raw || raw.length > 4000) return null;
  try {
    const text = decodeEntities(stripCdata(raw)).trim();
    // Refuse rather than truncate: a shortened link would not be the direct article URL.
    if (!text || text.length > 2000 || /\s/.test(text)) return null;
    const u = new URL(text, base);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      return null;
    return u.href;
  } catch {
    return null;
  }
}
export function parseDate(raw: string | null, now = new Date()) {
  if (!raw) return null;
  const t = Date.parse(cleanText(raw, 100));
  if (!Number.isFinite(t)) return null;
  // Future-dated or implausibly old timestamps are unknown, not invented.
  if (t > now.getTime() + 86400000 || t < Date.UTC(1995, 0, 1)) return null;
  return new Date(t);
}
export function parseFeed(xml: string, base: string, now = new Date()) {
  let body = xml.slice(0, 2_000_000);
  // The document's root element decides the format; text inside entries cannot.
  const rootMatch = /<(?![?!])([\w.-]+:)?([\w.-]+)/.exec(
    xml.slice(0, 2_000_000),
  );
  const atom = rootMatch?.[2]?.toLowerCase() === "feed";
  // A prefixed Atom document (<atom:feed>, <atom:entry>, …) is read as if unprefixed.
  if (atom && rootMatch?.[1])
    body = body.replace(
      new RegExp(`<(/?)${rootMatch[1].replace(/[.-]/g, "\\$&")}`, "g"),
      "<$1",
    );
  const blocks: string[] = [];
  for (const e of elements(body, atom ? "entry" : "item")) {
    if (e.inner !== null) blocks.push(e.inner);
    if (blocks.length >= MAX_ENTRIES) break;
  }
  const first = asciiLower(body).indexOf(atom ? "<entry" : "<item");
  const head = first < 0 ? body : body.slice(0, first);
  const language =
    tag(head, ["language", "dc:language"]) ??
    attr(firstOpen(head, ["feed", "rss", "channel"]), "xml:lang");
  const entries: FeedEntry[] = [];
  for (const b of blocks) {
    const title = cleanText(tag(b, ["title"]) ?? "", 300);
    let link: string | null = null;
    if (atom) {
      const links = take(elements(b, "link"), 20).map((e) => e.open);
      const alt =
        links.find((l) => (attr(l, "rel") ?? "alternate") === "alternate") ??
        links[0];
      link = alt ? attr(alt, "href") : null;
    } else {
      link = tag(b, ["link"]);
      if (!link) {
        const guid = elements(b, "guid").next().value as Element | undefined;
        if (guid?.inner && attr(guid.open, "isPermaLink") !== "false")
          link = guid.inner;
      }
    }
    const url = articleUrl(link, base);
    if (!title || !url) continue;
    const rawSummary = tag(b, [
      "description",
      "summary",
      "content:encoded",
      "content",
      "media:description",
    ]);
    const summary = rawSummary ? cleanText(rawSummary, 320) : "";
    // Atom puts the label in `term` (self-closing or paired); RSS uses the element text.
    const categories = [
      ...new Set(
        take(elements(b, "category"), 20)
          .map((e) => cleanText(attr(e.open, "term") ?? e.inner ?? "", 60))
          .filter(Boolean),
      ),
    ].slice(0, 8);
    entries.push({
      title,
      url,
      summary: summary && summary !== title ? summary : null,
      categories,
      publishedAt: parseDate(
        tag(b, ["pubDate", "published", "dc:date", "updated"]),
        now,
      ),
    });
  }
  const feedTitle = tag(head, ["title"]);
  return {
    title: feedTitle ? cleanText(feedTitle, 120) || null : null,
    language: language ? cleanText(language, 20).toLowerCase() || null : null,
    entries,
  } satisfies ParsedFeed;
}

const TRACKING =
  /^(utm_.*|fbclid|gclid|dclid|mc_cid|mc_eid|ref|ref_src|cmpid|ocid|_ga|igshid|smid|guccounter)$/i;
/** Scheme-less, tracking-free identity used for deduplication and delivery history. */
export function canonicalUrl(raw: string) {
  const u = new URL(raw);
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length
    ? "?" + new URLSearchParams(params).toString()
    : "";
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : "";
  return `${domainOf(raw)}${path}${query}`;
}
export function domainOf(raw: string) {
  return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
}

const STOP = new Set(
  "the a an and or of to in on for with at by from as is are was were be been this that these those it its into over after before about how why what who new says said will can could".split(
    " ",
  ),
);
/** Title signature for near-duplicate story clustering. */
export function storyTokens(title: string) {
  return new Set(
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  );
}
export function similarity(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}
export const SAME_STORY = 0.6;

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback and deprecated IPv4-compatible addresses
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2002::", 16], // 6to4 can embed a private IPv4 address
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, prefix, "ipv6");
/** True for loopback, private, link-local (including cloud metadata), CGNAT,
 * documentation, multicast and reserved addresses. */
export function nonPublicAddress(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped ? mapped[1]! : address;
  const family = isIP(ip);
  if (!family) return true;
  if (family === 6 && /^::ffff:/i.test(ip)) return true;
  return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}
type Resolver = (
  host: string,
) => Promise<{ address: string; family: number }[]>;
const systemResolver: Resolver = (host) =>
  dns.promises.lookup(host, { all: true, verbatim: true });
/** Connection-time DNS guard: the validated address is the one the socket uses,
 * so a rebinding answer between check and connect cannot reach a private host. */
export function guardedLookup(resolve: Resolver = systemResolver) {
  return (
    hostname: string,
    options: { all?: boolean } | number | undefined,
    callback: (...args: any[]) => void,
  ) => {
    resolve(hostname).then(
      (addresses) => {
        if (
          !addresses.length ||
          addresses.some((a) => nonPublicAddress(a.address))
        )
          return callback(
            Object.assign(
              new Error("Feed host resolves to a non-public address"),
              { code: "ENOTFOUND" },
            ),
          );
        if (typeof options === "object" && options?.all)
          return callback(null, addresses);
        callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (error) => callback(error),
    );
  };
}

export interface FeedFetcher {
  get(url: string): Promise<{ body: string; finalUrl: string }>;
}
const MAX_FEED_BYTES = 1_500_000;
/** Direct HTTPS feed retrieval: public hostnames only, pinned DNS answers,
 * no credentials or cookies, three redirects, 1.5 MB and 15 seconds at most. */
export class PublicFeedFetcher implements FeedFetcher {
  constructor(private resolve: Resolver = systemResolver) {}
  /** Every failure, including a refused redirect target, rejects the promise: nothing
   * may throw inside a socket callback, where it would crash the gateway process. */
  async get(
    url: string,
    redirects = 0,
  ): Promise<{ body: string; finalUrl: string }> {
    const target = publicHttps(url);
    const result = await this.once(target);
    if ("body" in result) return { body: result.body, finalUrl: target };
    if (redirects >= 3) throw new Error("Too many redirects");
    let next: string;
    try {
      next = new URL(result.location, target).href;
    } catch {
      throw new Error("Invalid redirect");
    }
    return this.get(next, redirects + 1);
  }
  private once(target: string) {
    return new Promise<{ body: string } | { location: string }>(
      (resolve, reject) => {
        let settled = false;
        const finish = (error: unknown, value?: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          if (error)
            reject(error instanceof Error ? error : new Error("Feed error"));
          else resolve(value);
        };
        let req: ReturnType<typeof https.request>;
        const deadline = setTimeout(() => {
          req?.destroy();
          finish(new Error("Feed request timed out"));
        }, 15000);
        try {
          req = https.request(
            target,
            {
              method: "GET",
              lookup: guardedLookup(this.resolve) as any,
              headers: {
                "User-Agent": "ChiefNewsBulletin/1.0 (personal feed reader)",
                Accept:
                  "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, text/html;q=0.5, */*;q=0.1",
              },
            },
            (res) => {
              try {
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400 && res.headers.location) {
                  res.resume();
                  return finish(null, { location: res.headers.location });
                }
                if (status !== 200) {
                  res.resume();
                  return finish(
                    new Error(`Feed request failed (HTTP ${status})`),
                  );
                }
                const chunks: Buffer[] = [];
                let size = 0;
                res.on("data", (chunk: Buffer) => {
                  size += chunk.length;
                  if (size > MAX_FEED_BYTES) {
                    req.destroy();
                    finish(new Error("Feed too large"));
                    return;
                  }
                  chunks.push(chunk);
                });
                res.on("end", () => {
                  try {
                    finish(null, {
                      body: decodeBody(
                        Buffer.concat(chunks),
                        res.headers["content-type"],
                      ),
                    });
                  } catch (error) {
                    finish(error);
                  }
                });
                res.on("error", (e) => finish(e));
              } catch (error) {
                finish(error);
              }
            },
          );
          req.on("error", (e) => finish(e));
          req.end();
        } catch (error) {
          finish(error);
        }
      },
    );
  }
}
function decodeBody(bytes: Buffer, contentType: string | undefined) {
  const declared =
    /charset=([\w-]+)/i.exec(contentType ?? "")?.[1] ??
    /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(
      bytes.subarray(0, 200).toString("latin1"),
    )?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(declared).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** True when the document's root element is an RSS, RDF or Atom feed. */
export function looksLikeFeed(body: string) {
  const root = /<(?![?!])(?:[\w.-]+:)?([\w.-]+)/.exec(body.slice(0, 5000));
  return ["rss", "feed", "rdf"].includes(root?.[1]?.toLowerCase() ?? "");
}
/** Feed links a page advertises with <link rel="alternate" type="…rss/atom…">. */
export function advertisedFeeds(html: string, base: string) {
  const out: string[] = [];
  // HTML <link> elements have no closing tag: scan opening tags only.
  for (const { open } of elements(html.slice(0, 500_000), "link", false)) {
    const rel = (attr(open, "rel") ?? "").toLowerCase().split(/\s+/);
    const type = (attr(open, "type") ?? "").toLowerCase();
    if (!rel.includes("alternate") || !/(rss|atom)\+xml/.test(type)) continue;
    const url = articleUrl(attr(open, "href"), base);
    if (url && !out.includes(url)) out.push(url);
  }
  return out.slice(0, 3);
}
const COMMON_PATHS = [
  "/feed",
  "/rss",
  "/feed.xml",
  "/rss.xml",
  "/atom.xml",
  "/index.xml",
];

/** Turns the address of a site the owner follows into a working feed: the
 * address itself when it is a feed, else a feed the page advertises, else a
 * conventional path. Every candidate must parse with at least one entry. */
type Found = { feedUrl: string; feed: ParsedFeed };
type Page = { html: string; finalUrl: string };
export async function discoverFeed(
  fetcher: FeedFetcher,
  site: string,
  now = new Date(),
  budgetMs = 45000,
): Promise<Found | null> {
  const tried: string[] = [];
  const deadline = Date.now() + budgetMs;
  // At most nine requests per discovery: the site, up to three advertised
  // feeds and the conventional paths.
  const attempt = async (url: string): Promise<Found | Page | null> => {
    if (tried.includes(url) || tried.length >= 9) return null;
    tried.push(url);
    try {
      const { body, finalUrl } = await withDeadline(
        fetcher.get(url),
        deadline - Date.now(),
      );
      if (!looksLikeFeed(body)) return { html: body, finalUrl };
      const feed = parseFeed(body, finalUrl, now);
      return feed.entries.length ? { feedUrl: finalUrl, feed } : null;
    } catch {
      return null;
    }
  };
  const first = await attempt(site);
  if (first && "feed" in first) return first;
  const page = first as Page | null;
  const base = page?.finalUrl ?? site;
  for (const url of page ? advertisedFeeds(page.html, base) : []) {
    const found = await attempt(url);
    if (found && "feed" in found) return found;
  }
  const origin = new URL(base).origin;
  for (const path of COMMON_PATHS) {
    const found = await attempt(origin + path);
    if (found && "feed" in found) return found;
  }
  return null;
}
