# 06 — Making memory formation and retrieval inspectable

Started: 9 September 2026. Status: implementation in progress, not deployed or fully verified.

The owner wants to ask which conversations created a memory, how it changed and when it was supplied to the agent. The prior key/value memory store overwrites values and cannot answer those questions reliably.

The approved first version introduces versioned records, owner-scoped user-message sources, explicit extraction/correction, Postgres text search, bounded memory selection and per-model invocation traces. A source quote records provenance; it does not prove a correct inference. A memory present in the prompt was supplied to the model, not demonstrably used in its internal reasoning.

Current local implementation includes additive migration 010, source/revision/head/event tables, retrieval tools and prompt trace manifests backed by deduplicated blobs. Tests, integration review, documentation and the reviewed deployment remain outstanding. Do not treat a file existing locally as a released feature.

Acceptance should cover source ownership, exact quotes, stale revision conflicts, retained history, selection omissions, prompt inclusion, redaction, restart recovery and private cloud export. Existing memories should migrate as explicitly unsourced legacy records rather than receive invented provenance.

Future follow-up should trace one real, user-authorized remember/correction interaction through formation and later inclusion. Log the evidence and any gaps here. No embeddings or third-party memory runtime are required for this first version.
