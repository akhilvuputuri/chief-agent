# Contributing

Use Node 22 and the lockfile (`npm ci`). Run `npm run check`, `npm run build`, and the Python unittest command in the README. Keep fixtures synthetic and never add `.env`, provider logs or real user history.

New tools need a validated protocol operation, owner-scoped domain implementation, policy decision and tests for invalid input and ownership. External effects require exact payload approval, idempotency and recovery design before enabling them. Do not expand the Hermes allowlist to bypass missing domain tools.

Keep the adapter thin. Changes to the pinned Hermes revision must include a real-runtime contract check and an updated verification record. Record meaningful product tradeoffs in architecture/roadmap docs.
