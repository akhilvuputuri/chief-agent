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

Independent reviewer requested changes on `b3b3d10` on 8 October 2026. The
review was dispatched to GPT-6 Astra; the reviewer reported GPT-6 family with the
exact variant unavailable in its context. Its executable probes found escaped
credential redaction, missing polling network deadline and mismatched status IDs;
it also found lost discovery Retry-After timing and missing immediate-bookmark
explanations. Those fixes add regressions, persistent connection throttling/auth
state, and narrow no-intent restart settlement. Final exact-head re-review and CI
remain required before release.

## Verification and outcome

Sixteen focused mocked tests are being checked after review fixes. The initial
full Node/script suites passed, then the Python picker contract rejected the new
domain; the shared domain inventory and offline scenarios were updated. Final full
checks are rerunning. Startup health of
the preceding release does not establish this feature. Production credentials are
not available to this development checkout. Authenticated Reader article/brief
saving, revocation and phone offline acceptance remain pending.

## Follow-up and next iteration

Ship remote bearer-authenticated connectors first. OAuth discovery/consent,
encrypted rotating token storage and owner reconnect/disconnect remain the next
milestone; they should reduce the operator-only connection setup requirement.

### Follow-up review — 8 October 2026

The independently approved `7277eff` passed hosted full CI and local checks (810
application, 50 script, 42 offline evaluation and 32 coding-runtime tests). Devin's
final posted finding identified synchronous remote-schema regex execution as a
gateway denial-of-service risk. Before merge, input and output schema validation
were moved to a bounded trusted worker, including the SDK's dynamic output
validation path. New executable tests use catastrophic patterns to verify deadline
termination and main-thread responsiveness, cancellation and ungranted schemas.
This updated source needs fresh exact-head independent review and CI; the earlier
approval does not cover it. No production installation has occurred.
