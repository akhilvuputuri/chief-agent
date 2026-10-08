import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import {
  decodeEntities,
  PublicFeedFetcher,
  type FeedFetcher,
} from "./news-feed.js";
import { publicHttps } from "./security.js";
import { linkResult, type LinkResult } from "./link-schema.js";

export const isReddit = (url: string) =>
  /^(?:www\.|old\.|new\.)?reddit\.com$|^redd\.it$/.test(
    new URL(url).hostname.toLowerCase(),
  );
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
function attrs(tag: string) {
  return Object.fromEntries(
    [...tag.matchAll(/([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(
      (m) => [m[1]!.toLowerCase(), decodeEntities(m[2] ?? m[3] ?? "")],
    ),
  );
}
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
    const post = listing?.data?.children?.find(
      (p: any) => p.kind === "t3" && p.data?.id === expected,
    )?.data;
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
  for (const match of body.matchAll(/<shreddit-post\b([^>]{0,16000})>/gi)) {
    const a = attrs(match[1]!);
    if (a.id !== "t3_" + expected && a["thingid"] !== "t3_" + expected)
      continue;
    const href = a["content-href"];
    return {
      ...base,
      postId: expected,
      outbound: href ? [new URL(href, pageUrl).href] : [],
      self: a["post-type"] === "text",
      blocked: false,
    };
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
      try {
        const response = await this.fetcher.get(originalUrl, signal);
        const final = publicLink(response.finalUrl);
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
      if (!isReddit(originalUrl) && result.status === "blocked") {
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
        isReddit(originalUrl) &&
        (!evidence || evidence.blocked) &&
        this.browser &&
        !signal?.aborted
      ) {
        try {
          evidence = await this.browser(user, originalUrl, signal);
          result.method = "browser";
        } catch {}
      }
      if (
        evidence &&
        !evidence.blocked &&
        evidence.postId === redditPostId(evidence.pageUrl) &&
        (!redditPostId(originalUrl) ||
          redditPostId(originalUrl) === evidence.postId)
      ) {
        const candidates = [
          ...new Set(
            evidence.outbound
              .map((url) => publicLink(url))
              .filter((url) => !isReddit(url)),
          ),
        ].slice(0, 6);
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
