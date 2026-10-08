# 67 — Can external MCP tools share Chief's durable execution boundary?

Work date(s): 2026-10-08. Written/revised: 2026-10-08.
Status: released v0.3.45; Reader activated on 8 October 2026. Authenticated saves/retries passed; phone and conversational acceptance remain pending.

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

Fresh independent review requested changes on `c792b89`: AJV's optional `$async`
extension returns a Promise, which a boolean coercion wrongly accepted. The
worker now rejects async validators and requires an actual boolean result before
reporting success. An executable regression verifies invalid async data and that
no save is submitted or intent created. Previous 19 tests passed independently;
the new head requires fresh review and checks.

### Release closure — 8 October 2026

[PR #181](https://github.com/akhilvuputuri/chief-agent/pull/181) merged the final
independently approved `411e3fa33af182fbfc3555fb7bb146966b3367a3` as
`c1b72c7ce394d8cfb52870d5228568c195a3999d`; their Git trees are identical.
The reviewer was dispatched as GPT-6 Astra and reported GPT-6 family identity.
All 20 focused tests, typecheck and additional async/input/output fail-closed probes
passed independently. [Exact-head CI](https://github.com/akhilvuputuri/chief-agent/actions/runs/37716098502)
and [main CI](https://github.com/akhilvuputuri/chief-agent/actions/runs/37717070461)
passed 814 application, 50 script, 42 offline evaluation and 32 coding-runtime tests,
plus worker/browser isolation and PostgreSQL checks.

The concrete ephemeral operator artifact was independently approved at SHA256
`db2ca322ccf2df711a38e7b9e8a7be9a94c5322d84b6eee3751ba4930061a0d2` after
fixing flag overrides, stop recovery, health timeout and rollback identity. Its
syntax/source were checked; live fault injection was not performed. Matching
merged archive/tree, baseline, release lock and idle checks preceded the additive
migration 030/Compose installation. Source environment remained unchanged, MCP was
forced off, and 32 jobs / 6 memories / 1 paused task / 1 user / 11 daily schedules were preserved.
No paused task resumed and no real provider/model/message action was made.

The [normal release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37717573236)
and exact-commit receipt report successful deployment/startup health at
2026-10-08 02:23:21 UTC. Separate server RELEASE/embedded SHA, health and MCP-off
checks passed. A deployed-module synthetic transaction verified persistence,
replay, owner isolation, compiled worker validation and async-schema rejection,
then rolled back and confirmed no fixture remained. Public discovery from the
production container also returned exactly the three Reader tools without an
API credential or save. [v0.3.45](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.45)
is the shipped milestone.

Authenticated Reader article/brief saving, revocation and phone offline acceptance
remain unverified. MCP is disabled pending fresh credential installation; no chat
credential was used. OAuth, stdio, non-idempotent writes, server idempotency
retention measurement and paid picker evaluation remain separate work. These
limitations do not change the verified code/migration/health outcomes above.

### Reader activation — 8 October 2026

The owner explicitly authorized use of the supplied personal Reader credential.
It was extracted only from the authorized reply in the current local session into
process memory and delivered over encrypted SSH stdin. Its value never appeared
in command arguments, generated scripts, output, repository files or public
artifacts. The credential is stored only in the host's owner-only environment.
No private conversation or credential value is included in this record.

Two secret-free ephemeral operation artifacts were independently approved by the
reviewer dispatched as GPT-6 Astra: host activation SHA256
`e171efd236cfde517c0814be73f78aaa5ebaa5cb95cafdda6d0f95f3ad34743d` and delivery
SHA256 `27b4971add9ce2fb310f2ad3301d9c146f2d20046db2bd79abca4398e86782b0`.
An initial outer SSH timeout could cut off host recovery; it was removed before
approval/execution. Review independently checked hashes/source/Python syntax,
without reading the credential or executing the operation. Live fault injection
was not performed.

Verified deployed source was `ace4a33d956da1d427ac38b0104ebe6a0278d298` while freshly
fetched main was `af9bf8c231db3388bf5b387da47008e4d595eaef`; the intervening coding
fix did not change MCP sources/configuration. The operation confirmed migration
030, zero active runs/queued inputs/pending MCP writes, release/health and a single
allowed Telegram owner under the existing release lock. It atomically updated only
MCP environment entries, preserved other credentials/settings and environment
ownership/permissions, recreated only gateway and verified MCP on/owner binding/
unchanged release/health. No paused task was resumed.

Measured acceptance on 8 October 2026: authenticated discovery returned exactly
save_link/save_document/get_save_status. Two new saves (one public SDK guide and
one clearly labelled test brief) reached server ready. Two cached replays and two
server-side retries with the original keys returned identical submission identities;
server retries reported duplicates, and pending write count was zero. An initial
JSON-string comparison differed because PostgreSQL JSONB reordered object keys;
semantic equality and server identity checks passed. Private submission IDs and
content remain on the host. These checks used no model call or Telegram send.

Phone Available offline, actual conversational selection and live credential
revocation acceptance remain unverified. Revocation was not performed because it
would disconnect the newly activated connection. OAuth/secure self-service setup,
stdio, non-idempotent writes and paid picker evaluation remain separate work.
