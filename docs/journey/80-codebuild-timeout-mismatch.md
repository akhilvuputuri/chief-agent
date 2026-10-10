# 80 — Why did the sandbox stop before its coding allocation expired?

Work date: 10 October 2026. Status: stopping cause confirmed; effective provider-timeout mismatch reproduced; resolution remains pending. No runtime or infrastructure change is implemented.

## User-visible problem and preceding iteration

The owner reported that the Pi sandbox stopped earlier. [Model compatibility](79-coding-model-compatibility.md) verified short real-model fixtures and role commands, followed by worker activation as v0.3.64. Those fixtures did not exercise the provider's long-running timeout boundary. [Allocation work](70-coding-allocations.md) requests two active hours and a 125-minute CodeBuild timeout, including provisioning allowance; source-level tests do not establish the actual timeout accepted by the service.

## Evidence

Fresh main and verified deployed release: `c2954a8d56656590a65a69c4d4f3bf4090d78771`, v0.3.64. Bounded owner-scoped metadata and CodeBuild phase reads on 10 October confirmed one resumed Pi planning attempt: the build started at 07:54:16 UTC, BUILD ran for 2,705 seconds, and it ended at 08:39:57 UTC. Overall status was FAILED; BUILD status was TIMED_OUT with `BUILD_TIMED_OUT`. The service reported a 45-minute timeout. The host deadline remained 09:54:53 UTC, so this was not exhaustion of the saved two-hour host allocation. The job paused with cleanup complete, 203 model calls and no completed plan. No private objective, conversation, environment values, credentials or job identifiers are retained here.

The original attempt used the older worker pin. However, one separate zero-model launch probe using the new default Pi image reproduced the mismatch: requested 125 minutes, StartBuild response and BatchGetBuilds both reported 45 minutes. It was immediately stopped and the StopBuild response reported STOPPED. No owner job, preference or approval was changed. This was an owner-authorized paid experiment; compute billing was not reconciled and is not claimed zero.

Additional read-only measurements: the project configured 20 minutes, Linux-container medium compute and disabled logs. A mocked request-handler probe against the deployed SDK confirmed the actual serialized request contained 125 minutes and used the regional AWS CodeBuild endpoint, with no endpoint override. No build was started by that serializer probe. CloudTrail LookupEvents access was denied; launch audit records and account restrictions could not be inspected.

## Diagnosis and alternatives

The immediate stopping cause is verified provider timeout, independent of the earlier native-model field rejection. The deployed controller and provider already request 125 minutes; repeating that code edit would not establish a correction. AWS returned a lower effective value even for the new isolated probe. An account restriction is a hypothesis, not a verified quota diagnosis. Ordinary published API documentation permits this override, but does not prove this account's effective limits: [StartBuild](https://docs.aws.amazon.com/codebuild/latest/APIReference/API_StartBuild.html), [CodeBuild quotas](https://docs.aws.amazon.com/codebuild/latest/userguide/limits.html).

## Implementation and review

Documentation records the incident and the missed verification boundary. No model, price filter, host allocation, project, IAM, database, Compose or worker image was changed. No paused job was resumed. The source fixture already asserts a 125-minute launch request for a two-hour allocation; the new evidence shows why checking only a mocked request is insufficient.

Potential hardening remains proposed: compare the effective launch receipt with the requested timeout and preserve the mismatch diagnosis, and include bounded provider terminal-phase metadata in pause reporting. Provider acceptance must be verified before claiming the two-hour allocation is available end to end. This entry does not claim those mechanisms are implemented.

## Verification and outcome

Measured stopping cause and one isolated reproduction are complete. The probe is terminal/STOPPED, with zero model calls and no owner-data mutations. The original job remains paused. The v0.3.64 model/report/review fixes are still deployed; this is a separate unresolved provider boundary that also affects new launches. Next: inspect the account-level limit or AWS audit/support evidence with authorized access, resolve the provider restriction, and independently verify an accepted 125-minute launch receipt. Neither this investigation nor short fixtures establish long-running completion reliability.
