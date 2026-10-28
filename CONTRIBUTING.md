# Contributing

Use Node 22+, the pinned kite (`node tools/install-kite.mjs`; npm is not used) and the lockfile (`kite ci`). Run `kite run check`, `kite run build` and `kite run format:check`. Keep fixtures synthetic; never commit credentials, provider logs or personal conversation data.

The runtime lives in `src`: the model adapter proposes named operations, the conversation loop records observations, and the owner-scoped dispatcher validates and executes actions. New tools need a Zod schema, explicit read/write classification, ownership checks and meaningful tests. Sensitive actions must preserve exact-action approvals. Never derive identity or permissions from model arguments.

Keep model, context, execution and integration boundaries explicit. Check cancellation, budgets and uncertain-write recovery when changing execution. Document actual limitations and observed results; mocked tests do not certify model reasoning. No Python service or upstream agent framework is required.
