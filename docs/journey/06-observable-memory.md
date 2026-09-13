# 06 — Making memory formation and retrieval inspectable

Work: 9–12 September 2026. Revised: 14 September 2026.
Status: basic explicit memory is released. Observable memory remains an incomplete, deferred checkpoint, not deployed or approved for merge.

## Starting point: explicit memory already worked

The [initial foundation](19-foundation-and-voice.md) included owner-scoped key/value memories in Postgres. `memory_set` saves a requested fact or preference; writing the same key replaces its value. `memory_list` retrieves the owner's saved values. The [schema](../../db/001_initial.sql) and [dispatcher](../../src/tools.ts) remain the integrated implementation. The [runtime verification record](../verification.md) includes a synthetic live-model `memory_set` → `memory_list` check and records explicit memories surviving the runtime cutover and later selective reset.

This gave the assistant durable facts across conversations, but a row contains only the latest value and update time. It cannot reliably answer which statement created the memory, what an earlier value was, why it changed or which exact model request received it. Persistence and inspectability are separate requirements.

## Problem and proposed evolution

The next requirement was to inspect memory formation, correction and retrieval. For a sanitized example, changing a saved meeting-duration preference should preserve the old revision, link the correction to its actual source and expose whether the new text was later supplied to the model. A source quote establishes provenance; it does not prove that the inferred preference is correct. Even complete prompt inclusion establishes what was supplied, not what the model used in its internal reasoning.

The chosen first version used the existing Postgres boundary: versioned records and active heads, owner-scoped source messages, explicit extraction/correction, text search, bounded selection and per-model invocation traces. It did not require embeddings or a third-party memory runtime. Existing values would become explicitly unsourced legacy records; assigning invented provenance would make the inspection interface misleading.

## Implementation checkpoint and failed checks

The work was preserved on `checkpoint/observable-memory` at [`2a85839`](https://github.com/akhilvuputuri/companion-agent/commit/2a85839), with an [immutable checkpoint report](https://github.com/akhilvuputuri/companion-agent/blob/2a85839/docs/checkpoints/observable-memory.md). It is available in Git, not only on the original development machine. Candidate migration 010 adds sources, revisions, heads and events; the branch also implements search/read/history tools, core-first bounded memory selection, prompt manifests backed by deduplicated blobs and a private export candidate.

The first 82-test run had eight failures attributed to older work fixtures/schema. After fixture updates, all 11 work tests passed and a runtime memory-write fixture was updated. A final complete suite, dedicated memory tests, security review and live acceptance were not completed. Passing those partial checks did not establish readiness.

The checkpoint also records a behavior defect beyond fixtures: missing-source and stale-revision validation used plain errors, risking classification as uncertain writes even when no mutation had occurred. That needs an explicit pre-mutation error and a regression through the runtime boundary. Prompt tracing needs similarly precise semantics: a memory ID appearing in context does not establish that its full text was included. Export ownership, scrubbing, bounds and actual cloud access remain unverified.

## Current boundary and next step

[Current work](../current-work.md) and the [handover](../../HANDOVER.md) retain the checkpoint as deferred. Later [authoritative message storage](16-authoritative-storage.md) and [rolling conversation](17-rolling-conversation.md) add original-message retrieval and protect active conversational context. They do not install migration 010 or complete memory revisions, formation provenance or private memory exports. Memory retrieval alone also would not fix loss of the immediately preceding exchange or a stale background task being routed into foreground chat.

When resumed explicitly, incorporate current main deliberately, fix error classification and complete tests for source ownership/exact quotes, stale revisions, legacy migration, retained history, selection omissions, full prompt inclusion, deduplication, scrubbing and bounded export. Review additive migration and rollback before deployment; verify the real restricted cloud inspection path separately from local tests. Then trace one user-authorized remember/correction interaction through formation and later inclusion. Preserve unknown legacy provenance and report remaining gaps. No memory migration, deployment, production replay or paid evaluation was performed for this documentation update.
