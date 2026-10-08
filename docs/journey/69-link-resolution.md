# 69 — Can shared Reddit links preserve their publisher target?

Work date(s): 2026-10-08. Written/revised: 2026-10-08.
Status: released v0.3.47; exact release/health and bounded Reader acceptance verified.

## User-visible problem and preceding iteration

The [MCP connector iteration](67-mcp-connectors.md) connected Reader and verified
direct-link/brief saves. A copied Reddit share link can first open a post, whose
publisher article is a different URL. Saving the supplied URL alone can therefore
retain the discussion instead of the article the owner intends.

## Evidence

Measured on 8 October 2026: one supplied public Reddit share link exposed its
Euronews outbound link in a local browser. A fresh anonymous production browser
through the existing public proxy returned HTTP 403 and no post metadata. The
existing public-page reader also returned a network-security block page. No login,
CAPTCHA action, model call, account write or invoice-session access occurred.
These measurements do not establish universal production Reddit access.

Synthetic tests verify exact-post metadata, exclusion of ads/comments, structured
crosspost identity, owner-scoped observations, blocked/ambiguous behavior, anonymous
browser network policy, cancellation and frozen Reader wire-payload retries.

## Diagnosis and alternatives

Ordinary redirect following only reaches the post, not necessarily its publisher.
Resolution needs evidence of the post's own outbound link. Host inference from a
similar headline would replace the selected target. A separate anonymous browser
command preserves invoice permissions; blocked pages stay blocked. Bounded verified
owner observations can bridge a known link without hardcoding it into source.

## Implementation and review

See [contract and deployment](../link-resolution.md). Migration 031 retains
owner-scoped resolution provenance and both original intent and frozen MCP wire
payload. Public HTTP requests retain pinned-DNS protection and add cancellation.
The browser command has no login/storage/form/model-JavaScript capability. Reader
replays use the persisted winner; generic transport and unrelated grants stay intact.

Independent GPT-6 Astra review of `cea0e83` requested changes for shortener/mobile
Reddit classification, pseudo-elements/conflicting selected-post nodes, discussion
retry target retention, browser cancellation and redirect/error response drainage.
The corrected candidate retains observed redirect destinations even on HTTP errors,
uses parse5 actual HTML nodes and rejects duplicates, preserves an omitted retry
target, propagates RPC disconnect/deadline cancellation into browser queues/contexts,
and destroys redirect/error streams. Changes to the browser image require separate
reviewed sandbox proof and operator installation. See [PR #185](https://github.com/akhilvuputuri/chief-agent/pull/185).

## Verification and outcome

The initial full local checks/build/format and 27 focused tests passed. The first
Linux CI browser smoke exposed reuse of a closed synthetic browser; the smoke now
uses a separate manager for the anonymous context and tests active/queued cancellation
and conflicting metadata. Local Docker export failed with a storage I/O error; shared
Docker state was preserved. The second review of `608cfa9` additionally found discussion intent lost through a
shortener and context-creation cancellation ignored. The corrected 31 focused tests
pass, including a stalled startup/late-context regression. Context cleanup failures
retire the isolated browser process; cancelled launches cannot start page work.
Actual Chromium smoke then exposed a pending `newPage` promise after cancellation
and completed context closure; the independent reviewer reproduced it separately.
All setup/page protocol awaits now race cancellation. A new pending-page regression
passes, and the disposable smoke has a 90-second watchdog to avoid indefinite CI.
The previous approval was superseded by fresh review of the corrected head. The
measured production anonymous block remains a limitation; final live acceptance
uses explicitly labelled owner observation evidence, as recorded below.

## Follow-up

Anonymous links that remain blocked need their publisher URL or a future
authorized Reddit API connection. Browser/proxy automatic release parity remains
separate infrastructure work. Phone offline and paid semantic tests are separate.

## Release closure — 8 October 2026

Independent Codex review, dispatched as GPT-6 Astra, approved exact head
`c0a35cbf440be5f3d3924006a66d3d08e9d751e1` after the real-Chromium cancellation
fix. The reviewer independently passed all 32 focused tests, typecheck/whitespace
and a real-Chrome probe: both cancelled calls rejected, one context was created and
none remained. [PR CI](https://github.com/akhilvuputuri/chief-agent/actions/runs/37739229504)
passed 830 application, 50 script, 42 offline evaluation and 32 coding-runtime tests,
plus real Chromium sandbox/cancellation and PostgreSQL isolation proofs. Devin
review passed. No paid semantic evaluation ran.

[PR #185](https://github.com/akhilvuputuri/chief-agent/pull/185) merged at
`df3c08848c268e23f83c82303ecc31615d096ad4`, with the same tree as the approved head.
The separately reviewed operator artifact installed only migration 031 and the
reviewed gateway/browser images from a checksum-verified exact-commit archive.
Its fresh network-none browser proof passed; environment, proxy, browser security
boundary and paused-data preservation checks passed. Separate current-health,
marker-31 and image-identity checks passed. The browser image is
`sha256:53d17b9e88a17f8cd0927419dd154f07de5e315fece41ae9af73c7fe1f75ca3b`.
[Main checks](https://github.com/akhilvuputuri/chief-agent/actions/runs/37740205891),
[normal release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37740955551)
and the exact-SHA receipt succeeded. [v0.3.47](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.47)
is immutable at that verified commit.

Measured live acceptance, one supplied public-source case: anonymous resolution
returned blocked. A separately reviewed operator imported the selected-post outbound
URL directly observed in the local browser, with its actual observation timestamp
and a 24-hour expiry. It remains labelled `owner_verified`; no mapping was hardcoded
in application source and no server browsing success was inferred. Reader returned
server ready with a duplicate receipt. The private operation retained original URL,
publisher URL, target and evidence; same-key cached replay passed. This direct
adapter/API check used no Chief model call or Telegram send. Phone offline availability,
conversational selection and other blocked links remain unverified.
