import { setTimeout as delay } from "node:timers/promises";
import type { Browser, BrowserContext } from "playwright-core";
import { publicHttps } from "../security.js";

const redditHost = (url: string) =>
  /^(?:www\.|old\.|new\.)?reddit\.com$|^redd\.it$/.test(new URL(url).hostname);
export function publicPostUrl(input: string) {
  const url = new URL(publicHttps(input));
  if (
    url.href.length > 2048 ||
    !redditHost(url.href) ||
    !(
      /^\/r\/[a-z0-9_]+\/(?:s\/[a-z0-9]+|comments\/[a-z0-9]+(?:\/[^?#]*)?)\/?$/i.test(
        url.pathname,
      ) ||
      /^\/comments\/[a-z0-9]+(?:\/[^?#]*)?$/i.test(url.pathname) ||
      (url.hostname === "redd.it" && /^\/[a-z0-9]+\/?$/i.test(url.pathname))
    )
  )
    throw new Error("Unsupported public post");
  url.search = "";
  url.hash = "";
  return url.href;
}
export function publicPostRequest(url: string, method: string, type: string) {
  try {
    const u = new URL(publicHttps(url));
    if (
      method !== "GET" ||
      !["document", "script", "stylesheet", "xhr", "fetch"].includes(type) ||
      /(?:^|\.)(?:reddit\.com|redditstatic\.com|redditmedia\.com|redd\.it)$/.test(
        u.hostname,
      ) === false
    )
      return false;
    if (
      /\/(?:login|logout|register|submit|vote|message|delete|subscribe|unsubscribe|preferences|settings)(?:\/|$)/i.test(
        u.pathname,
      ) ||
      [...u.searchParams.keys()].some((k) =>
        /^(?:action|mutation|command|cmd|operation)$/i.test(k),
      )
    )
      return false;
    return true;
  } catch {
    return false;
  }
}
/** One anonymous context, no owner storage, downloads, forms, clicks or caller-written JS. */
export async function readPublicPost(browser: Browser, input: string) {
  const url = publicPostUrl(input);
  let context: BrowserContext | undefined;
  const result = {
    pageUrl: url,
    postId: null as string | null,
    outbound: [] as string[],
    self: false,
    blocked: true,
  };
  try {
    context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    let navigations = 0,
      requests = 0;
    await context.route("**/*", async (route) => {
      const r = route.request();
      if (
        ++requests > 100 ||
        !publicPostRequest(r.url(), r.method(), r.resourceType()) ||
        (r.isNavigationRequest() && ++navigations > 5)
      )
        return route.abort();
      return route.fallback();
    });
    await context.routeWebSocket("**", (socket) => socket.close());
    const page = await context.newPage();
    page.on("dialog", (d) => void d.dismiss());
    page.on("download", (d) => void d.cancel());
    await page
      .goto(url, { waitUntil: "domcontentloaded", timeout: 20000 })
      .catch(() => {});
    await page
      .waitForSelector("shreddit-post", { timeout: 5000 })
      .catch(() => {});
    const final = new URL(publicPostUrl(page.url()));
    const expected =
      /\/comments\/([a-z0-9]+)/i.exec(final.pathname)?.[1]?.toLowerCase() ??
      (final.hostname === "redd.it" ? final.pathname.slice(1) : undefined);
    if (!expected) return result;
    const evidence = await Promise.race([
      page.evaluate((id) => {
        const posts = [...document.querySelectorAll("shreddit-post")];
        const post = posts.find(
          (p) =>
            p.getAttribute("id") === "t3_" + id ||
            p.getAttribute("thingid") === "t3_" + id,
        );
        if (!post) return null;
        const href = post.getAttribute("content-href");
        const outbound = href
          ? [href]
          : [
              ...post.querySelectorAll(
                'a[slot="post-media-container"],a[slot="full-post-link"],a[slot="post-link"]',
              ),
            ]
              .map((a) => (a as HTMLAnchorElement).href)
              .slice(0, 6);
        return {
          postId: id,
          outbound,
          self: post.getAttribute("post-type") === "text",
        };
      }, expected),
      delay(2000, null),
    ]);
    if (evidence) return { ...evidence, pageUrl: final.href, blocked: false };
    return result;
  } finally {
    if (context)
      await Promise.race([context.close().catch(() => {}), delay(2000)]);
  }
}
