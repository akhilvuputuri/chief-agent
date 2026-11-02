// A shared link is classified before it is saved: study material for the study list, or
// long-form reading for Reader. TypeSafe's Jev decision model makes that judgment from the
// page's own metadata and text, the owner's words and the saved learning interests; nothing
// here decides by keyword. config/link-routing.json holds the question and thresholds and
// deliberately has no model id: the classifier asks the picker config which Jev snapshot to
// use, so this path can never diverge onto another model.
import { readFileSync } from "node:fs";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import type { FeedFetcher } from "./news-feed.js";
import { publicLink } from "./link-resolution.js";
import type { Spending } from "./spending.js";
import { readPickerConfig } from "./tool-picker.js";

const text = z.string().min(1).max(2000);
const count = z.number().int().positive();
const probability = z.number().min(0).max(1);
const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    timeoutMs: count,
    cardTtlMinutes: count,
    state: z
      .object({
        ownerMessageChars: count,
        pageTitleChars: count,
        pageSiteChars: count,
        pageTopicChars: count,
        pageExcerptChars: count,
      })
      .strict(),
    // The owner's saved learning interests: context for the judgment, never a rule.
    interests: z.array(text).min(1).max(10),
    question: z
      .object({
        instructions: text,
        criteria: z.object({ study: text, reader: text }).strict(),
      })
      .strict(),
    cue: z
      .object({
        instructions: text,
        criteria: z.object({ true: text, false: text }).strict(),
      })
      .strict(),
    // The lowest probability at which a destination is applied; below it Chief asks.
    apply: z
      .object({ study: probability, reader: probability, cue: probability })
      .strict(),
  })
  .strict();
export type LinkRoutingConfig = z.infer<typeof configSchema>;

/** Parse a routing config; a `model` key or any unknown field is rejected. */
export function parseLinkRouting(raw: unknown): LinkRoutingConfig {
  return configSchema.parse(raw);
}

export function readLinkRouting(
  url: URL = new URL("../config/link-routing.json", import.meta.url),
): LinkRoutingConfig {
  return parseLinkRouting(JSON.parse(readFileSync(url, "utf8")));
}

/** The single source of truth for the classification model: the picker's Jev snapshot. */
export function jevModel(): string {
  return readPickerConfig().model;
}

export type LinkVerdict = "study" | "reader" | "unsure";

/** Page metadata read from the page itself; absent fields were not published. */
export interface PageFacts {
  /** The verified public URL the page resolved to. */
  url: string;
  readable: boolean;
  title?: string;
  site?: string;
  topic?: string;
  tags: string[];
  excerpt?: string;
}

export interface LinkFacts {
  url: string;
  ownerMessage?: string;
  page: PageFacts;
}

const clip = (value: string, n: number) => {
  const points = [...value];
  return points.length > n ? points.slice(0, n).join("") : value;
};

export function siteOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url.slice(0, 80);
  }
}

/**
 * Comparison key for duplicate detection: host and path without a trailing slash,
 * tracking parameters or fragment. Case and www never distinguish two links.
 */
export function linkKey(url: string) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const params = new URLSearchParams(u.search);
  for (const name of [...params.keys()])
    if (
      /^(utm_.+|fbclid|gclid|igshid|mc_cid|mc_eid|ref|ref_src|ref_url|s|t|si)$/i.test(
        name,
      )
    )
      params.delete(name);
  const path = u.pathname.replace(/\/+$/, "") || "/";
  const query = params.toString();
  return `${host}${path}${query ? `?${query}` : ""}`;
}

/** What Jev sees: the page's own words, the owner's words and the saved interests. */
export function linkState(config: LinkRoutingConfig, facts: LinkFacts) {
  const s = config.state;
  return {
    link: {
      url: facts.page.url,
      site: siteOf(facts.page.url),
      title: facts.page.title ? clip(facts.page.title, s.pageTitleChars) : null,
      topic: facts.page.topic ? clip(facts.page.topic, s.pageTopicChars) : null,
      text: facts.page.excerpt
        ? clip(facts.page.excerpt, s.pageExcerptChars)
        : null,
      readable: facts.page.readable,
    },
    owner_message: facts.ownerMessage
      ? clip(facts.ownerMessage, s.ownerMessageChars)
      : "",
    saved_interests: [...config.interests],
  };
}

export function linkQuestions(config: LinkRoutingConfig) {
  return {
    destination: {
      type: "choice",
      instructions: config.question.instructions,
      criteria: config.question.criteria,
    },
    cue: {
      type: "noul",
      instructions: config.cue.instructions,
      criteria: config.cue.criteria,
    },
  };
}

/** Jev's answer, validated; undefined fields were missing or malformed. */
export interface LinkAnswer {
  choice: "study" | "reader";
  probabilities: Partial<Record<"study" | "reader", number>>;
  cue?: number;
}

const unit = (value: unknown): number | undefined =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1
    ? Math.round(value * 10_000) / 10_000
    : undefined;

/** A malformed destination answer is not a verdict; the caller asks instead. */
export function linkAnswer(answers: any): LinkAnswer | undefined {
  const choice: unknown = answers?.destination?.choice;
  const raw = answers?.destination?.probabilities;
  if (choice !== "study" && choice !== "reader") return undefined;
  const probabilities: Partial<Record<"study" | "reader", number>> = {};
  for (const d of ["study", "reader"] as const) {
    const p = unit(raw?.[d]);
    if (p !== undefined) probabilities[d] = p;
  }
  if (probabilities[choice] === undefined) return undefined;
  const cue = unit(answers?.cue?.noul);
  return { choice, probabilities, ...(cue === undefined ? {} : { cue }) };
}

export interface LinkDecision {
  verdict: LinkVerdict;
  /** Jev's own destination before the thresholds. */
  choice?: "study" | "reader";
  probabilities: Partial<Record<"study" | "reader", number>>;
  /** Probability of the applied destination; 0 when the verdict is unsure. */
  confidence: number;
  cue?: number;
  /** Why the verdict was applied: the owner's explicit words, or Jev's own reading. */
  via?: "cue" | "reading";
}

/**
 * The application rule, pure and config-driven. An explicit owner cue wins outright, then
 * Jev's own destination once it clears its threshold; anything else is unsure. A failed or
 * unreadable answer can therefore never become a Reader save.
 */
export function linkDecision(
  config: LinkRoutingConfig,
  answers: any,
): LinkDecision {
  const answer = linkAnswer(answers);
  const probabilities: Partial<Record<"study" | "reader", number>> =
    answer?.probabilities ?? {};
  if (!answer) return { verdict: "unsure", probabilities, confidence: 0 };
  const confidence = probabilities[answer.choice]!;
  if (answer.cue !== undefined && answer.cue >= config.apply.cue)
    return {
      verdict: answer.choice,
      choice: answer.choice,
      probabilities,
      // The cue decided it, so the cue's probability is that decision's confidence.
      confidence: answer.cue,
      cue: answer.cue,
      via: "cue",
    };
  if (confidence >= config.apply[answer.choice])
    return {
      verdict: answer.choice,
      choice: answer.choice,
      probabilities,
      confidence,
      ...(answer.cue === undefined ? {} : { cue: answer.cue }),
      via: "reading",
    };
  return {
    verdict: "unsure",
    choice: answer.choice,
    probabilities,
    confidence,
    ...(answer.cue === undefined ? {} : { cue: answer.cue }),
  };
}

export interface LinkClassification extends LinkDecision {
  ok: boolean;
  model: string | null;
  latencyMs: number;
  costUsd: number | null;
  error?: string;
}

/** Jev over one link. Never throws and never returns a reader verdict on failure. */
export class LinkClassifier {
  constructor(
    private key: string,
    readonly config: LinkRoutingConfig = readLinkRouting(),
    private transport: typeof fetch = fetch,
    /** Overridable only so a test can prove the id comes from the picker config. */
    readonly model: string = jevModel(),
  ) {}

  async classify(
    facts: LinkFacts,
    ledger?: Spending,
  ): Promise<LinkClassification> {
    const started = Date.now();
    let charge: string | undefined;
    // Usage accounting never decides the verdict; its failures are ignored.
    const settle = (usage: unknown) =>
      charge ? ledger!.settle(charge, usage).catch(() => {}) : undefined;
    const unsure = (error: string): LinkClassification => ({
      ok: false,
      verdict: "unsure",
      probabilities: {},
      confidence: 0,
      latencyMs: Date.now() - started,
      costUsd: null,
      model: null,
      error,
    });
    try {
      charge = await ledger
        ?.begin("openrouter-jev", 0.001)
        .catch(() => undefined);
      const response = await this.transport(
        "https://openrouter.ai/api/alpha/decisions",
        {
          method: "POST",
          signal: AbortSignal.timeout(this.config.timeoutMs),
          headers: {
            Authorization: `Bearer ${this.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            state: linkState(this.config, facts),
            questions: linkQuestions(this.config),
          }),
        },
      );
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500)
          await settle({ cost: 0 });
        return unsure(`http_${response.status}`);
      }
      const data: any = await response.json();
      await settle(data?.usage);
      // An answer that names no destination is a failed classification, not a guess.
      if (!linkAnswer(data?.answers)) return unsure("invalid");
      const decision = linkDecision(this.config, data?.answers);
      const cost = data?.usage?.cost;
      return {
        ...decision,
        ok: true,
        latencyMs: Date.now() - started,
        costUsd:
          typeof cost === "number" && Number.isFinite(cost) ? cost : null,
        model: typeof data?.model === "string" ? data.model : this.model,
      };
    } catch (error) {
      return unsure(
        (error as Error)?.name === "TimeoutError" ? "timeout" : "failed",
      );
    }
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};
export function decodeEntities(value: string) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code =
        name[1]?.toLowerCase() === "x"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const clean = (value: string | undefined) =>
  value === undefined
    ? undefined
    : decodeEntities(value).replace(/\s+/g, " ").trim() || undefined;

/** The page's own published metadata: never a guessed title or topic. */
export function pageMetadata(html: string, pageUrl: string) {
  const meta = new Map<string, string>();
  const paragraphs: string[] = [];
  let title: string | undefined;
  const skip = new Set(["script", "style", "template", "noscript", "svg"]);
  const walk = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node) {
      if (skip.has(node.tagName)) return;
      const attrs = Object.fromEntries(
        node.attrs.map((a) => [a.name.toLowerCase(), a.value]),
      );
      if (node.tagName === "meta") {
        const name = (attrs.property ?? attrs.name ?? "").toLowerCase();
        if (name && attrs.content && !meta.has(name))
          meta.set(name, attrs.content);
      }
      if (node.tagName === "p") {
        const value = clean(nodeText(node));
        if (value && value.length > 40) paragraphs.push(value);
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) walk(child);
    if ("tagName" in node && node.tagName === "title" && title === undefined)
      title = clean(nodeText(node));
  };
  walk(parse(html));
  const host = siteOf(pageUrl);
  return {
    url: pageUrl,
    readable: true,
    title: clean(meta.get("og:title") ?? meta.get("twitter:title")) ?? title,
    site: clean(meta.get("og:site_name")) ?? host,
    topic: clean(
      meta.get("article:section") ??
        meta.get("og:article:section") ??
        meta.get("section"),
    ),
    tags: (meta.get("keywords") ?? "")
      .split(",")
      .map((t) => clean(t)?.slice(0, 40))
      .filter((t): t is string => !!t)
      .slice(0, 5),
    excerpt: clean(
      [
        meta.get("og:description") ??
          meta.get("twitter:description") ??
          meta.get("description"),
        ...paragraphs,
      ]
        .filter(Boolean)
        .join(" "),
    ),
  } satisfies Omit<PageFacts, "tags"> & { tags: string[] };
}

function nodeText(node: DefaultTreeAdapterMap["node"]): string {
  if ("value" in node) return node.value;
  if (!("childNodes" in node)) return "";
  return node.childNodes.map(nodeText).join(" ");
}

/**
 * Read the page's own title, site, topic and text through the same SSRF-guarded fetcher
 * the feed reader uses. A page that cannot be read stays unreadable: Chief then classifies
 * from the URL and the owner's words, and asks unless that judgment is confident.
 */
export async function readLinkPage(
  input: string,
  fetcher: FeedFetcher,
  signal?: AbortSignal,
): Promise<PageFacts> {
  const start = publicLink(input);
  try {
    let destination = start;
    const response = await fetcher.get(start, signal, (url) => {
      destination = publicLink(url);
    });
    const final = publicLink(response.finalUrl ?? start);
    const facts = pageMetadata(response.body.slice(0, 500_000), final);
    return { ...facts, url: final };
  } catch {
    return { url: start, readable: false, site: siteOf(start), tags: [] };
  }
}

/**
 * A host-composed record of why the item went where it did. Jev answers with a choice and
 * probabilities, not prose, so the reason states the evidence and the score instead of
 * inventing a rationale.
 */
export function linkReason(
  config: LinkRoutingConfig,
  facts: LinkFacts,
  decision: LinkDecision,
  ownerMessage?: string,
) {
  const page = facts.page;
  const what = page.title
    ? `"${clip(page.title, 120)}"${page.site ? ` on ${page.site}` : ""}`
    : `the link ${page.url}`;
  if (decision.verdict === "unsure")
    return `Unsure whether ${what} is study material or offline reading${
      decision.choice
        ? ` (${decision.choice} ${Math.round(decision.confidence * 100)}%)`
        : ""
    }; the owner was asked where to save it.`;
  const where = decision.verdict === "study" ? "the study list" : "Reader";
  if (decision.via === "cue") {
    const words = (ownerMessage ?? facts.ownerMessage ?? "").trim();
    return `You said ${words ? `"${clip(words, 160)}"` : "where it should go"}, so ${what} went to ${where}.`;
  }
  const interests = config.interests.slice(0, 4).join(", ");
  return `${what} reads as ${
    decision.verdict === "study" ? "study material" : "offline reading"
  } (${Math.round(decision.confidence * 100)}%); ${
    decision.verdict === "study"
      ? `it fits your learning interests (${interests})`
      : "it is reading rather than study"
  }.`;
}
