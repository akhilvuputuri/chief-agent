import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { PublicFeedFetcher, type FeedFetcher } from "./news-feed.js";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { publicHttps } from "./security.js";
import { linkResult, type LinkResult } from "./link-schema.js";

export const isReddit = (url: string) =>
  /(?:^|\.)reddit\.com$|^redd\.it$/.test(new URL(url).hostname.toLowerCase());
export function redditPostId(url: string) {
  const u = new URL(url);
  return (
    /\/comments\/([a-z0-9]+)(?:\/|$)/i.exec(u.pathname)?.[1]?.toLowerCase() ??
    (u.hostname === "redd.it"
      ? /^\/([a-z0-9]+)\/?$/i.exec(u.pathname)?.[1]?.toLowerCase()
      : undefined)
  );
}
export function publicLink(input: string) {
  const url = publicHttps(input);
  if (url.length > 2048) throw new Error("Link exceeds limits");
  return url;
}
export function postPage(url: string) {
  const u = new URL(publicLink(url));
  if (isReddit(u.href)) {
    u.search = "";
    u.hash = "";
  }
  return u.href;
}
export type PostEvidence = {
  pageUrl: string;
  postId: string | null;
  outbound: string[];
  self: boolean;
  blocked: boolean;
};
export type PublicLinkBrowser = (
  user: string,
  url: string,
  signal?: AbortSignal,
) => Promise<PostEvidence>;
export const postEvidenceSchema = z
  .object({
    pageUrl: z.string().url().max(2048),
    postId: z
      .string()
      .regex(/^[a-z0-9]+$/)
      .max(30)
      .nullable(),
    outbound: z.array(z.string().url().max(2048)).max(6),
    self: z.boolean(),
    blocked: z.boolean(),
  })
  .strict();
/** Only the exact post's metadata is evidence; comments, ads and suggested posts are ignored. */
export function postEvidence(body: string, pageUrl: string): PostEvidence {
  const expected = redditPostId(pageUrl);
  const base: PostEvidence = {
    pageUrl: postPage(pageUrl),
    postId: null,
    outbound: [],
    self: false,
    blocked: true,
  };
  if (!expected) return base;
  try {
    const data = JSON.parse(body);
    const listing = Array.isArray(data) ? data[0] : data;
    const posts = listing?.data?.children?.filter(
      (p: any) => p.kind === "t3" && p.data?.id === expected,
    );
    if (posts?.length > 1) return base;
    const post = posts?.[0]?.data;
    if (post) {
      const urls: string[] = [];
      let p = post;
      const seen = new Set<string>();
      for (let i = 0; i < 3; i++) {
        if (typeof p.id !== "string" || seen.has(p.id)) return base;
        seen.add(p.id);
        const url = p.url_overridden_by_dest ?? p.url;
        if (typeof url === "string" && !isReddit(new URL(url, pageUrl).href)) {
          urls.push(new URL(url, pageUrl).href);
          break;
        }
        if (!p.crosspost_parent_list?.length) break;
        if (
          p.crosspost_parent_list.length !== 1 ||
          p.crosspost_parent !== "t3_" + p.crosspost_parent_list[0]?.id
        )
          return base;
        p = p.crosspost_parent_list[0];
      }
      return {
        ...base,
        postId: expected,
        outbound: urls,
        self: !!p.is_self,
        blocked: false,
      };
    }
  } catch {}
  const nodes: DefaultTreeAdapterMap["node"][] = [parse(body)];
  const matching: DefaultTreeAdapterMap["element"][] = [];
  while (nodes.length) {
    const node = nodes.pop()!;
    if (
      "tagName" in node &&
      node.tagName === "shreddit-post" &&
      node.attrs.some(
        (a) =>
          ["id", "thingid"].includes(a.name) && a.value === "t3_" + expected,
      )
    )
      matching.push(node);
    // Templates, comments and raw-text elements do not contribute fake elements.
    if ("childNodes" in node) nodes.push(...node.childNodes);
  }
  if (matching.length === 1) {
    const a = Object.fromEntries(
      matching[0]!.attrs.map((a) => [a.name, a.value]),
    );
    if ([a.id, a.thingid].some((id) => id && id !== "t3_" + expected))
      return base;
    const href = a["content-href"];
    try {
      return {
        ...base,
        postId: expected,
        outbound: href ? [new URL(href, pageUrl).href] : [],
        self: a["post-type"] === "text",
        blocked: false,
      };
    } catch {
      return base;
    }
  }
  return base;
}
export class LinkResolver {
  constructor(
    private db: Database,
    private fetcher: FeedFetcher = new PublicFeedFetcher(),
    private browser?: PublicLinkBrowser,
  ) {}
  async resolve(
    user: string,
    input: string,
    target: "article" | "discussion" = "article",
    signal?: AbortSignal,
  ): Promise<LinkResult & { resolutionId: string }> {
    signal = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(45000),
    ]);
    const originalUrl = publicLink(input);
    if (signal?.aborted) throw new Error("Task cancelled");
    const cached = (
      await this.db.query(
        "SELECT id,result FROM link_resolutions WHERE user_id=$1 AND original_url=$2 AND target=$3 AND expires_at>now() ORDER BY created_at DESC LIMIT 1",
        [user, originalUrl, target],
      )
    ).rows[0];
    if (cached)
      return { ...linkResult.parse(cached.result), resolutionId: cached.id };
    let result: LinkResult = {
      originalUrl,
      pageUrl: null,
      articleUrl: null,
      status: "blocked",
      method: "http",
      reason:
        "The public page could not be verified; supply its publisher URL or explicitly save the discussion.",
      candidates: [],
      observedAt: new Date().toISOString(),
    };
    if (target === "discussion" && isReddit(originalUrl))
      result = {
        ...result,
        pageUrl: postPage(originalUrl),
        status: "discussion",
        reason: "The owner explicitly selected the Reddit discussion.",
      };
    else {
      let evidence: PostEvidence | undefined;
      let destination = originalUrl;
      try {
        const response = await this.fetcher.get(originalUrl, signal, (url) => {
          destination = publicLink(url);
        });
        const final = publicLink(response.finalUrl);
        destination = final;
        if (!isReddit(final))
          result = {
            ...result,
            pageUrl: final,
            articleUrl: final,
            status: "resolved",
            reason: "Public HTTPS destination verified.",
          };
        else evidence = postEvidence(response.body, final);
      } catch {}
      if (target === "discussion" && isReddit(destination)) {
        result = {
          ...result,
          pageUrl: postPage(destination),
          status: "discussion",
          reason: "The owner explicitly selected the Reddit discussion.",
        };
        evidence = undefined;
      }
      if (
        !isReddit(originalUrl) &&
        !isReddit(destination) &&
        !evidence &&
        result.status === "blocked"
      ) {
        result = {
          ...result,
          pageUrl: originalUrl,
          articleUrl: originalUrl,
          status: "resolved",
          method: "owner_provided",
          reason:
            "The owner supplied this public publisher URL; fetching was blocked, so Reader will attempt extraction.",
        };
      }
      if (
        isReddit(destination) &&
        result.status !== "discussion" &&
        (!evidence || evidence.blocked) &&
        this.browser &&
        !signal?.aborted
      ) {
        try {
          evidence = postEvidenceSchema.parse(
            await this.browser(user, destination, signal),
          );
          result.method = "browser";
        } catch {}
      }
      if (
        evidence &&
        !evidence.blocked &&
        isReddit(evidence.pageUrl) &&
        evidence.postId === redditPostId(evidence.pageUrl) &&
        (!redditPostId(originalUrl) ||
          redditPostId(originalUrl) === evidence.postId)
      ) {
        let candidates: string[];
        try {
          candidates = [
            ...new Set(
              evidence.outbound
                .map((url) => publicLink(url))
                .filter((url) => !isReddit(url)),
            ),
          ].slice(0, 6);
        } catch {
          evidence.blocked = true;
          candidates = [];
        }
        if (evidence.blocked) {
          result.reason =
            "The selected post's destination was unsafe or malformed; no article was verified.";
        } else {
          result = {
            ...result,
            pageUrl: postPage(evidence.pageUrl),
            candidates,
            ...(candidates.length === 1 && !evidence.self
              ? {
                  articleUrl: candidates[0]!,
                  status: "resolved" as const,
                  reason:
                    "Publisher URL is explicitly linked by the selected Reddit post.",
                }
              : {
                  status: candidates.length
                    ? ("ambiguous" as const)
                    : ("discussion" as const),
                  reason:
                    "No single publisher article was verified; choose the discussion or supply the article URL.",
                }),
          };
        }
      }
    }
    if (signal?.aborted) throw new Error("Task cancelled");
    const resolutionId = randomUUID();
    await this.db.query(
      "INSERT INTO link_resolutions(id,user_id,original_url,target,result,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,now()+interval '15 minutes')",
      [
        resolutionId,
        user,
        originalUrl,
        target,
        JSON.stringify(linkResult.parse(result)),
      ],
    );
    return { ...result, resolutionId };
  }
}
