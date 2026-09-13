# Portable capability definitions

## Problem and requirement

Specialist instructions and configuration lived alongside runtime implementation. Reusing a capability required changing core source, and runs did not name a separately versioned capability package. [Issue #37](https://github.com/akhilvuputuri/companion-agent/issues/37) records the product requirement: portable skills and agents with explicit compatibility, dependencies and host-owned authorization.

## Implementation

Patch candidate v0.3.6 introduces a local declarative registry, text-only import/export bundle and the public-research package. A generic delegation operation supports additional agents implementing the existing public-research contract. The original research tool remains a configured alias. The runtime still validates exact target IDs, source quotations, ownership, permissions, budgets and cancellation. Job alignment/media retain their existing host implementations.

Definitions and approved namespaced skill versions are pinned to runs/tasks in existing private events. Later continuations use the same snapshot. Traces distinguish installed package identity, effective private skill versions and skills actually loaded. Installing a package does not activate it or grant tools.

## Development and evidence

Started from main `129d03a` in an isolated worktree. Filed the product issue before implementation. Extracted the existing research instructions, added the registry/import/export boundary and task pinning, then added mocked compatibility and end-to-end delegation tests. Existing research authorization, evidence, cancellation and accounting tests are retained. No paid model evaluation or production conversation was initiated.

Independent Astra review of initial head `63c3548` requested changes: accepted long skills exceeded the generic observation projection limit, and children could not read the remainder. Added scoped offset paging and a regression reading the final instruction through actual child observations, including JSON escaping overhead.

Independent re-review and deployment evidence must be checked on the feature PR and release workflow before calling this candidate shipped. No database migration, Compose update or new paid infrastructure is required. Ordinary passing main changes use the existing GitHub deployment pipeline.

## Limits and next steps

This proves the Companion-to-Companion portable subset, not universal vendor plugin compatibility. External agent-format adapters, MCP integration, richer skill assets, additional host contracts and extraction of job alignment/media are future work. The broader product issue stays open. Evaluate actual use before extending the format. No measured cost or quality improvement is claimed.
