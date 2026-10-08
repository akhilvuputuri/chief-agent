# Remote MCP connectors

Chief uses the official TypeScript MCP SDK over Streamable HTTP. The reviewed
`config/mcp.json` grants individual tools; discovery supplies their input schemas.
Connections use owner-bound bearer credentials in the production environment.
OAuth consent/refresh, stdio processes, legacy SSE endpoints, remote installation,
resources, prompts, sampling, elicitation and arbitrary non-idempotent writes are
not supported by this first milestone. IBKR keeps its existing separate adapter.

## Add a compatible server

Add a connection to `config/mcp.json` with a stable `id`, public HTTPS `url`,
credential reference, host-written description and explicit tool grants. Reads
use `mode: "read"`; an authorized save uses `mode: "idempotent_write"` and the
server's `idempotencyArgument`. Verify that the provider really implements
idempotency before granting writes. MCP annotations never grant permissions.
Review each grant against the product boundaries: this registry does not
authorize email sending, trading, library account writes or bypassing Calendar
approval. Generic MCP tools are coordinator-only and cannot be granted by a
plugin. All changes require the normal independent review and release process.

Install `MCP_CREDENTIALS_JSON` only in the host's owner-only `.env`, using a
reference map of `{ "connection-reference": { "owner": "Telegram user ID",
"token": "runtime secret" } }`. Tokens must never be pasted into chat or put in
source, URLs, public artifacts or logs. References match the registry's
`credential` field; the owner must be an allowed Telegram user. Replacement
credentials constitute a new connection binding. Missing references are not
exposed to another owner. `MCP_RUNTIME=off` is the default. See the [rollout](mcp-deployment.md).

## Discovery and calls

The stable host protocol has four operations:

- `mcp_tools(connection?)`: list only the owner's configured grants, namespaced
  as `reader/save_link`, their live JSON schemas, and pending operation keys.
- `mcp_read(connection, tool, arguments)`: invoke a granted read with server
  schema validation. This cannot invoke a granted write.
- `mcp_write(connection, tool, requestKey, arguments?)`: submit an explicitly
  requested save. Use one UUID per user intent; omit the remote idempotency field.
  The host injects the UUID. For replay, retain the same key and omit arguments
  to use the original persisted payload.
- `mcp_operation(connection, requestKey)`: inspect the durable write receipt.

Server tools are addressed through these typed host operations, rather than
adding arbitrary operation names to Chief's closed protocol. A compatible new
server needs registry/credential configuration, not another transport adapter.
Input and declared output schemas support draft-07 and 2020-12; unresolved
external references fail closed. Compilation and validation run in a trusted
worker with a two-second deadline, memory limits, empty environment and shared
cancellation. Expensive patterns cannot stall the gateway event loop. SDK dynamic
output validation is deferred to that worker; fixed MCP wire envelopes remain
validated by the SDK. Descriptions/results are untrusted data, not host instructions.

The host persists payload, schema digest and connection/credential binding before
submission. A reused key with different content, tool, endpoint or credential is
refused. Complete replays return the stored receipt. Uncertain outcomes retain
the key, block unrelated writes even after connections are disabled and allow only the exact configured idempotent
replay. An unrelated uncertain runtime call continues to block it. Successful
replay reconciles matching stopped runtime calls; paused jobs stay paused.
A stopped pre-submission call with no durable intent is marked failed because it
could not have reached the server save call. No startup task resumption or automatic
write retry is added.

Connection-wide HTTP 429 timing and authentication rejection are persisted across
restart. HTTP 429 without a valid delay uses a 60-second backoff. Authentication failure suppresses further
unchanged attempts. Schema drift and credential replacement stop replay for
operator inspection. A text-only MCP business error has no dependable certainty
contract, so its operation stays pending. Provider errors are categorized without
copying response bodies or SDK errors to logs. Operational logs use only host
operation names, timing and safe categories. Results remain in private storage.

## Reader

Reader grants exactly `save_link`, `save_document` and `get_save_status`. Source
URLs and Markdown are validated against deployed schemas and the 220000-byte
request limit. Receipts and status text blocks are decoded and validated.

After an accepted pending save, Chief polls at 2, 5, 10 and 20 seconds with a
45-second polling deadline and shared cancellation. Pending imports return their
submission IDs and can be checked later through existing authorized durable work.
`complete` describes an accepted save operation, not completed extraction.
`ready` describes server preparation. Only the phone verifies **Available
offline**. An immediate bookmark receipt receives one bounded status lookup for its
explanation. Status UUIDs must match the requested submission. `bookmark` retains
the URL after extraction failure; it is never replaced
with an invented summary. `already_saved` with a null submission ID is not polled.
Cancellation does not delete an accepted article.

Public discovery was measured on 8 October 2026 using the new SDK: protocol
2025-06-18, server `offline-reader` 0.1.0 and the exact three tools. Authenticated
production saves, revocation and phone offline acceptance remain separate checks.
