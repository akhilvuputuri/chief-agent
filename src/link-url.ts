// Canonical form of a link the owner shares to save (docs/links.md). Kept apart from
// src/links.ts so the tool schema can refuse an unusable link before dispatch.
import { postPage, publicLink, isReddit } from "./link-resolution.js";

const TRACKING =
  /^(utm_.*|fbclid|gclid|dclid|mc_cid|mc_eid|igshid|ref_src|_ga)$/i;
const X_HOSTS = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i;

/** One canonical form per link: public HTTPS (a plain http link is upgraded), lowercase
 * host, no fragment, no tracking parameters (and X's share parameters s and t), remaining
 * parameters sorted. A Reddit post keeps only its page. Used for the study list and as the
 * exact Reader payload. Throws for a link that is not a public hostname. */
export function canonicalUrl(input: string) {
  const u = new URL(input);
  if (u.protocol === "http:") u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase();
  u.hash = "";
  const x = X_HOSTS.test(u.hostname);
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k) && !(x && (k === "s" || k === "t")))
    .sort(([a, av], [b, bv]) =>
      a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    );
  u.search = kept.length ? "?" + new URLSearchParams(kept).toString() : "";
  const href = publicLink(u.href);
  return publicLink(isReddit(href) ? postPage(href) : href);
}

/** Whether `canonicalUrl` accepts the link. */
export function savableLink(input: string) {
  try {
    canonicalUrl(input);
    return true;
  } catch {
    return false;
  }
}
