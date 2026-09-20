/**
 * The only module that names the OverDrive hosts. Every outbound library request
 * is built from one of these entries, so the (method, path) inventory below is the
 * complete surface: no return, renew, download, fulfilment or card login route exists.
 */
const THUNDER = "https://thunder.api.overdrive.com";
const SENTRY = "https://sentry.libbyapp.com";
export const libraryKey = "nlb";
export const websiteId = 106;
export type RouteHost = "thunder" | "sentry";
export type RouteKind = "read" | "write" | "link" | "identity";
export interface RouteEntry {
  host: RouteHost;
  method: "GET" | "POST" | "DELETE";
  kind: RouteKind;
  /** Only re-mint runs without an owner tap; every other write follows an approval. */
  unattended?: true;
  template: string;
  pattern: RegExp;
}
const entry = (
  host: RouteHost,
  method: RouteEntry["method"],
  kind: RouteKind,
  template: string,
  unattended?: true,
): RouteEntry => ({
  host,
  method,
  kind,
  template,
  pattern: new RegExp(
    "^" +
      template
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\{[a-zA-Z]+\\\}/g, "[A-Za-z0-9_-]+") +
      "$",
  ),
  ...(unattended ? { unattended } : {}),
});
export const routes = {
  libraryInfo: entry("thunder", "GET", "read", `/v2/libraries/${libraryKey}`),
  mediaSearch: entry(
    "thunder",
    "GET",
    "read",
    `/v2/libraries/${libraryKey}/media`,
  ),
  mediaInfo: entry(
    "thunder",
    "GET",
    "read",
    `/v2/libraries/${libraryKey}/media/{titleId}`,
  ),
  mediaAvailability: entry(
    "thunder",
    "GET",
    "read",
    `/v2/libraries/${libraryKey}/media/availability`,
  ),
  chipMint: entry("sentry", "POST", "identity", "/chip", true),
  chipCloneCode: entry("sentry", "GET", "link", "/chip/clone/code"),
  chipCloneEnter: entry("sentry", "POST", "link", "/chip/clone/code"),
  chipClone: entry("sentry", "POST", "link", "/chip/clone"),
  chipSync: entry("sentry", "GET", "read", "/chip/sync"),
  chipRevoke: entry("sentry", "POST", "write", "/chip/revoke"),
  loanCreate: entry("sentry", "POST", "write", "/card/{cardId}/loan/{titleId}"),
  holdCreate: entry("sentry", "POST", "write", "/card/{cardId}/hold/{titleId}"),
  holdDelete: entry(
    "sentry",
    "DELETE",
    "write",
    "/card/{cardId}/hold/{titleId}",
  ),
} as const;
export type RouteKey = keyof typeof routes;
export const hosts: Record<RouteHost, string> = {
  thunder: THUNDER,
  sentry: SENTRY,
};
declare const permittedBrand: unique symbol;
export type PermittedUrl = URL & { readonly [permittedBrand]: true };
/** Builds a URL for a known route. Path parameters are validated; nothing else can produce a PermittedUrl. */
export function permitted(
  key: RouteKey,
  params: Record<string, string> = {},
  query: Record<string, string> = {},
): PermittedUrl {
  const route = routes[key];
  const path = route.template.replace(/\{([a-zA-Z]+)\}/g, (_, name) => {
    const value = params[name];
    if (!value || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
      throw new Error("Library validation: route not permitted");
    return value;
  });
  if (!route.pattern.test(path))
    throw new Error("Library validation: route not permitted");
  const url = new URL(hosts[route.host] + path);
  for (const [k, v] of Object.entries(query))
    if (v !== "") url.searchParams.set(k, v);
  return url as PermittedUrl;
}
export function routeFor(url: URL, method: string): RouteKey | null {
  for (const [key, route] of Object.entries(routes) as [RouteKey, RouteEntry][])
    if (
      url.origin === hosts[route.host] &&
      route.method === method &&
      route.pattern.test(url.pathname)
    )
      return key;
  return null;
}
