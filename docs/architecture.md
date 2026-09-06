# Architecture and decisions

## Product boundary

Companion is a general personal assistant with an initial job-search tool vocabulary. Conversation is the interface. Roles are structured records, not the output of an obligatory workflow. Additional domains should add validated tools behind the same identity and approval boundary.

## Components

**Gateway (TypeScript / Node).** Authenticates Telegram senders, accepts text or voice notes, serializes work, creates run capabilities, persists successful history, dispatches domain tools and returns replies. Fastify serves internal-only tool routes and liveness. grammY handles Telegram long polling. No public chat endpoint exists yet.

**Hermes service (Python).** Runs the existing reasoning loop with one custom `companion_action` tool registered into the `companion` toolset. It creates a fresh agent object per turn and supplies the prior history. A process-wide lock protects the active run capability, including threaded tool callbacks. Progressive tool discovery is disabled in the dedicated runtime configuration so the custom tool stays directly exposed. Any unexpected exposed tool causes the turn to fail closed. The runtime cannot directly choose arbitrary Python functions or HTTP destinations through the model tool schema.

**Postgres.** Owns users, jobs, explicit memory, complete returned conversation history, exact-action approvals, update deduplication and trace metadata. Every user query is parameterized and owner-scoped. Application-level ownership tests cover reads, writes and approvals; this is not a tenant-isolating RLS deployment.

**Voice provider.** Input passes through a byte limit and duration limit. Audio lives in process memory until collected; no application audio files are written. Transcripts become ordinary conversation messages. Text is always delivered before optional generated speech. Speech output uses a standard synthetic voice with an AI-generated label.

**Read-only research.** Search and extraction are delegated to a hosted service. The gateway never fetches arbitrary role URLs itself. Read requests require public HTTPS hostnames; results are marked untrusted. This provides page-reading capabilities, not a general interactive browser.

## Decisions

### TypeScript gateway with a Python adapter

Most application work benefits from a single TypeScript domain boundary and direct Telegram support. Hermes integration favors Python. A small authenticated HTTP interface is less brittle than spawning a CLI or rewriting its reasoning loop in Node. Hermes is installed from a pinned checkout using its lockfile, not an assumed published Python package.

### Explicit per-user memory

The agent's generic filesystem memory is not authoritative in a shared runtime. We disable native memory and context-file discovery; supply owner-scoped memories from Postgres and expose memory tools through the gateway. The `hermes-data` volume holds runtime artifacts and remains private. Do not share it with untrusted containers.

### One custom tool, validated operations

One upstream registration minimizes coupling to Hermes internals. Zod validates every operation in Node. Flat fields keep provider tool schemas straightforward; operation-specific requirements are described in the tool and enforced at the gateway. Moving to one schema per tool or MCP is compatible with the domain layer later.

### Capability-scoped execution

The shared service token authorizes an agent turn, not domain operations. Each turn gets an unpredictable, short-lived capability; the gateway maps it to user and run. The model does not supply a user ID or see the capability. The gateway revokes it on success, failure, or timeout. The sidecar receives no database credentials, Telegram token, speech key or search key.

### Approvals in SQL

A deletion tool records the exact job ID and a readable preview. The model can propose but cannot approve it. The gateway also renders the preview from the stored payload independently of the model. A direct Telegram command binds the user's identity to the pending record. A data-modifying CTE changes status and deletes the owner-scoped role in one statement. Denial, expiry and replay leave the role intact. No generic external-action executor exists.

### Single always-on deployment first

Run the Compose stack on an always-on VM with persistent disk; use a managed Postgres service later if needed. Long polling avoids inbound webhooks. The runtime is persistent as a service, while each agent object is disposable and durable state survives restarts. This is not an autoscaling or resumable job system.

## Future client boundary

A web/PWA should authenticate a session, resolve it to the same internal user, then call the application service. Never expose the internal capability or Telegram token to a browser. Add a durable run resource and SSE events for response/progress streaming. Realtime voice should translate authenticated audio sessions into the same run/tool model and share approval controls. See the roadmap for prerequisites.

## Durable execution

See [reliable execution](reliable-execution.md) for the Postgres work ledger, evidence/receipt checks, bounded continuation worker and generated tool schema. Repo baseline skills are versioned with code; approved personal overrides remain in Postgres. These extend the existing gateway/Hermes boundary without adding a server.
