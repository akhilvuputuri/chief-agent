/** Feed boundary for the reading bulletin: bounded RSS/Atom parsing, URL
 * canonicalization and a public-only HTTPS fetcher. Feed text is untrusted data:
 * it is sanitized for display and never interpreted as instructions or markup. */
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
export function cleanText(raw: string, max: number) {
  let s = raw
    .replace(LONE_SURROGATE, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = decodeEntities(s);
  s = s
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  s = decodeEntities(s)
    .replace(/<[^>]*>/g, " ")
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
function escapeTag(name: string) {
  return name.replace(/[:]/g, "\\:");
}
function tag(block: string, names: string[]) {
  for (const name of names) {
    const m = new RegExp(
      `<${escapeTag(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeTag(name)}\\s*>`,
      "i",
    ).exec(block);
    if (m && m[1]!.trim()) return m[1]!;
  }
  return null;
}
function attr(element: string, name: string) {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(
    element,
  );
  return m ? decodeEntities(m[2] ?? m[3] ?? "") : null;
}
/** Absolute http(s) article link or null; javascript:, data: and credentialed URLs are refused. */
export function articleUrl(raw: string | null, base: string) {
  if (!raw) return null;
  try {
    const text = decodeEntities(
      raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"),
    ).trim();
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
  const blocks = [
    ...body.matchAll(
      atom
        ? /<entry\b[^>]*>([\s\S]*?)<\/entry\s*>/gi
        : /<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi,
    ),
  ]
    .slice(0, MAX_ENTRIES)
    .map((m) => m[1]!);
  const first = body.search(atom ? /<entry\b/i : /<item\b/i);
  const head = first < 0 ? body : body.slice(0, first);
  const language =
    tag(head, ["language", "dc:language"]) ??
    attr(/<(?:feed|rss|channel)\b[^>]*>/i.exec(head)?.[0] ?? "", "xml:lang");
  const entries: FeedEntry[] = [];
  for (const b of blocks) {
    const title = cleanText(tag(b, ["title"]) ?? "", 300);
    let link: string | null = null;
    if (atom) {
      const links = [...b.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
      const alt =
        links.find((l) => (attr(l, "rel") ?? "alternate") === "alternate") ??
        links[0];
      link = alt ? attr(alt, "href") : null;
    } else {
      link = tag(b, ["link"]);
      if (!link) {
        const guid = /<guid\b[^>]*>([\s\S]*?)<\/guid\s*>/i.exec(b);
        if (guid && attr(guid[0], "isPermaLink") !== "false") link = guid[1]!;
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
        [
          ...b.matchAll(
            /<category\b([^>]*?)(?:\/>|>([\s\S]*?)<\/category\s*>)/gi,
          ),
        ]
          .map((m) => cleanText(attr(m[1]!, "term") ?? m[2] ?? "", 60))
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
                "User-Agent": "ChiefReadingBulletin/1.0 (personal feed reader)",
                Accept:
                  "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1",
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
