# Security and data handling

## Trust and authorization

This is a personal, allowlisted deployment. Private Telegram chats establish identity before transcription or inference. Model output, listings, email and retrieved pages are untrusted. Zod schemas and owner-scoped SQL enforce tool boundaries; model arguments cannot choose an owner.

The Node process holds the integration credentials and calls tools directly. There is no internal HTTP tool callback, Python sidecar, shell execution, self-deployment or authenticated browser tool. Gmail and Calendar are read-only. Role deletion and skill activation require an exact owner approval; the model cannot approve its own proposal.

The gateway container drops capabilities, disallows privilege escalation, has a read-only filesystem and temporary storage, and does not mount the Docker socket. Gateway and Postgres ports bind to loopback. These controls are not a claim of production multi-tenant isolation.

Public page extraction uses hosted providers. URL checks reject local names, literal IPs and embedded credentials; provider network policy remains part of the trust boundary. No user cookies are forwarded.

## Persistence and privacy

Postgres stores conversations, voice transcripts, memories, domain records, model-response checkpoints and tool arguments/results. Execution records can contain personal data: treat the database, reset archives and backups as sensitive. Credentials are kept in private environment files and must never be injected into prompts or diagnostic logs.

Audio passes through Telegram and speech providers. Provider retention policies apply; do not promise end-to-end encryption or zero retention. `/reset` clears current conversation history, not every task, memory, trace or archive. Complete erasure requires an operator-reviewed data and provider retention procedure; a user export/erase flow remains future work.

## Recovery and limits

Persisted time/call budgets bound work; cancellation aborts model requests and prevents subsequent dispatch. Already-started external actions may complete. An interrupted write with an uncertain outcome pauses for inspection rather than replay. Read/model retries are bounded. These are not account-wide dollar spending limits.

Prompt injection can still affect prose or permitted low-risk mutations. Explicit memory intent is instructed to the model and is not independently proven. Source quote checks establish recorded support, not semantic truth. Keep existing approval boundaries and use provider spending limits. See [execution and recovery](reliable-execution.md).
