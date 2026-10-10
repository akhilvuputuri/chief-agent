# 78 — Does the native adapter accept the real Pi tool continuation?

Work date: 10 October 2026. Status: released v0.3.62; deployed schema and startup health verified, direct real-model fixture passes. Original owner job remains paused; its task outcome is unmeasured.

## User-visible problem and preceding iteration

After [v0.3.61 Pi default activation](77-pi-runtime.md#default-switch-release-closure--10-october-2026), an owner-started planning job stopped rather than completing its brief. The owner asks for actual job diagnosis and direct server-side coding verification. Earlier evidence established synthetic mechanics, Linux boundaries and deployment, not a real-model end-to-end task; the real-model omission was disclosed but still left this compatibility gap untested.

## Evidence

- **Baseline:** freshly fetched main and verified running release `e3580dc5c94d8d61a3979a485404bf7e78a9594c`. Shared dirty checkout preserved; fix is isolated.
- **Live measured observation:** one new Pi planning job, DeepSeek V4.1 Flash/high effort, 10 October 04:29–04:31 UTC. One model call completed and two navigation tool results were retained. The next model request received HTTP 409 `invalid_worker_payload`; job paused and sandbox cleanup completed. No owner approval or implementation had occurred.
- **Structural reproduction:** decrypted retained entries were processed only on the host. A network-disabled container using the exact pinned Pi 1.1.0 worker reconstructed the continuation. Validation failed at the assistant message with unrecognized key `reasoning_content`. Only field paths/types and counts were exported; source, conversations, keys and raw reasoning stayed private.
- **SDK source:** Pi's native completions converter preserves structured `reasoning_details` and also supplies empty `reasoning_content` when the selected DeepSeek compatibility profile requires it. The earlier synthetic model lacked that profile. [OpenRouter reasoning guidance](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) supports retaining structured reasoning during continuation; the exact SDK source and executable payload are the evidence for the extra field.

## Diagnosis and alternatives

This is a host facade validation mismatch before the second provider call, not an observed provider refusal or planning-quality failure. Accept a bounded optional string `reasoning_content` in the native message schema and preserve it alongside existing structured reasoning. Do not make message parsing permissive, discard reasoning blocks, loosen owner/model pins, alter models/allocations or restart the paused job automatically.

## Implementation and review

`src/coding/pi-proxy.ts` admits the bounded native field. The authenticated facade regression verifies continuation preservation and exact-result replay; oversized/non-string fields and unknown message keys still fail before a model call. The standalone native-protocol fixture now also uses the actual DeepSeek catalog profile and verifies its mandatory empty field alongside structured reasoning. Production worker executable code/image is unchanged: the correction is on the trusted host, so no image repin is required.

Required checks, independent exact-head review and release will be recorded after verification. Version candidate: v0.3.62. Python runtime, saved jobs, model/provider price policy and allocations are unchanged.

## Verification and outcome

Focused authenticated gateway and two actual Pi native-converter regressions pass without paid calls. Full required local checks/build/format passed 1,030 tests. The user now authorizes direct server-side coding testing. A disposable Linux fixture uses the pinned worker, stripped tool environment/native guard, original configured models/effort/allocations and the candidate native facade with provider credentials retained inside the trusted gateway. It tests source learning, planning, exact generic fixture approval, bug edit, actual checks, independent assertions, separate read-only review and cleanup. It changes no owner production job, fabricates no Telegram approval and publishes no PR. The first fixture connection failed before provider access (zero model calls, 12.509 seconds); its container and listener were removed. The corrected trial used an authenticated localhost-only proxy and a disposable container with no host filesystem mounts, provider key or Docker socket; provider requests executed inside the trusted gateway. A bounded metadata read independently confirmed the fixture container was gone afterwards.

**Measured live fixture result:** one isolated addition workload passed learn → plan → exact generic fixture approval → build → four actual check commands → separate read-only reviewer, with only `sum.js` changed and three independent arithmetic assertions passing. DeepSeek V4.1 Flash/high effort made 14 calls; GPT-6.1 Sol/high effort made four review calls and returned APPROVE. Shared limits remained two hours/400 models/1,000 tools; actual counters were 18 models, 29 model tools, 114,959 active milliseconds and 116.538 wall seconds. Task/approval/session state remained readable before container disposal. No host provider/model failure was recorded. Provider-reported model usage/accounting is recorded below; no sandbox/host charge or general quality gain is inferred.

## Coding-harness learning record

See [cumulative lessons](coding-agent-lessons.md). A generic synthetic model exercises protocol shape but misses per-model compatibility. A reproduced real profile is necessary alongside a small authorized real task. The next falsifying check is a DeepSeek tool continuation through the corrected facade; success on a synthetic arithmetic bug does not establish scope quality on an owner repository task.

## Follow-up

Ship the reviewed correction and verify the exact deployed SHA/health. Preserve the paused owner job and its retained context; explicit owner resume remains a separate action. Record server fixture outcome and missing accounting without treating it as Chief delivery, owner task acceptance, publication or merge evidence.

### Live accounting and limits — 10 October 2026

The synthetic fixture succeeded once using the candidate adapter, not the deployed production endpoint. Across all 18 reported calls, OpenRouter reported 44,832 prompt tokens, 6,220 completion tokens and USD 0.0174043129 model cost. Prompt accounting does not distinguish cached tokens in the retained aggregate; host/container and networking costs are excluded. These are provider-reported values, not a measured saving or a dollar allocation cap. Its host-side facade supplied the real configured OpenRouter models and price filters, without Chief chat, production job changes, Telegram delivery/approval records, durable host model-call journalling or PR publication. It is standalone/provider/adapter acceptance, not acceptance of the owner's repository task or the complete Chief lifecycle. The original owner job remains paused with completed cleanup. The next live check is an explicitly resumed/new owner task after the reviewed release.

### Release closure — 10 October 2026

[PR 209](https://github.com/akhilvuputuri/chief-agent/pull/209) received independent APPROVE of exact head `4ac10a6aefa033eec695092ff35a59cdc7be2180` and passing Devin/hosted checks. The reviewer was explicitly configured GPT-6 Astra; exact serving identity was not exposed in its session. Independent validation covered all 66 coding tests (two localhost-restricted tests passed on permitted rerun), both native fixtures and nonempty/type/length/Unicode/reviewer/model-pin counterexamples. Full local required checks/build/format passed 1,030 tests; hosted Linux/extraction checks passed.

[Exact release](https://github.com/akhilvuputuri/chief-agent/actions/runs/38026894859) succeeded at 05:19:14 UTC, deploying `1c196c168710e776d1a513bb357a323bf851529b` with startup health. A separate bounded private observation recorded the new gateway starting at 05:18:50 UTC. A zero-inference deployed-module smoke reported v0.3.62/default Pi, accepted the DeepSeek compatibility field, and rejected unknown/malformed fields. Its owner-scoped read confirmed the original planning job remained paused with one completed model call and cleanup complete. No job or approval row was changed. Immutable [v0.3.62](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.62) identifies this fix; the worker image did not change.

The direct real-model fixture demonstrates standalone harness/native facade/provider behavior on one seeded bug. Deployment/schema acceptance does not establish completion of the owner's repository task, Chief delivery or a generally improved coding-quality/cost result. No paused job was automatically resumed.
