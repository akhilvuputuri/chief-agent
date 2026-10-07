# 67 — Can external MCP tools share Chief's durable execution boundary?

Work date(s): 2026-10-08. Written/revised: 2026-10-08.
Status: in progress; independent review, full checks and deployment pending.

## User-visible problem and preceding iteration

Chief's [portable plugins](15-portable-plugins.md) package domain instructions and
its IBKR integration uses a dedicated MCP client. Neither supplied reusable remote
MCP connections. The requested Reader integration motivated standard transport
and reviewed configuration instead of a second service-specific transport.

## Evidence

Measured on 8 October 2026: one unauthenticated discovery against Reader through
the new official SDK negotiated 2025-06-18 and listed exactly three tools. No save,
credential, model request or phone download was involved. Production RELEASE
7447881346502bcbe29fb4d4a1929149cb598905 and localhost startup health were read
before implementation rollout. These observations do not establish authenticated
Reader acceptance or MCP activation.

Synthetic tests cover a second generic server, owner scope, read/write grants,
pre-submission persistence, exact replay after reconstruction, unrelated uncertain
writes, credential/schema changes, rate limits, auth rejection, stateless SDK
handshake, Reader statuses and cancellation. The initial fixture omitted its
source-table prerequisite and failed before exercising operations; that was fixed.
The initial full check hit the sandbox's tsx IPC restriction; it is rerun through
the authorized local test environment. Paid picker/acceptance evals are unrun.

## Diagnosis and alternatives

MCP discovery supplies schemas, not permission or durable write semantics. The
host keeps reviewed grants and stable typed bridge operations. A persisted UUID,
payload, schema digest and credential binding permit only exact idempotent replay;
other uncertainty keeps blocking writes. Non-idempotent generic writes, remote
installation, stdio and OAuth are deferred. Existing IBKR behavior is unchanged.

## Implementation and review

See [connector contract](../mcp.md) and [additive rollout](../mcp-deployment.md).
The official SDK handles Streamable HTTP; JSON Schema validates remote arguments.
The dispatcher supplies owner identity and cancellation, and journals writes before
submission. Registry grants cannot be expanded through plugins or server hints.
Migration 030 preserves operations; Reader's receipts distinguish accepted saves,
server preparation and unverified phone downloads.

Independent review and exact-head CI evidence will be appended before release.

## Verification and outcome

Nine focused mocked tests pass; full-suite results are pending. Startup health of
the preceding release does not establish this feature. Production credentials are
not available to this development checkout. Authenticated Reader article/brief
saving, revocation and phone offline acceptance remain pending.

## Follow-up and next iteration

Ship remote bearer-authenticated connectors first. OAuth discovery/consent,
encrypted rotating token storage and owner reconnect/disconnect remain the next
milestone; they should reduce the operator-only connection setup requirement.
