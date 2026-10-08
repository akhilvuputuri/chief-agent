# Public link resolution and Reader targets

Chief's owner-scoped `link_resolve(url, target?)` returns the submitted URL,
verified public page/publisher destination, status, evidence method, observation
time and private resolution ID. Article is the default target; discussion keeps
the explicitly selected Reddit URL. HTTP redirects use the existing public-only,
DNS-pinned feed fetcher with cancellation, byte/hop limits and a shared deadline.

For Reddit, evidence comes only from the selected post's structured metadata or
`shreddit-post` outbound destination, matched to its canonical post ID. Structured
crosspost parents are bounded and their relationship must match. Ads, comments,
suggested posts and title-search guesses are not article evidence. An ambiguous,
self-post or blocked response never becomes an invented publisher URL.

The anonymous browser fallback is a separate fixed `resolve_public` RPC command.
It accepts only public Reddit post/share paths, uses a fresh context without
storage state, denies non-GET requests, account routes, downloads, service workers
and web sockets, bounds resource requests/navigation/time, and returns only post
metadata. It never exposes arbitrary JavaScript or click/form commands. Existing
invoice contexts and their positive route inventory remain unchanged. Public
resolution returns blocked while invoice sessions occupy the service. Public
egress uses the existing DNS-pinned proxy and Chromium sandbox; it is not a
CAPTCHA or network-access bypass.

On 8 October 2026, the supplied share link resolved to its Euronews publisher in
the local browser. The same anonymous production browser returned HTTP 403 with
no post; the public-page reader returned a network-security block page. This is
one measured link/environment sample, not evidence that every Reddit link fails
or that the server browser can universally resolve them. Blocked cases need a
publisher URL or a verified owner observation. Authenticated Reddit access is
separate future work, not a credential fallback added here.

Migration 031 adds immutable private resolution records and original-intent/frozen
destination fields to `mcp_operations`. Successful/blocked results are cached for
15 minutes within one owner/target. An operator can import a bounded, previously
observed owner resolution with its actual observation time and explicit expiry;
the resolver labels it `owner_verified` and does not claim fresh network evidence.
No model operation can create those trusted records directly.

Reader save_link resolves articles before its first dispatch and preserves the
original arguments, article/discussion choice and resolution snapshot alongside
the wire payload. Replays use that frozen wire payload, including after timeout,
restart, post edits or cache expiry. A race re-reads the winning persisted payload
before dispatch. Old saved operations retain their original behavior; unknown
writes, owner isolation and cancellation still apply. Ordinary publisher URLs
that cannot be fetched remain labelled `owner_provided`, leaving extraction to
Reader. Generic MCP transport and other remote-server operations remain unchanged.

## Deployment

Use the reviewed additive operator procedure: install only migration 031, preserve
historical SQL/data/environment/paused tasks and require an idle gateway under the
existing release lock. Compose only adds031 to the inventory. Build the exact
reviewed/merged gateway and browser images, run the existing browser sandbox smoke
plus the anonymous-context/mutation-denial extraction smoke, and refuse sidecar
replacement while invoice sessions are active. Keep the proxy image/network/key,
seccomp profile, capabilities, ingress and other feature flags unchanged. Record
the exact browser image ID separately; a normal gateway release does not upgrade
that sidecar. On failure restore previous gateway/browser/source/Compose and
verify identities/health; retain the additive journal and never reset data or
overwrite a newer environment file. Watch the subsequent exact-main release.

The same host resolver is used from cloud/local code and production; it does not
require the Mac browser session. Sidecar replacement remains a reviewed operator
step; shared automated sidecar versioning is a remaining cloud operations gap.
