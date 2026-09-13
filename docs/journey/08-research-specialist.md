# Research delegation with linked execution traces

Work date: 2026-09-12. Revised: 2026-09-14.
Status: released v0.2.0; comparative quality/cost improvement unmeasured.

## Problem and decision

A single conversation loop carries source material and coordinates all research. Introduce one bounded read-only specialist to isolate source context while retaining the main agent's responsibility for synthesis and writes. This implemented phase 1 of [issue #27](https://github.com/akhilvuputuri/companion-agent/issues/27). Media delegation and Python analysis were deferred at this milestone; [media delegation](12-media-specialist.md) subsequently shipped separately.

## Implementation

Reuse the TypeScript runtime and existing Postgres tables. Validate exact target identities and source quotations, restrict child tools in the catalogue and dispatcher, share parent execution budgets/cancellation, and retain child model inputs, observations and separately attributed provider charges. The parent receives a compact report rather than full pages. Model invocation IDs connect input, response and dispatched tools. Extend bounded diagnostics with seven-day parent/child metadata.

## Evidence and limitations

Focused mocked tests cover context isolation, ownership, tool boundaries, invalid reports, cost attribution, budget exhaustion, cancellation and restart. Full checks and the successful release SHA determined deployment status; the dated closure below records the verified result. No production conversations were replayed and no paid benchmark was run. Reduced context is a design property, not a measured cost saving; delegation adds calls and may cost more for small requests. Quote validation does not certify semantic correctness.

## Operations

No schema migration, reset or new infrastructure. Automatic application deployment remains the standard path. Installing the updated root-owned diagnostics handler was a separate reviewed operator action, recorded in the release notes. Private trace export/analysis parity is still incomplete; full trace contents must not enter CI logs. See [specialist operations](../research-specialist.md).

## Release closure — 14 September 2026

[v0.2.0](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.2.0) shipped [PR #29](https://github.com/akhilvuputuri/companion-agent/pull/29) at `032467c4a1c178ee150ffeac9c101bae9945217e`. The [release workflow](https://github.com/akhilvuputuri/companion-agent/actions/runs/34684670904) completed successfully for that exact SHA; published release evidence records deployment and health verification. The release records 99 mocked/PGlite tests plus typecheck, build and formatting, and installation/verification of the bounded diagnostics field. Independent review of this shipped foundation then found cache and elapsed-accounting gaps: [entry 10](10-foundation-review.md) preserves the failures and v0.2.1 correction. No real-user delegation or paid quality benchmark was verified at this milestone.
