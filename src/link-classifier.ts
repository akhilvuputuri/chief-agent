// Reading a shared page and turning Jev's judgment into the stored route. The
// classification itself is model judgment (src/jev.ts); the only host rules here
// are safety: a page title must come from the page, and anything uncertain, slow
// or unparseable becomes "unsure" so the owner gets the tap options. It never
// falls back to Reader.
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { publicLink } from "./link-resolution.js";
import { ToolValidationError } from "./tool-errors.js";
import {
  canonicalUrl,
  domainOf,
  withoutTracking,
  type FeedFetcher,
} from "./news-feed.js";
import type {
  LinkJudgeInput,
  LinkJudgeResult,
  LinkKind,
  LinkRoute,
  LinkTopic,
} from "./jev.js";

/**
 * The one URL a save uses: the public https address as served, with tracking
 * parameters and the fragment removed. It is the fetch target, the Reader payload and
 * the pending-save lookup, so a key can never be reused for a different payload.
 */
export function linkUrl(raw: string) {
  return withoutTracking(new URL(publicLink(raw)).href);
}

/** The dedupe key for a link: the same address without `www`, a trailing slash or
 * parameter order, so variants of one link cannot become two entries. */
export function dedupeKey(raw: string) {
  return canonicalUrl(new URL(publicLink(raw)).href);
}

export interface PageInfo {
  /** The one link URL: pending-save lookup, Reader payload and the stored `url`. */
  url: string;
  /** The dedupe key stored as `canonical_url`; never sent to another service. */
  canonicalUrl: string;
  title: string | null;
  site: string;
  excerpt: string | null;
  /** False when the page could not be read; the title is then unknown, never guessed. */
  fetched: boolean;
}

const MAX_NODES = 400_000;
const clean = (value: string) => value.replace(/\s+/g, " ").trim();
const clip = (value: string, n: number) => {
  const points = [...value];
  return points.length > n ? points.slice(0, n).join("") : value;
};

/** Tags whose text is the page's own visible post/article text. */
const BODY_TAGS = new Set([
  "p",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "pre",
]);
const SKIP_TAGS = new Set(["script", "style", "noscript", "template"]);

const textOf = (node: DefaultTreeAdapterMap["node"]): string =>
  "value" in node
    ? (node as { value: string }).value
    : "childNodes" in node
      ? node.childNodes.map(textOf).join(" ")
      : "";

/**
 * The page's visible text, so the classifier sees the post itself rather than only a
 * meta description. Script and style content is skipped, and a page with none of these
 * tags yields nothing rather than markup.
 */
function visibleText(root: DefaultTreeAdapterMap["node"], max = 6000) {
  const out: string[] = [];
  let size = 0;
  const queue: DefaultTreeAdapterMap["node"][] = [root];
  for (let i = 0; i < queue.length && i < MAX_NODES && size < max; i++) {
    const node = queue[i]!;
    if ("tagName" in node) {
      if (SKIP_TAGS.has(node.tagName)) continue;
      if (BODY_TAGS.has(node.tagName)) {
        const text = clean(textOf(node));
        if (text) {
          out.push(text);
          size += text.length;
          continue;
        }
      }
    }
    if ("childNodes" in node) queue.push(...node.childNodes);
  }
  return out.join(" ");
}

/** A PDF or other binary body decodes to noise, so it has no title to read. */
export const looksBinary = (body: string) =>
  /^%PDF|\u0000|\ufffd{8}/.test(body.slice(0, 2048));

/** Title, site and description from the page's own markup; nothing is invented. */
export function pageMetadata(
  body: string,
  finalUrl: string,
  limits = { title: 300, excerpt: 2400 },
): { title: string | null; site: string; excerpt: string | null } {
  if (looksBinary(body))
    return { title: null, site: domainOf(finalUrl), excerpt: null };
  const meta = new Map<string, string>();
  let title: string | null = null;
  const tree = parse(body);
  const stack: DefaultTreeAdapterMap["node"][] = [tree];
  let visited = 0;
  while (stack.length && visited++ < MAX_NODES) {
    const node = stack.pop()!;
    if ("tagName" in node) {
      const attrs = Object.fromEntries(
        node.attrs.map((a) => [a.name.toLowerCase(), a.value]),
      );
      if (node.tagName === "title" && title === null) {
        const text = node.childNodes
          .map((c) => ("value" in c ? c.value : ""))
          .join("");
        if (clean(text)) title = clip(clean(text), limits.title);
      }
      if (node.tagName === "meta") {
        const key = (
          attrs.property ??
          attrs.name ??
          attrs.itemprop ??
          ""
        ).toLowerCase();
        if (key && attrs.content && !meta.has(key))
          meta.set(key, clean(attrs.content));
      }
    }
    if ("childNodes" in node) stack.push(...node.childNodes);
  }
  const site = meta.get("og:site_name") ?? domainOf(finalUrl);
  const description =
    meta.get("og:description") ??
    meta.get("description") ??
    meta.get("twitter:description") ??
    null;
  title =
    title ??
    meta.get("og:title") ??
    meta.get("twitter:title") ??
    meta.get("title") ??
    null;
  // The description first, then the page's own post text, so an X thread or a tutorial
  // whose meta tags are thin still reaches the classifier as text.
  const pageText = visibleText(tree);
  const excerpt = [description, pageText].filter(Boolean).join(" ");
  return {
    title: title ? clip(title, limits.title) : null,
    site: clip(site, 120) || domainOf(finalUrl),
    excerpt: excerpt ? clip(excerpt, limits.excerpt) : null,
  };
}

/** The page behind a shared link, read through the existing public fetcher. */
export async function pageInfo(
  fetcher: FeedFetcher,
  raw: string,
  signal?: AbortSignal,
): Promise<PageInfo> {
  const url = linkUrl(raw);
  const base: PageInfo = {
    url,
    canonicalUrl: canonicalUrl(url),
    title: null,
    site: domainOf(url),
    excerpt: null,
    fetched: false,
  };
  try {
    const response = await fetcher.get(url, signal);
    // A PDF or other binary body has no markup to read: the title stays unknown, and
    // study material then becomes a question instead of an entry named "paper.pdf".
    if (looksBinary(response.body)) return base;
    const final = linkUrl(response.finalUrl);
    const meta = pageMetadata(response.body, final);
    return {
      url: final,
      canonicalUrl: canonicalUrl(final),
      ...meta,
      fetched: true,
    };
  } catch {
    // A cancelled turn must not leave a question behind: nothing was read, so no card is
    // created and nothing is written. The host records this as a validation refusal.
    if (signal?.aborted)
      throw new ToolValidationError("Task cancelled; nothing was written");
    // A blocked or empty page leaves the title unknown; the caller asks instead of guessing.
    return base;
  }
}

const ROUTE_LABEL: Record<LinkRoute, string> = {
  study: "Study material",
  reader: "Offline reading",
  both: "Study material and offline reading",
  unsure: "Not sure yet",
};
const KIND_LABEL: Record<LinkKind, string> = {
  technical: "technical reference",
  discussion: "discussion thread",
  news: "news report",
  essay: "essay",
  product: "product announcement",
  other: "page",
};
const TOPIC_LABEL: Record<LinkTopic, string> = {
  "applied-ai-engineering": "applied AI engineering",
  "agent-platforms": "agent platforms",
  "developer-tools": "developer tools",
  "voice-conversational-ai": "voice and conversational AI",
  other: "no saved learning interest",
};

export interface LinkVerdict {
  route: LinkRoute;
  /** Display topic, only when Jev's topic answer cleared the configured floor. */
  topic: string | null;
  reason: string;
  confidence: number;
  model: string | null;
  /** Why the owner is being asked, when the route became unsure. */
  unsureBecause?: "judge" | "confidence" | "title";
}

export interface LinkJudgment {
  page: PageInfo;
  route: LinkRoute;
  topic: string | null;
  reason: string;
  confidence: number;
  model: string | null;
  unsureBecause?: LinkVerdict["unsureBecause"];
  /**
   * The page had no readable title, and the owner's own words chose the destination, so it
   * is saved under the site's name and the receipt says the title could not be read.
   */
  titleUnread?: boolean;
}

/**
 * The stored topic label for Jev's learning-interest answer. `save()` and `judgeLink()`
 * use it for the route they decide; a move whose route the owner already chose uses it for
 * the topic alone, so both paths name a topic the same way and neither invents one.
 */
export function topicLabel(topic: LinkTopic | null | undefined) {
  return topic ? TOPIC_LABEL[topic] : null;
}

const percent = (p: number) => `${Math.round(p * 100)}%`;

/**
 * Jev's route, with the host's safety rules on top. A page without a readable title cannot
 * be named from its content, so study material becomes a question rather than an entry with
 * an invented title - unless the owner's own words chose the destination themselves, which
 * is a decision the host does not second-guess (the entry is named after the site and the
 * receipt says the title could not be read).
 */
export function judgeLink(
  verdict: LinkJudgeResult,
  page: PageInfo,
  minConfidence: number,
): LinkJudgment {
  if (!verdict.ok)
    return {
      page,
      route: "unsure",
      topic: null,
      reason: `Jev couldn't classify this link (${verdict.failure}), so it isn't saved yet.`,
      confidence: 0,
      model: null,
      unsureBecause: "judge",
    };
  const topic = topicLabel(verdict.topic);
  const judged = `${KIND_LABEL[verdict.kind]} on ${topic ?? "no saved learning interest"} (${percent(verdict.confidence)})`;
  if (verdict.route === "unsure")
    return {
      page,
      route: "unsure",
      topic,
      reason: `Jev was unsure what this link is: ${judged}.`,
      confidence: verdict.confidence,
      model: verdict.model,
      unsureBecause: "judge",
    };
  if (verdict.confidence < minConfidence)
    return {
      page,
      route: "unsure",
      topic,
      reason: `Jev read it as ${judged}, below the ${percent(minConfidence)} confidence needed.`,
      confidence: verdict.confidence,
      model: verdict.model,
      unsureBecause: "confidence",
    };
  if (!page.title && verdict.route !== "reader" && verdict.cue !== "explicit")
    return {
      page,
      route: "unsure",
      topic,
      reason:
        "The page title could not be read, so I can't name it from its content.",
      confidence: verdict.confidence,
      model: verdict.model,
      unsureBecause: "title",
    };
  return {
    page,
    route: verdict.route,
    topic,
    reason: `${ROUTE_LABEL[verdict.route]} — ${judged}`,
    confidence: verdict.confidence,
    model: verdict.model,
    ...(!page.title ? { titleUnread: true } : {}),
  };
}

export type { LinkJudgeInput };

/**
 * The name a save of this page is stored under. The page's own title when there is one;
 * otherwise the owner's own words chose the destination, so the site (never an invented
 * name) stands in and the receipt says the title could not be read.
 */
export function pageTitle(page: PageInfo) {
  return page.title ?? (page.site || page.url);
}
