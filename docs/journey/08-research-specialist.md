# Research delegation with linked execution traces

## Problem and decision

A single conversation loop carries source material and coordinates all research. Introduce one bounded read-only specialist to isolate source context while retaining the main agent's responsibility for synthesis and writes. This implements phase 1 of issue #27. Media delegation and Python analysis remain deferred.

## Implementation

Reuse the TypeScript runtime and existing Postgres tables. Validate exact target identities and source quotations, restrict child tools in the catalogue and dispatcher, share parent execution budgets/cancellation, and retain child model inputs, observations and separately attributed provider charges. The parent receives a compact report rather than full pages. Model invocation IDs connect input, response and dispatched tools. Extend bounded diagnostics with seven-day parent/child metadata.

## Evidence and limitations

Focused mocked tests cover context isolation, ownership, tool boundaries, invalid reports, cost attribution, budget exhaustion, cancellation and restart. Full checks and the successful release SHA determine deployment status. No production conversations were replayed and no paid benchmark was run. Reduced context is a design property, not a measured cost saving; delegation adds calls and may cost more for small requests. Quote validation does not certify semantic correctness.

## Operations

No schema migration, reset or new infrastructure. Automatic application deployment remains the standard path. Installing the updated root-owned diagnostics handler is a separate reviewed operator action. Private trace export/analysis parity is still incomplete; full trace contents must not enter CI logs. See [specialist operations](../research-specialist.md).
