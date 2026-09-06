> Runtime update: production now uses our TypeScript loop and scheduler. Hermes-specific architecture and pass limits below describe the earlier prototype; [current architecture](architecture.md) and [execution/recovery](reliable-execution.md) take precedence. Integration-specific permission boundaries remain enforced.

# Security and data handling

## Trust model

This milestone targets a personal allowlisted deployment. Telegram identifies the user; the application enforces ownership. Model outputs, role listings and web pages are untrusted. Credentials belong to server processes and never enter prompts. Authorization is enforced in application code and SQL rather than delegated to a system prompt.

- Use private Telegram chats only. Unknown user IDs and group messages are ignored before transcription or inference.
- No terminal, code execution, file-edit, email, application-submission or interactive browser tools are exposed. The bridge checks the exact exposed tool set before every conversation.
- Sensitive deletion requires the owner to send an exact command. The model cannot approve its own proposal.
- The sidecar has only the model key and service token; Node holds database, Telegram, search and speech credentials.
- Compose publishes gateway and Postgres to loopback only. Hermes has no host port by default. Never put the internal routes behind a public reverse proxy.
- Services drop Linux capabilities and cannot gain new privileges. No Docker socket or host project directory is mounted in the runtime.
- Read-only page extraction happens at the hosted provider. URL validation rejects local names, literal IPs and embedded credentials. DNS rebinding and provider-side network policy remain responsibilities of the hosted provider; this is not a general safe-fetch implementation.
- Input bodies, audio downloads and provider outputs are bounded. Runtime tool iterations and network timeouts limit individual requests but are not a daily spending budget.

## Persistence and privacy

Postgres stores job text, notes, preferences and conversation history—including voice transcripts and tool results. Traces omit message bodies, tool arguments, provider responses and credentials. Hermes may retain its own runtime/session artifacts in its private volume; `save_trajectories=False` is not a guarantee that every upstream storage path is disabled. Treat both volumes and backups as sensitive.

Audio is not written to application storage, but Telegram and external providers process it under their own retention policies. Do not promise end-to-end encryption or zero retention. `/reset` deletes application conversation history only. Full erasure also requires administrator deletion of the user's database row (cascades domain data), review of Hermes runtime artifacts, provider retention settings and backups. A user-facing export/erase flow is roadmap work.

Keep `.env` out of source control. Use separate scoped provider credentials and account-level spending limits. Rotate any exposed token and restart both services. For a shared cloud deployment use a secret manager, encrypted disks/backups, TLS for remote Postgres, and a non-owner database role with explicit grants.

## Known limits

The single Python process lock protects its shared turn capability. Do not increase its concurrency or deploy a shared runtime pool without explicit per-run worker isolation. The internal service token is a trusted-service boundary; compromise permits impersonating requests to that service. Long-running provider calls may continue after the gateway timeout, although subsequent gateway tool calls lose authority.

Prompt injection can still influence ordinary assistant text or permitted low-risk mutations such as role saves and preference updates. It cannot create nonexistent tool capabilities or bypass deletion approval. Memory writes are validated and owner-scoped, but explicit-user-intent detection currently relies on the agent instruction. A stricter deployment should gate memory writes or separate them into an authenticated user command.

Do not claim production tenant isolation, comprehensive audit integrity, guaranteed delivery, or safe autonomous external actions from this starter.
