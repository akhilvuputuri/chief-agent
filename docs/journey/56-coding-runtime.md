# 56 — Coding work outside the live assistant

Work date(s): 2 October 2026. Written/revised: 2 October 2026.
Status: in progress. Implementation and synthetic verification; independent review and deployment pending. Live provider activation is blocked by missing scoped CodeBuild/GitHub App setup.

## User-visible problem and preceding iteration

The owner requested dispatching Chief bug fixes and features to a separate coding runtime in a provisioned sandbox while Chief collects updates. [Coordinator agents](49-coordinator-agents.md) introduced isolated domain contexts but inherit the parent's foreground/background lane, cancellation and remaining allocation. They do not provide a durable remote process or sandbox execution.

## Evidence

- **Measured environment, 2 October:** freshly fetched main `618d5adba432775c7f6c2f1e01fa468a9d6571c5`. Its [release receipt](https://github.com/akhilvuputuri/chief-agent/actions/runs/36919317018) reported success and the operator read of server RELEASE matched.
- **Measured access:** doctor:cloud verified repository write and Actions-read access; merge/dispatch remain separately tested real operations. SDK authentication succeeded, but CodeBuild ListProjects returned AccessDeniedException. The existing operator profile had no usable credentials. The AWS CLI failed before authentication due to a local Python library error. No credentials were printed or exported.
- **Tested, initial focused pass:** 11/13 cases passed; test ordering assumed distinct event timestamps and a symlink fixture remained in the snapshot. Both fixture errors were corrected. The subsequent 15-case pass includes a real disposable Git/npm fixture, mocked model/provider services and no paid model requests.
- **Tested baseline failure:** the full suite initially passed 623/624 application tests. The responsibility evening-digest fixture scheduled against actual database time but ran against a fixed noon clock. The same failure reproduced on an untouched archive of `618d5ad`; the due-time fixture now uses its injected clock. No responsibility runtime behavior changed.
- **Tested full suite:** 624 application tests, 22 JavaScript script tests and 30 Python tests passed after the fixture fix, along with typecheck/build. Formatting passed. CI/image verification and independent review remain separate.
- **Verified provider metadata:** [OpenRouter's model catalogue](https://openrouter.ai/api/v1/models) lists GPT-6.1 Sol at the existing $2/$10 input/output ceilings and Astra above them. Both sandbox contexts default to Sol; provider filters are unchanged. The worker-context verdict does not replace independent review of the published head with the strongest available reviewer in its authorized environment.
- **Not measured:** live CodeBuild start/image-pull latency, sandbox cost, coding quality, reviewer quality, live Telegram delivery and GitHub App publication. Local Docker daemon was unavailable; worker image verification is added to CI.

## Diagnosis and alternatives

Use direct asynchronous dispatch from Chief to a deterministic controller. Keep the conversational interface stable so a later engineering plugin agent can prepare briefs and dispatch the same jobs. A reasoning agent is unnecessary for leases, heartbeat expiry or cleanup. Do not keep synchronous agent_run open for a long coding job or broaden existing plugin recursion. [Coding architecture and rollout](../coding.md) describes authority, recovery and remaining activation steps.

## Implementation and review

New owner-scoped schemas, tools and migration 024 store jobs independently of conversational work. The controller provisions a dedicated NO_SOURCE CodeBuild project, fences attempt tokens, journals private model calls, reconciles uncertain external responses and tracks cleanup separately. A separate immutable worker image runs repository tools, required scripts and a fresh read-only reviewer context. A trusted host publisher prepares a draft PR under a configured human identity, retaining private evidence outside public PR text. The outbox preserves uncertain Telegram sends.

The default is off. Activation needs migration/Compose operator installation, a reviewed public GHCR image digest, dedicated scoped AWS access, GitHub App configuration and authenticated ingress. No unrestricted VM shell capability, production credentials in the sandbox, runtime main-branch merge or self-deployment is added. PR approval still requires exact-head independent review under REVIEW.md; a worker-generated verdict is not host merge authority.

Independent GPT-6 Astra review of [PR #150](https://github.com/akhilvuputuri/chief-agent/pull/150), exact head `39412c0da79f2023920098f010f572d96b6f944f`, returned REQUEST CHANGES. Its independent regressions found owner revocation blocking the global lane, missing executable modes, a message-count ceiling reached before allocation exhaustion, cancellation during a model-call claim and heartbeat errors aborting workers during transient controller outages. The implementation now distinguishes a never-created sandbox from uncertain provisioning, pauses revoked publication, preserves modes through snapshot/hash/restore/publication, bounds history count/observations, registers per-call cancellation before claiming and tolerates bounded transient HTTP failures with stable request IDs. Added regressions cover all findings plus Chief dispatch/thread continuity. Re-review of `6885093cebd540c838fdbcc845a8f92ec8a3059f` verified those fixes but requested changes on two further boundaries: revoked uncertain publication could be resumed without reconciliation, and a large patch was embedded in the protected review assignment. Revision now remains fenced while publication_started is true; review carries bounded changed-file metadata/hash and reads the fresh checkout. Regressions include a >120k-character artifact and a lost-PR/revocation/resume sequence. Re-review of the final exact head is pending. First-head CI, including Docker image build/non-root/tool verification, passed; automated Devin Review also passed and did not replace the independent findings.

## Verification and outcome

Focused synthetic tests cover ownership/foreground dispatch, duplicate request/revision handling, restart recovery, cancellation fencing, provisioning acknowledgement loss, heartbeat expiry, explicit resume, model-call accounting/uncertainty, exact-artifact candidate gates, lost PR responses/external branch changes, HTTP capability rejection, uncertain delivery, path/symlink protection, command cancellation and an end-to-end worker fixture. Full checks passed locally; CI and worker image verification are pending.

Final local candidate verification after both review iterations: 632 application tests (23 coding cases), 22 JavaScript tests and 30 Python tests pass with typecheck/build and formatting. Provider policy was also corrected against AWS's service authorisation reference: BatchGetBuilds and StopBuild use the project ARN; PassRole is restricted to the exact policy-free worker role and CodeBuild service. v0.3.33 is the prepared patch version, not a release claim. Final-head CI, independent approval and operator deployment remain pending.

### Release closure — pending

No new release or live coding activation is claimed. Record reviewed head, PR, migration installation, exact deployed SHA/health and provider activation separately. Main merge alone will not satisfy the rollout prerequisites.

## Follow-up and next iteration

Complete scoped provider/App setup and one paid owner-requested acceptance job after review. Measure provisioning duration, active compute duration and reported model usage separately. Private production incident export remains unfinished: start with owner-supplied sanitized reproduction, then add a reviewed private trace-to-fixture interface when needed. An engineering planning subagent and merge/release automation are later extensions over the same durable job contract.
