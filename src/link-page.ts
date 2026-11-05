// A bounded read of a shared link's public page for classification: title, site and a short
// description from the page's own metadata. The host fills these; the model never supplies a
// title. Page content is untrusted data and is clipped before use.
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { FeedFetcher } from "./news-feed.js";
import { PublicFeedFetcher, canonicalUrl, domainOf } from "./news-feed.js";
import { publicHttps } from "./security.js";

export type PageMetadata = {
  /** The address actually read; falls back to the supplied one. */
  pageUrl: string;
  /** The page title, or the bare site name when the page exposes none. */
  title: string;
  /** The hostname without www, lowercased. */
  site: string;
  description: string;
  /** An X/Twitter post's own text, when the site exposes it through public metadata. */
  postText?: string;
};

const ONE_LINE = /[\r\n\t]+/g;
const text = (value: string, max: number) =>
  [...value.replace(ONE_LINE, " ").replace(/\s+/g, " ").trim()]
    .slice(0, max)
    .join("");

/** A public HTTPS link: http is upgraded, then the host's public-HTTPS guard applies. */
export function normalizeLink(input: string) {
  const url = new URL(input);
  if (url.protocol === "http:") url.protocol = "https:";
  return publicHttps(url.href);
}

/** Deduplication identity: scheme-less, tracking-free, with x.com and twitter.com the same. */
export function canonicalLink(input: string) {
  const url = new URL(normalizeLink(input));
  url.hostname = url.hostname
    .toLowerCase()
    .replace(/^(www|mobile|m)\./, "")
    .replace(/^twitter\.com$/, "x.com");
  url.hash = "";
  return canonicalUrl(url.href);
}

const SKIP = new Set(["script", "style", "noscript", "svg", "template"]);
const X_POST =
  /^https?:\/\/(?:www\.|mobile\.|m\.)?(?:x|twitter)\.com\/[^/?#]+\/status(?:es)?\/\d+/i;
const X_BOILERPLATE =
  /javascript is not available|something went wrong|log in to x|don't miss what's happening|enable javascript/i;
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};
const decode = (value: string) =>
  value.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, name: string) => {
    if (name in ENTITIES) return ENTITIES[name]!;
    const code = name.startsWith("#x")
      ? Number.parseInt(name.slice(2), 16)
      : name.startsWith("#")
        ? Number.parseInt(name.slice(1), 10)
        : NaN;
    return Number.isFinite(code) && code > 0 && code < 0x110000
      ? String.fromCodePoint(code)
      : match;
  });

/**
 * A status link's own text. X serves a script shell to a plain fetch, so its public oEmbed
 * metadata is read instead. Any failure is silent: the classifier then sees the page's own
 * title and the owner's message, and Jev can still answer unsure.
 */
async function xPostText(
  url: string,
  fetcher: FeedFetcher,
  signal?: AbortSignal,
) {
  // The oEmbed endpoint is documented for twitter.com addresses; x.com is the same post.
  const canonical = url.replace(
    /^https?:\/\/(?:www\.|mobile\.|m\.)?x\.com\//i,
    "https://twitter.com/",
  );
  const endpoint = `https://publish.twitter.com/oembed?dnt=1&omit_script=1&url=${encodeURIComponent(canonical)}`;
  try {
    const response = await fetcher.get(endpoint, signal);
    const data: any = JSON.parse(response.body);
    if (typeof data?.html !== "string") return undefined;
    const body = decode(
      data.html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, " "),
    );
    return text(body, 600) || undefined;
  } catch {
    if (signal?.aborted) throw new Error("Task cancelled");
    return undefined;
  }
}

function readHtml(html: string) {
  const meta: Record<string, string> = {};
  let title = "";
  let bodyText = "";
  let nodes = 0;
  const root = parse(html);
  const collect = (node: DefaultTreeAdapterMap["node"], value: string) => {
    if ("value" in node && typeof node.value === "string")
      return value + node.value;
    if ("childNodes" in node)
      for (const child of node.childNodes) value = collect(child, value);
    return value;
  };
  const walk = (node: DefaultTreeAdapterMap["node"], skip: boolean) => {
    if (nodes++ > 60_000) return;
    let skipping = skip;
    if ("tagName" in node) {
      const tag = node.tagName.toLowerCase();
      const attrs = Object.fromEntries(
        node.attrs.map((a) => [a.name.toLowerCase(), a.value]),
      );
      if (tag === "meta") {
        const key =
          attrs.property?.toLowerCase() || attrs.name?.toLowerCase() || "";
        if (key && attrs.content) meta[key] = attrs.content;
      }
      if (tag === "title" && !title) title = collect(node, "");
      skipping = skipping || SKIP.has(tag);
    }
    if (!skipping && "value" in node && typeof node.value === "string") {
      if (bodyText.length < 3000) bodyText += " " + node.value;
    }
    if ("childNodes" in node)
      for (const child of node.childNodes) walk(child, skipping);
  };
  walk(root, false);
  const site = text(meta["og:site_name"] ?? "", 100);
  const headline = text(meta["og:title"] ?? title, 300);
  const desc = text(meta["og:description"] ?? meta.description ?? "", 600);
  // A page with no metadata still has body text; it is evidence, clipped, never a title.
  return {
    title: headline,
    site,
    description: desc || text(bodyText, 600),
  };
}

/**
 * Read a page once. Failure is not fatal: the host falls back to the site name and the
 * classifier still reads the link and the owner's message. A cancelled task is rethrown.
 */
export async function readLinkPage(
  url: string,
  fetcher: FeedFetcher = new PublicFeedFetcher(),
  signal?: AbortSignal,
): Promise<PageMetadata> {
  const site = domainOf(url);
  const fallback: PageMetadata = {
    pageUrl: url,
    title: site,
    site,
    description: "",
  };
  const bounded = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(8000),
  ]);
  try {
    const response = await fetcher.get(url, bounded);
    if (signal?.aborted) throw new Error("Task cancelled");
    const pageUrl = publicHttps(response.finalUrl);
    const page = readHtml(response.body);
    const fallbackTitle = domainOf(pageUrl);
    const site = page.site || fallbackTitle;
    let title = page.title;
    let description = page.description;
    let postText: string | undefined;
    if (X_POST.test(pageUrl)) {
      postText = await xPostText(pageUrl, fetcher, bounded);
      if (postText) {
        if (!description || X_BOILERPLATE.test(description))
          description = postText;
        // The post's own opening words are real page content, never an invented title.
        if (
          !title ||
          /^x$/i.test(title) ||
          title.toLowerCase() === site.toLowerCase()
        ) {
          title = text(postText, 200);
        }
      }
    }
    return {
      pageUrl,
      title: title || fallbackTitle,
      site,
      description,
      ...(postText ? { postText } : {}),
    };
  } catch (error) {
    if (signal?.aborted) throw new Error("Task cancelled");
    return fallback;
  }
}
