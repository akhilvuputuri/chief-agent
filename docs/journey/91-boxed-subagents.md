# 91 — Can Chief delegate heavy work to sub-agents with their own boxes?

Work date(s): 2026-10-17 to 2026-10-20. Written/revised: 2026-10-20.
Status: in progress. Boxes are on in production since 19 October, with the owner-applied `chief-boxes-prod` AWS stack, and phase 3 is measured on EC2. Coding runs only in EC2 boxes: phase 4a since 19 October, with a real job run end to end on 20 October. CodeBuild was removed from the code (`bd2ce04`) and from AWS on 20 October (phase 6). Next: a medium-sized canary job, then phases 4b and 4c. Not yet observed: subreaper cleanup on the AL2023 kernel.

## User-visible problem and preceding iteration

The owner asked (reported) to rework delegation around sub-agents that get their own on-demand box, as opposed to today's light in-process sub-agents. Chief would spawn a box, delegate tasks to it, steer it, collect results and close it, or let a time-to-live close it. Coding would be one kind of task among several, with data analysis and web crawling to follow. The owner's view was that current coding jobs feel "less like a sub-agent and more like just throwing a runtime job, and there's not much access into it from chief." This builds on [journal 89](89-agentic-coding-subagent.md), where the coder gained commit authority, and on issue #219, the earlier exploration of an independent coding service and EC2.

## Evidence

Four parallel read-only explorations of main `9fae411` produced this evidence. Facts come from code, docs and cited sources; the ranking of options is judgment.

**Tested (read from code):**

- The worker channel is pull-only. Its routes are `assignment`, `heartbeat`, `progress`, `checkpoint`, `finish`, `model`, `logs`, `github-token`, `pi-session` and the Pi chat-completions proxy (`src/coding/api.ts`). The host can only refuse calls, abort model calls or stop the build. `coding_runtime_pi/src/rpc.ts` has a reply/approve/cancel/events RPC that only the CLI uses.
- The exploration found eleven points where the generic box lifecycle is tangled with coding workflow; the design groups them ([design](../boxes.md#what-exists-today-and-why-it-is-not-enough)). The worst:
  - the global `coding_one_active_worker` index also counts host-side `publishing`;
  - approval policy sits inside worker authentication and heartbeat;
  - `coding_events` is overloaded.
- `agent_run` is classed as a read operation (`src/execution.ts`). A placement that starts infrastructure would bypass the uncertain-write guard.
- The CodeBuild attempt token is passed as a `PLAINTEXT` environment variable (`src/coding/provider.ts`). It is readable by any principal with `codebuild:BatchGetBuilds` on the project. Our policy grants that to the controller (`deploy/coding/controller-policy.json`), whose host already holds the token-derivation key, and administrators have it implicitly, so the practical exposure is low.

**Measured (earlier journals):**

- CodeBuild overhead is about 27–64 s per attempt. This is derived from the [journal 83](83-pi-context-verification.md) runs as total build seconds minus runtime seconds.
- CodeBuild medium costs $0.01 per minute, billed per whole minute ([journal 70](70-coding-allocations.md)).
- The 45-minute lifetime clamp was observed on 10 October ([journal 80](80-codebuild-timeout-mismatch.md)). After AWS Support replied on 12 October, a 13 October probe was admitted at 125 minutes; this proves admission only ([journal 83](83-pi-context-verification.md)).
- `spawn ENOMEM` occurred on medium and a cgroup limit was hit on large. Partitioning test processes on unchanged medium fixed it, so this is not evidence that CodeBuild compute is too small ([journal 83](83-pi-context-verification.md)).

**Documented by vendors (web, dated 2024–October 2026):**

- EC2 lets an instance stop with its disk kept and start again later.
- Fargate does not cache images and does not allow privileged mode.
- Hosted sandboxes (E2B, Modal, Daytona, Vercel) start fastest, but send code and data to a third party, Singapore residency is unconfirmed, and published limits and prices conflict between sources.
- "Grok Bot" (xAI) and "Muse" (Meta), the likely meaning of the owner's "grokbot muse" reference, describe an always-on coordinator, compute per agent, and credentials held by a separate authority behind approvals.

## Diagnosis and alternatives

The two-way channel and multi-task boxes do not need new compute. A box agent that long-polls the host gets steering over the existing HTTPS origin on any provider. The provider decision matters for what happens between tasks:

- **CodeBuild and Fargate** can only end and restart, so every round clones and installs again.
- **EC2 can stop with its disk kept.** That makes the owner's "short warm TTL" nearly free. After the review's trust reset, every task still re-clones and re-installs, so warm reuse saves boot time and the image pull, plus verified package downloads once a cache exists; phase 3 measures it. EC2 also removes our one-build limit, and lets us choose memory per profile.

The cost of EC2 is operating the lifecycle ourselves: launch templates, tags, IAM conditions, IMDS lockdown, sweeps and image updates. Fargate is simpler to run but cannot keep a disk across stops. Hosted sandboxes were deferred for residency and vendor reasons.

## Owner decisions — 17 October 2026

- Coding moves onto boxes first.
- Short warm TTL: about 15 idle minutes, then stop.
- Move from CodeBuild to self-managed EC2. The owner asked for an evaluation first, then approved the plan; CodeBuild stays as fallback.
- Go ahead with the phased plan. The owner applies the AWS resources.

Default pending: only Chief spawns boxes.

## Implementation and review

Design only: [boxes.md](../boxes.md). Implementation follows the phases listed there, each with exact-head review.

### Review of the first draft (`15102bf`, Claude Opus 5.5): changes requested

**Blocking findings and their corrections:**

1. **IAM.** A launch-template condition does not stop `RunInstances` overriding template parameters, and tag-scoped `ModifyInstanceAttribute` could change instance type, security groups, shutdown behaviour or volume deletion. The design now constrains every resource type with its own condition key, drops `ModifyInstanceAttribute` entirely, lists volume sweep and SSM permissions, and requires negative tests.
2. **Warm reuse.** It had no trust reset: local git configuration (`core.fsmonitor`, filters), untracked files, a poisoned `node_modules`, caches, home-directory files and leftover processes could carry from one round into a later approved round. Now every task gets:
   - a fresh container;
   - a fresh clone with no local git configuration;
   - a fresh install.

   A box is bound to one job, owner and repository. Reuse is proposed only after implementation approval, and the remaining container-escape risk is stated.

3. **IMDS.** The controls contradicted each other until the design said where tasks run. Now the box agent is a host service outside Docker, tasks run in bridged containers where hop limit 1 applies, and `DOCKER-USER` rules block IMDS.
4. **Steering.** It could bypass approval binding. Messages now carry only answers and clarifications, and a scope change needs a new revision and approval. The in-box `approve` RPC is unreachable, and steering is owner-attributed, never Chief's own initiative.

**Non-blocking findings, all adopted:**

- **Bootstrap.** Restarts no longer look like compromise: there is a session-credential re-hello, user data is never modified, and the limits of the identity document are stated.
- **Publication.** A per-repository publication lock replaces the serialisation the global index used to provide. The CodeBuild fallback keeps one task per box and no warm TTL.
- **Authorisation.** Per-call checks are explicit.
- **Lifecycle:**
  - start fails over to a fresh box when capacity runs out;
  - at-least-once messages are handled idempotently;
  - a host-restart grace period;
  - the sweep is scoped by an environment tag;
  - lifetime has a cumulative cap and an absolute cap;
  - workspace inspection does not follow symlinks.
- **Factual corrections:**
  - attribution of the clamp evidence;
  - the memory diagnosis;
  - CodeBuild limits that are our own configuration;
  - overhead range;
  - token lifetime;
  - the cost figure is a published rate.
- **Rollback.** Covers jobs already on EC2 and stack deletion.
- **Owner questions.** Expanded.

## Verification and outcome

Nothing is implemented or measured yet. Still to measure: EC2 boot to `hello`, warm start to `hello`, provisions per coding job, and cost per job.

## Follow-up and next iteration

Phase 2 is the box layer with a CodeBuild provider and an `echo` profile, with no new infrastructure. Open questions are listed in the design.

### Re-review (`72d83d3`): approved

The reviewer approved the corrected design. Six non-blocking points were adopted in the next commit:

- The rationale for warm reuse now states what it saves: boot, the image pull and, later, verified package downloads, not the workspace. Phase 3 measures it, and the owner is asked whether the TTL is still worth it.
- Phase 2 on CodeBuild proves one task per box. The multi-task proof moves to EC2.
- A consumed bootstrap secret is never presented twice by a real agent, so any reuse means compromise.
- The IAM table gains tenancy, metadata-tag and market-type conditions. It also states the residual risk around termination protection and shutdown behaviour, with a check after launch.
- The `pendingTime` check waits until it has been verified.
- Steering messages are bound to the owner's input ID.

### Devin review (`8574bb7`)

Devin raised two points, both adopted:

- **Credential rotation.** A lost `hello` response during rotation would have locked a warm box out. The previous credential now stays valid until the new one is first used.
- **Journal index.** This entry was missing from the topic paths. It is now added to the DevOps path and the delegation case study.

The reviewer approved `6054397` and asked for the rotation rule to be stated precisely. Devin independently found that overlapping retries could leave a box holding a superseded credential. Both are now covered:

- rotation is idempotent for each predecessor and recorded before the reply;
- the predecessor may only retry `hello`;
- the box persists the replacement before using it;
- any use of a retired credential is handled as compromise.

## Revised plan: no CodeBuild box provider — 19 October 2026

After the design merged, the owner asked (reported) why phase 2 still used CodeBuild. Phase 2 had been placed on CodeBuild only so that it could start before any AWS changes, and that reason does not hold up:

- A CodeBuild box cannot stop or run a container per task, so the provider would be built only to be retired.
- It would leave the EC2-specific risks untested: IAM, stop and start, the trust reset and boot time.
- Today's coding path on CodeBuild already provides the fallback without being wrapped as a box provider.

The plan is now: build the box layer with a fake provider for tests and a local process provider for development, then the EC2 provider and its CloudFormation, which the owner applies. Coding moves onto EC2 boxes after that, and its current CodeBuild path stays untouched until then.

### Phase 2a: foundation (dormant)

Added:

- `db/032_boxes.sql`, staged on 19 October as `db-staged/032_boxes.sql` (see below);
- `src/boxes/` (provider interface and fake provider, credentials, `BoxController`, `/boxes/*` routes);
- `tests/boxes.test.ts`.

Nothing is wired into the gateway yet.

Implemented as designed:

- The bootstrap secret is the epoch-0 credential, so the bootstrap exchange and later restarts share one rotation path, which is idempotent until first use.
- Credentials are derived (HMAC of host key, box, predecessor hash and epoch), so only hashes are stored.
- A retired credential sent to `hello` is refused and alerted; one used on the channel is compromise.
- A box cannot complete `hello` before its provider resource is recorded.
- Restarts of stopped boxes count against concurrency.

Long-polls last 8 s, well inside the proxy's timeouts.

**Review of `9c27cd2` (Claude Opus 5.5): changes requested.** The credential design held up: none of the races examined could leave a box with no valid credential, two live credentials, or a credential an attacker could obtain. Two reconciler defects blocked approval:

1. **Idle stop.** A box that had acknowledged a freshly delegated task, but not yet reported busy, could be stopped as idle, and the task would then sit queued until retention expired. A box with any open task is now never idle.
2. **Orphaned tasks.** Tasks could be left open on a dead box in two ways: the stopping-to-ended path skipped task failure, and `delegate` could race a close. Delegation now locks the box row in one transaction, and every path that ends or holds a box fails its open tasks.

Non-blocking findings, all adopted:

- events are recorded and applied in one transaction;
- the sweep checks each resource's environment tag;
- steering is bound to an owner input of the current turn;
- `hold` is guarded against overwriting a close;
- the bootstrap hash is kept for the box's life;
- identity is verified before rotation, so a thief cannot get the real box terminated;
- message sequencing runs under the box lock;
- provider calls are time-bounded and sweep errors are contained;
- claims rotate by last reconciliation;
- a box closed during an uncertain launch is found and ended;
- a lost stop is retried;
- unknown errors return a generic 500;
- the documentation was corrected.

Ten new tests cover these fixes.

**Re-review of `87e19ee`: approved.** Three non-blocking points were adopted:

- **Restart for open tasks.** A stopped box now restarts for an open task, not only for an unacknowledged message. This covers a task acknowledged during the stop.
- **Identity checks gated.** Identity verification and its alert are reached only with a live credential, so knowing a box ID is not enough to trigger an alert.
- **Lease length.** The reconciler lease now outlasts a worst-case pass.

**Devin review of `8841ae6`.** Devin raised six points. Four were defects, now fixed and tested:

- **Stuck in starting.** A retried `hello` after a lost rotation answer returned the right credential but left a warm-starting box marked `starting`. The idle and lifetime checks then never applied to it. The retry now connects the box, and a connected box found still `starting` is repaired to `ready`.
- **Idle race.** The idle check ran outside the box lock, so a task delegated at that moment could be failed by the idle shutdown. The idle decision is now taken under the same row lock that delegation takes.
- **Stranded boxes.** Removing a profile held its boxes without ending them, and the sweep skipped providers that no profile used. Termination now needs only the provider. A box whose profile is gone is ended; a box whose provider is gone is held for an operator. The sweep visits every configured provider.
- **Concurrency across hosts.** Admission was not serialised across hosts. A per-profile advisory lock now guards launch and restart admission. Only one host runs today, so this is defensive.

The other two points:

- **Early long-poll abort.** Devin said a GET's request `close` aborts the long-poll at once. This was not reproduced on Node 22.19 with Fastify 5.12: a test with the old binding still waited the full interval. The abort is now bound to the response closing before it is written, which is correct on any version.
- **Events from an earlier epoch.** These are kept deliberately. An agent sends events queued before a rotation under their original epoch, with its current credential. Task updates apply only to queued or running tasks, so an old event cannot overwrite a finished one.

### Phase 2b: the box agent and local provider

The box agent dials out, keeps its credential durably, polls, runs tasks through a runner, and ends the box when it must. A local provider runs agents as processes with stop-and-keep-disk semantics, so the whole loop runs on a developer machine and in CI without AWS.

**Measured (tested).** The end-to-end test passes locally. A real agent process:

- connects and completes two tasks in one box;
- relays an owner answer to a waiting task;
- stops after the idle TTL;
- restarts warm on new work, rotating to epoch 2 with its stored credential;
- closes with verified termination.

**Not yet measured.** The container runner's trust-reset test runs only in CI, because Docker was unavailable on the development machine. EC2 boot and warm-start times wait for phase 2c.

**Found while building.** The agent's task-journal file and the runner's work directory shared a name (`state/tasks`), and the agent crashed on its first task. The work directory is now `state/work`, and a runner that cannot start a task produces an honest task failure instead of a crash.

**Re-review of `7400212`: approved, with no deadlocks found.** Four non-blocking points were adopted with phase 2b:

- the idle decision re-checks `idle_since` under the lock;
- busy/idle reports from an earlier epoch are recorded but no longer applied;
- the long-poll comment is now worded as a defensive choice;
- the design states that removing or renaming a profile ends its boxes.

**Review of phase 2b (`98754ca`, Claude Opus 5.5): changes requested.** Four blocking defects:

1. **Late owner message.** An owner message arriving after a task's result crashed the agent with a write-after-end on the task's input. Late writes are now dropped. A deterministic test fails without the fix and passes with it; an earlier, timing-based test passed either way.
2. **Fresh box killing itself.** A box whose launch the host had not recorded yet got a 401 at its first `hello` and shut itself down. A transient failure of the identity provider did the same. Both now return 503, which the agent retries.
3. **Dropped results.** An oversized or malformed result was dropped with a 400, leaving the host's task open until the hard maximum. Final payloads are now validated in the box, and a result the host rejects is replaced by a bounded failure.
4. **Trust reset failing open.** A reset failure during restart recovery was ignored, and an unreachable Docker daemon passed the leftover check. Both now end the box.

Non-blocking findings, also adopted:

- **Box lifetime:** the lifetime is enforced locally, and a box that cannot reach the host for too long ends itself.
- **Task lifecycle:** tasks get a deadline and are killed a grace period after their result. Acknowledged tasks are requeued after a restart. SIGTERM cancels the running task.
- **Output and input bounds:** output lines are bounded and progress is rate-limited. Task IDs are validated.
- **Docker runner:** it takes memory and CPU limits, and its capability probe now runs through the runner itself.

Still open, development only: the local provider keeps the bootstrap secret in its metadata, and it loses track of agents after a host restart.

### Release blocked by the migration, and unblocked — 19 October 2026

PR 259 merged with `db/032_boxes.sql` but no Compose inventory line and no operator rollout. The release guard in `scripts/cloud-release.py` refuses any change to `db/` or `compose.yaml` that a reviewed rollout has not installed, so the release of `860c45e` was refused (measured: release run 39157500387, "Database or Compose change requires a reviewed migration/deployment procedure"). Production stayed on `ef37e12`, and every later merge to main, from any session, would have been refused the same way.

The box layer is dormant and nothing reads its tables, so the migration moved to `db-staged/` until phase 2c installs it with a reviewed rollout. The guard then sees `db/` unchanged, and the normal release proceeds.

Lesson: a migration enters `db/` only together with its Compose inventory line and a reviewed rollout that runs right after the merge, never with dormant code alone.

**Re-review of `816b873` and `e4e8470`: approved.** Two of the reviewer's last points were adopted after rebasing on the unblocked main:

- a question that exceeds its one-per-second budget is delayed to the next free slot rather than dropped, so a task asking two questions quickly cannot wait forever for the second;
- the rate-limit wording in the docs now matches the code.

The phase 2b tests load the staged box migration.

**Devin review of PR 260.** Of twelve findings, several described earlier commits and were already fixed. Six applied to the current head, and five of them are now fixed and tested:

- **Interrupted cleanup and lost outcomes.** A restart between reporting a task's outcome and cleaning up after it could leave the task's container behind, which would then end the box. A restart before the outcome reached the host could lose the result. The task journal now records each step, so recovery re-reports a recorded outcome and completes an interrupted cleanup.
- **Oversized instructions.** Instructions larger than the box limit were run as an empty task. They are now refused, at delegation by the host and on arrival by the agent.
- **Late or bursting questions.** Questions are sent by a single drainer, one per second, and only while their task is active. A question can no longer arrive after its task's result, and an event-loop stall cannot burst several at once.
- **Shared daemon.** Task containers are labelled with their box ID, so two boxes sharing a Docker daemon cannot fail each other's reset. On EC2 each box has its own daemon.
- **Admission order.** A flaky test exposed that first-come admission tied on `created_at` at the database clock's millisecond resolution. Boxes now carry an arrival sequence.

Not changed, with reasons replied on the threads: task network egress (phase 2c), the local provider's stored bootstrap secret (development only, documented), and an answer acknowledged before an agent crash (the interrupted task is failed, not resumed, so no answer is silently lost).

The re-review of `5686ed1` approved it and noted three small points, all adopted. A refusal is now journalled as a finished failure, so a restart cannot run the refused task with empty instructions. The Docker test's own leftover check matches any task label. A task with more than 20 questions waiting is stopped.

### Phase 2c-1: the EC2 provider — 19 October 2026

The EC2 provider, the first-boot script, identity verification, the CloudFormation stack and its runbook, and a `DryRun` IAM check are built and tested against fakes. Nothing launches yet; the owner applies the stack, and phase 2c-2 wires the layer.

**From documentation, not yet measured:**

- The base64 instance identity signature is verified with the region's RSA certificate, copied from the EC2 User Guide's regional certificate list. It is valid until 29 April 2029.
- The guide's procedure uses SHA-256. Both SHA-256 and SHA-1 are accepted until the first real box shows which one AWS uses.
- `DryRun` answers with DryRunOperation when a call would be allowed and with UnauthorizedOperation when it would not, so the IAM check launches nothing. A case that fails validation before authorisation is reported by name, so it is never mistaken for a refusal.

**Tested:**

- The first-boot script parses with `bash -n`, and unsafe values are refused.
- Launch uses the template, the client token, the tags and the attribute check.
- Lookups are scoped to this environment and handle pagination.
- Identity verification accepts a correctly signed document and refuses a wrong instance, a wrong account, a tampered document or a malformed proof.
- The template keeps boxes closed and the controller narrow.
- The IAM check classifies every outcome correctly.
- A task flooding questions is stopped once, with a clear reason.

**Review of `d111769` (Claude Opus 5.5): changes requested.** The blocking finding was that the IAM check never tagged the volume, so it did not send the request the provider sends. Its "allowed" case would have been refused, and refusals could pass for the wrong reason. The check now builds its legitimate case from the provider's own request function, with two more cases for a wrong or missing volume tag and two for network overrides.

Also adopted:

- **Metadata errors:** a throttled or failed metadata read now throws and is retried. Before, its error page was sent as proof, refused, and the box powered itself off.
- **Attribute check:**
  - The read-back now retries while EC2 catches up after a launch.
  - It also runs when an instance is found after an uncertain launch, so a refused instance is never adopted.
  - It now also checks `disableApiStop`.
- **Signature:** only SHA-256 is accepted. AWS's documentation confirms SHA-256 for this signature, and the pinned certificate matches AWS's published one.
- **Tests:** the identity tests now use a real X.509 certificate and check that the pinned certificate parses.
- **Inconclusive cases:** these no longer fail the IAM check, matching the runbook, and the runbook checks both launch templates.
- **Docs:** they now state that Docker comes from Amazon Linux's signed repository rather than a pinned artifact, and they name the limits IAM cannot bound (`MaxCount` and extra volumes).

### Phase 2c-2: wiring and installation — 19 October 2026

This phase turns the dormant layer into something the owner can enable. It adds:

- the gateway wiring behind `BOXES_RUNTIME`, off by default;
- `config/boxes.json`, with an `echo` profile for the EC2 proof;
- an operator probe;
- delivery of owner notices;
- the reviewed rollout (`scripts/deploy-boxes.py`), which installs migration 032, its Compose line and the `/boxes/*` Caddy route.

It also carries the review points from 2c-1:

- a launch or close whose provider search keeps failing is held after the timeout instead of looping;
- an inconclusive legitimate launch fails the IAM check.

**Not yet done:**

- The `echo` profile is pinned to worker image `sha256:734e2dcb…`, built from main `3feef85` (Pi image workflow run 39196451508). That image contains `dist/boxes`, but it predates the agent's support for the profile's task command, so its echo tasks would start the image's default program. The image must be rebuilt from main after this merge and re-pinned before boxes are enabled.
- The rollout baseline must be set to the live release just before merging. The rollout itself runs right after the merge, with the owner's go-ahead.

The controller policy now also pins the subnet and security-group resource ARNs to the stack's own IDs, in addition to `ec2:IsLaunchTemplateResource`. This responds to a Devin comment on PR 264; the condition already refused overrides.

**Review of `a5e6bdd` (Claude Opus 5.5): changes requested.** Two blocking defects:

1. **Settings never reached the gateway.** Compose passes the gateway's environment explicitly, so `BOXES_RUNTIME`, `BOX_AUTH_KEY` and `BOX_AWS_ACCOUNT_ID` would not have arrived. Adding them later would have needed a second operator rollout. They are now in `compose.yaml`, and the rollout accepts exactly that addition.
2. **The pinned image could not run the echo task.** That image predates the task-command support. The docs now require a rebuild and re-pin before enabling.

Non-blocking findings, all adopted:

- **Caddy step:**
  - The Caddy change is checked before anything changes.
  - A Caddy-only rerun is possible after a partial rollout, and a manual fallback is documented.
  - Validation runs beside the live file.
  - Every error says what is already installed, and a failed restore is reported specifically.
  - The route check parses the origin robustly and goes through local Caddy with `--resolve`.
- **Gateway and configuration:**
  - The AWS rollback runbook now closes boxes before turning them off.
  - Notices are suppressed for owners who are no longer allowed.
  - The box modules load only when boxes are on.
  - Launch settings, the image digest and the public origin are validated at startup.
  - A second hold gets its own notice.

The re-review of `fc97cef` approved it. Devin then found three more issues, all fixed:

- **Rerun guard.** The Caddy-only rerun path would accept the baseline commit as "already deployed". It now runs only when the release equals the requested commit, that commit is not the baseline, and migration 032 is installed.
- **Key separation.** `BOX_AUTH_KEY` must differ from `CODING_AUTH_KEY`.
- **Notice retry.** A notice Telegram definitely refused (rate limit) goes back to pending and is retried. An unknown outcome stays uncertain and is never repeated.

### Phase 2c installed — 19 October 2026

PR 265 merged as `5f46cb4`, and the reviewed rollout ran over the operator SSH connection with the owner's approval.

**Measured (from the rollout output and separate checks):**

- deployed and healthy, migration 32 installed, Caddy route added;
- marker 32 present, with empty box tables;
- publicly, `/boxes/...` reaches the gateway (JSON 404 while boxes are off), and other paths keep Caddy's plain 404;
- no errors after `gateway.started`;
- the automatic release for the same commit then succeeded as a no-op.

The worker image was rebuilt from `5f46cb4` (`sha256:3963041707149df106d0c11238f1792e1145b58bbe1108f0cf0b1bdeaad5734d`, Pi image workflow run 39213526240) and the `echo` profile re-pinned to it, so the box agent understands the profile's task command.

**Still to do:** the owner applies the AWS stack and enables boxes; then the IAM check and the EC2 echo proof.

### Enabled and first EC2 echo proof — 19 October 2026

**AWS stack.** The owner ran the `chief-boxes-prod` deploy in CloudShell (account `149948097061`, `ap-southeast-1`, default VPC subnet `subnet-065a90067df416749`, controller `chief-coding-controller`). All four resources reached `CREATE_COMPLETE` at 14:31 UTC, and the stack policy is attached to the controller user.

**Incident (no effect).** At 14:33 a second, malformed update ran: a deploy command Claude had typed into CloudShell, but not run, was still on the input line, and Claude's next command was appended to it (`ControllerUserName=chief-coding-controllerclear`). IAM refused the unknown user, and CloudFormation rolled back to the created state (`UPDATE_ROLLBACK_COMPLETE`, policy restored and still attached). Lesson: clear the terminal input line before typing anything into a shared shell.

**IAM check (dry runs from the gateway with the controller's own credentials).** No failures:

- `echo` template: 15 passed, 0 failed, 5 inconclusive.
- `coding` template: 16 passed, 0 failed, 4 inconclusive.
- The legitimate launch was allowed for both, and every instance-type, image, metadata, volume, spot, tag and no-template override was refused.
- The inconclusive cases were rejected by AWS before the permission check: a made-up key pair and instance profile, security-group and subnet overrides (`InvalidParameterCombination` against the template's network interface) and, once, a throttled dedicated-tenancy call (it passed for `coding`). They prove nothing either way. They are covered elsewhere: the security group has no ingress, the policy grants no `iam:PassRole`, and the subnet and security group are pinned to the stack's IDs.

**Enablement.** With the owner's request to enable boxes, `.env` was backed up on the host, `BOX_AUTH_KEY` was generated there with `openssl rand -hex 32` (never displayed), `BOX_AWS_ACCOUNT_ID` and `BOXES_RUNTIME=on` were added, and the gateway was recreated at 14:35 UTC on release `0e33cfe`. It became healthy with no warn or error lines. An unauthenticated `POST /boxes/<id>/hello` on the public origin now gets the gateway's 400 instead of the 404 it returned while boxes were off.

**EC2 echo proof (measured with `dist/boxes/probe.js`).**

| Step                      | Result                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn                     | Requested at 14:36:19, launch started 14:36:30, instance `i-0833a4914fc64de12`                                                                                                                                                                                            |
| Cold boot to first report | 161 s from launch (first boot installs Docker and pulls the worker image)                                                                                                                                                                                                 |
| Two tasks in one box      | Both echoed correctly; each completed within a second of delivery                                                                                                                                                                                                         |
| Real instance             | `t3.small`, IMDSv2 required, hop limit 1, no instance profile, no key pair, the stack's security group and subnet, `disableApiTermination=false`, shutdown behaviour `terminate`, tagged `chief:box` and `chief:env=prod`; encrypted 20 GiB gp3 volume with the same tags |
| Idle stop                 | Stopped at 14:55:16, about 15.5 minutes after the last task (15-minute TTL plus the tick)                                                                                                                                                                                 |
| Warm start                | A task delegated at about 14:55:48 started the box; first report at 14:56:16 (about 28 s) on credential epoch 2; the task finished by 14:56:26                                                                                                                            |
| Close                     | `terminating` to `terminated` in about 25 s; AWS shows the instance `terminated` and no `chief:env=prod` instance or volume left                                                                                                                                          |

No owner notices were raised and no warn or error lines were logged during the proof.

**Not yet measured on EC2:** steering (the probe cannot send an owner message), the trust reset with the hostile and inspect tasks, inspection, the orphan sweep after a gateway restart, retention termination, and whether `pendingTime` changes on every start. Those need probe support or a gateway restart test and are the rest of phase 3.

### Owner decision and probe for the rest of phase 3 — 19 October 2026

**Owner decision.** The owner said "we can close out codebuild btw and focus on this ec2". Claude's reading, to be confirmed by the owner: phase 4 moves coding onto EC2 boxes with no CodeBuild fallback, and phase 6 removes the CodeBuild path as soon as coding runs on boxes. Until then the CodeBuild path keeps running coding jobs.

**Probe extension.** The first proof could not steer, run the hostile and inspect tasks, or create an orphan. The probe now has:

- `delegate` flags for the `echo` task (`--wait`, `--hostile`, `--inspect`, `--probe`);
- `steer`, which sends an owner message into a queued or running task. Its controller accepts only the probe's own input IDs; Chief's controller still refuses all steering (no owner-input check is wired yet).
- `orphan`, which launches one instance from the profile's template for an unknown box ID and stops it as soon as it runs, so only an API call (the sweep) can end it.

**Review of `ccd91d5` (Claude Opus 5.5): changes requested.** The first `orphan` launched and left the instance running. Its hello would be refused about 160 s after launch, and the agent then powers the instance off, which with `terminate` shutdown behaviour ends it. The sweep runs every 5 minutes, so about half the runs would have shown a terminated orphan without the sweep doing anything. The orphan is now stopped before it can say hello, and acceptance is a CloudTrail `TerminateInstances` for it after the stop. The re-review of `890b3f6` approved, and noted that the reason code and caller cannot tell the probe's stop from the sweep (both are the controller user), that an early sweep or a transient describe error would have aborted the probe, and that a stopped orphan now depends on the sweep. The probe now retries early misses and errors, reports `sweptBeforeStop` instead of failing, and the run checks CloudTrail. The steering wording was also corrected: Chief's controller has no owner-input check wired yet and refuses all steering.

The planned phase 3 run, after this ships: steering with a gateway restart while the task waits, hostile then inspect in one box (trust reset), the task's privileges, an orphan swept, `LaunchTime` before and after a warm start, and a stopped box left to reach the 24-hour retention.

### Phase 3 on EC2 — 19 October 2026

PR 269 merged as `a229d91`, and its [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39287014208) deployed the extended probe. The release for `0aadc97` (PR 268) had correctly refused, because main had already moved. One `echo` box, `d423dcdf…` (instance `i-0adb8580eff24ac19`), ran every check below. Times are UTC.

**Measured:**

| Check                             | Result                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold boot                         | Requested 16:43:02, ready 16:45:13; launch to first report 113 s (161 s for the first box)                                                                                                                                                                                                                                                                                                                                                  |
| Task privileges (`--probe`)       | uid 1000, no effective capabilities (`CapEff` 0), read-only root                                                                                                                                                                                                                                                                                                                                                                            |
| Trust reset                       | A `--hostile` task wrote marker files in its home, working directory and `/tmp` and left a detached process; the next `--inspect` task in the same box found no leftovers                                                                                                                                                                                                                                                                   |
| Steering across a gateway restart | A `--wait` task was running when the gateway restarted (16:45:56, healthy at 16:46:21). After the restart, `steer` delivered "steered after the restart"; the task finished once with that message. The box kept epoch 1 (no new hello). `box_messages`: 4 `task.assign` and 1 `task.message`, all acknowledged; 4 tasks, none duplicated                                                                                                   |
| Orphan sweep                      | `orphan echo` launched `i-0de08118cdb5edf61` for an unknown box at 16:47:12 and stopped it at 16:47:16. CloudTrail: `RunInstances` and `StopInstances` (the probe), then `TerminateInstances` at 16:51:22, all by `chief-coding-controller`. The probe never terminates and a stopped instance cannot end itself, so the termination was the gateway's sweep, five minutes after its first sweep at restart. Its volume was deleted with it |
| Idle stop                         | Last task 16:46:5x; stopped by 17:02:10                                                                                                                                                                                                                                                                                                                                                                                                     |
| Warm start                        | Delegated 17:02:18, first report 17:02:42 (about 24 s) on epoch 2; an `--inspect` task there found no leftovers                                                                                                                                                                                                                                                                                                                             |
| `LaunchTime`                      | 16:43:09 before the stop, 17:02:22 after the start: it changes on every start                                                                                                                                                                                                                                                                                                                                                               |

No warn or error lines were logged and no owner notices were raised.

**Not measured:**

- **Retention.** The box was left to idle-stop again and should be terminated about 24 hours after that stop (`retentionHours` 24). An hourly watcher is checking.
- **`pendingTime`.** Only `LaunchTime` was observed. The identity document's `pendingTime` was not, so the design still does not check it.
- **Steering from Chief.** Chief cannot steer yet: no owner-input check is wired, and that arrives with phase 4.

### Phase 4a: coding attempts in boxes — 20 October 2026

**Owner decision confirmed.** "Confirmed, start phase 4": coding moves to EC2 with no CodeBuild fallback, and CodeBuild is removed once coding runs on boxes.

**Exploration.** Two read-only explorations of main `5e53e8f` covered the Pi worker's runtime needs and the coding controller's provider semantics. Findings, from code:

- Coding already runs behind a five-method `SandboxProvider`, so a box-backed provider keeps every host policy and per-call check unchanged.
- The worker reads its identity only from four environment variables and never uses stdin or stdout. It needs a small adapter that speaks the box task protocol.
- The worker puts everything under `TMPDIR`: clones (one more per review round), `npm ci`, the npm cache and tests. That is an estimated 450–650 MB, beyond the task container's 512 MB `/tmp` tmpfs, so the adapter points `TMPDIR` at the box disk.
- The controller's 180-second heartbeat rule starts at claim. A cold EC2 box (113–161 s to first report, plus container start) would be paused as `heartbeat_lost` before the worker spoke.
- `terminal` from `inspect` must mean the compute is gone, because cleanup completes on it.
- Box rows store their own image, but a job snapshots its image at start. Older images predate box support, so routing has to be by image.

**Design.** Phase 4a is recorded in the [design](../boxes.md#phase-4a-coding-attempts-in-boxes): `BoxSandbox`, `RoutedSandbox`, the `coding-task` adapter, a provider startup grace and a `sandbox` switch in `config/coding-backend.json`, with the default left on CodeBuild. No schema or Compose change.

**Status.** Implemented and tested locally; not yet reviewed or deployed. To go live after merge:

1. Rebuild the Pi image so it contains the adapter.
2. Re-pin `config/coding-pi.json` and add the `coding` box profile with that image.
3. Switch `sandbox` to `box`.
4. Run a canary job on EC2.

**Review of `e82c4c2` (Claude Opus 5.5): changes requested.** Two blocking defects, both fixed:

1. **The task program undid the worker's token protection.**
   - On CodeBuild the worker locks itself down: it becomes non-dumpable and a subreaper, and its parent is CodeBuild's root agent. In a box, the task program is the container's main process, runs as the same user as repository commands, and held the token without either protection.
   - A command could have sent it SIGUSR1 and attached Node's inspector, or read its memory through `/proc`.
   - **Fix:** the task program now requires `--disable-sigusr1` and the native lockdown before it reads the task, and refuses the task otherwise. The gateway pins the coding profile's task command at startup. Tests cover both refusals and the lockdown order.
2. **Switching back to CodeBuild would have wedged coding.**
   - With the switch on `codebuild`, the provider was CodeBuild alone. An attempt with a `box:` sandbox ID would then have errored on every tick and blocked the coding queue.
   - **Fix:** whenever a coding box profile exists, box attempts stay routable and the switch only gates new attempts. Without one, startup is refused while an attempt still depends on a box. A test covers this.

Non-blocking findings adopted:

- **Held boxes.** A held box is no longer an error: the attempt pauses normally, and its box is never closed over the hold.
- **Unstated reasons.**
  - The idle close and infrastructure faults are now unstated, so they are retried once like a CodeBuild failure.
  - Limits, a compromise and an operator close remain stated.
- **Token storage.** The token is removed from stored payloads once the box is gone.
- **Task program.** It ignores `null` input and a second task, and exits without forcing the process.
- **Startup.** The coding profile must admit one box at a time.
- **New test.** A controller-level test runs the real `BoxSandbox` through `CodingController.tick`: grace, a worker exit, closing before cleanup, `sandbox_stopped`, and cleanup completing.

**Re-review of `be366aa` (Claude Opus 5.5): approved.** Its remaining notes:

- **Duplicated reason strings.** They err safe: reworded text becomes stated.
- **Unrecorded boxes.** The stranded check missed a box whose create was never recorded. Fixed below.
- **Test title.** One title overstated the retry and was renamed.
- **Canary check.** Subreaper cleanup needs checking on the AL2023 kernel during the canary.

**Devin on PR 276.** Three findings, all fixed:

1. **An unrecorded box could still strand coding.** The rollback check now also refuses while a live `coding` box exists, and a test covers it.
2. **A CodeBuild outage blocked startup on boxes.** With `sandbox: box`, a failed CodeBuild project check is now logged instead of fatal.
3. **The coding-agent learning guide was missing an entry.** It now has one.

**Re-review of `082a1e7` (Claude Opus 5.5): approved.** It noted that older-image attempts can still launch on CodeBuild after a skipped startup check. A lazy re-check before each launch would put a misconfiguration on the stuck-for-operator path and block box jobs as well, so the docs now state the limit and treat the warning as an operator alert.

### Phase 4a go-live — 20 October 2026 (Singapore time)

PR 276 merged as `7e648f9`. The Pi worker image was rebuilt from it ([run 39302600676](https://github.com/akhilvuputuri/chief-agent/actions/runs/39302600676)) as `sha256:ba99d9555bbeb3df5eb4f5ce57488c1ce2aaccf22f68ebf75750df75af34af05`, so it contains the coding task program.

The go-live change:

- re-pins `config/coding-pi.json` to that image;
- adds the `coding` box profile with that image:
  - limits: one box at a time, a 3-hour hard maximum, a 1-day absolute limit, and no stopped retention, because each box serves one attempt;
  - EC2 settings: the `chief-box-prod-coding` template (`m7i.xlarge`, 60 GiB), 12 GiB of memory and 3 CPUs for the task, and the pinned task command;
- switches `sandbox` to `box`.

A new test runs the gateway's coding sandbox startup checks against the reviewed configuration files, so a mismatch fails in CI rather than at release.

**Pending:** the release, then a canary coding job on EC2, which needs an owner request through Chief. The canary checks:

- the cold boot until the worker's first heartbeat;
- the worker's checks and review inside the box;
- that the attempt's box is terminated;
- that the worker's subreaper cleanup works on the AL2023 kernel.

**Released and switched.**

- Phase 4a deployed in `7e648f9` (18:55 UTC on 19 October).
- The switch (PR 279, `d6549b9`) went live in `becf234` at 20:13 UTC: healthy, no startup error.
- No coding job was requested in the following hours, so the canary is still pending.

**Measured smoke test (20 October, 02:52 UTC).**

- `probe spawn coding` launched a real `coding` box (`m7i.xlarge`) with the new image. Its first report came 84 s after launch, faster than the `t3.small` echo boxes.
- The probe's echo-style task is not a valid coding task. The task program answered "Invalid coding task", which it returns only after both `--disable-sigusr1` and the native lockdown succeed, so the token boundary works under the box's Docker flags on AL2023.
- Closing the box terminated it 12 s later. No warnings.

This proves the image, the boot and the boundary. It does not prove the worker itself: that needs the canary.

### First real coding attempt on EC2 — 20 October 2026

**Measured canary.** The owner started a coding job in plan mode (`fa7e618b`, created 05:08:55 UTC). It was claimed at 05:11:48, once the slot freed (see below). Its attempt ran in `coding` box `6fba7a28` (instance `i-0ae2dd66c57ad9e36`):

| Step                      | Result                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Box requested, launch     | 05:11:48, launch 05:12:03                                                                             |
| First report from the box | 05:13:35 (92 s after launch)                                                                          |
| Worker planning           | Running by 05:13:57; 8 model calls                                                                    |
| Worker finished           | 05:15:09: plan recorded (about 8,800 characters), `plan_ready`; the task program reported exit code 0 |
| Box closed and terminated | Terminated 05:15:33 ("Coding attempt ended"), 24 s after the result; cleanup `complete`               |
| Token at rest             | Removed from the stored task payload after termination                                                |

No box-related warn or error lines were logged. The host-side flow ran unchanged through the box: assignment, heartbeat, Pi session, checkpoints, model proxy and finish.

**Implementation attempt, measured (same job, after plan approval).**

| Step                  | Result                                                                                                                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Box `914da6bd`        | Requested 05:22:18, launch 05:22:33, first report 05:24:02 (89 s)                                                                                                                                                                                                                            |
| Checks inside the box | `npm ci` 0 (05:25), `npm run check` 0 (05:39, about 14 minutes including the full test suite), `npm run build` 0, `npm run format:check` 0                                                                                                                                                   |
| Review                | Started 05:39:52; the first reviewer call succeeded. Two later reviewer calls (`google/gemini-4-argon` through OpenRouter) failed with provider 504 at 05:40:24 and 05:40:49. The worker paused ("Model run did not finish cleanly; session retained") and exited 0. Box terminated 05:41:47 |
| Automatic retry       | 05:43:03, in a fresh box `f86ceb8a`. The worker resumed its saved session straight into review at 05:44:48 without repeating the checks                                                                                                                                                      |
| Result                | Review passed; the box was terminated at 05:46:11; Chief published [PR 285](https://github.com/akhilvuputuri/chief-agent/pull/285) (a two-line README change) and is waiting on its CI and Devin                                                                                             |

The pause was a model-provider fault, not the box. The main model also saw provider 504s that morning.

**Measured:** the whole job ran on EC2, across three boxes (plan, implementation, automatic retry), with checks, review, publication and termination. No attempt used CodeBuild.

**Not yet observed:** the worker's subreaper cleanup on the AL2023 kernel. No attempt left stray processes to clean up.

**Defect found around the canary: cancelling paused jobs.** Just before the canary, the owner continued an old job (`1a6cf84e`). Its snapshot carried the old image, so it ran on CodeBuild and held the single coding slot. Chief then tried to cancel the ten old paused jobs, twice. Every cancel failed with `ACTIVE_WORK_EXISTS` (a `duplicate key` on `coding_one_active_worker`).

- **Cause.** Cancel set `cleanup='pending'` for any job with an attempt ID, even a paused job whose sandbox was already cleaned up (`complete`) or never created (`none`). The single-worker index counts pending cleanup as active, so the cancel collided with the running job, or with the previous cancel in the same batch.
- **Fix.** Cancel now reopens cleanup only for an attempt that is actually running (provisioning, running or publishing).
- **Regression test.** It cancels two cleaned-up paused jobs and one that never had a sandbox while another attempt runs. It fails without the fix with the production error.
- **Release.** [PR 283](https://github.com/akhilvuputuri/chief-agent/pull/283) passed exact-head independent review (Claude Opus 5.5), hosted CI and Devin. It merged as `53a2cdb` and went live in `97776fa` (healthy).

**Rebase rounds on EC2 (measured, 20 October).** After PR 285 opened, main moved twice: to `53a2cdb`, then `97776fa`. Each time Chief re-applied the approved change in a fresh box: `f6992faf` at 05:46–06:08 and `09d24cc1` at 06:26–06:45. Each first reported about 93–95 s after launch, passed its checks and exited 0, and the PR was updated. The owner merged PR 285 at 07:12 from the merge card. This is the cost phase 4b's warm reuse would cut: about 1.5 minutes of boot and roughly 18 minutes of checks per round, in a new machine each time.

### Phase 6: CodeBuild removed — 20 October 2026

**Cancelling the old jobs.** At the owner's request, the ten old paused jobs were cancelled from the operator shell. Each update ran the controller's own (fixed) cancel statement, limited to those IDs and to jobs still paused and unpublished. All ten became `cancelled` with cleanup `complete`, and the standard "cancelled" notice was queued for each.

**Code.** Implemented and tested; in review.

- The CodeBuild sandbox, its SDK dependency, timeout-confirmation handling and the `sandbox` switch are removed. Coding requires boxes and the reviewed `coding` profile.
- Startup is refused while an attempt depends on a CodeBuild build.
- A job's box is started with the job's own snapshotted image when the coding profile lists it (`image` or `previousImages`). A job whose image is not listed is paused before launch with "start a new coding job", so it frees the queue. That covers three old `plan_ready` plans and PR 232's job, which predate boxes.
- **Tests.** The CodeBuild-only tests (buildspec, timeouts, build states, Python launcher) are removed. New tests cover the startup checks, the old-image refusal at the controller, and the box sandbox's acceptance rule. 297 coding and box tests pass, with 1 Docker test skipped.

**AWS teardown** is an owner step after release; see the [design](../boxes.md#phase-6-codebuild-removed).

**Review of `251f0d5` (Claude Opus 5.5): changes requested.**

- **Blocking.** The box sandbox accepted only the coding profile's current image, but jobs keep their snapshotted image through plan approval, rebases, feedback rounds, resumes and retries. The first routine Pi image re-pin would therefore have paused every in-flight job, wrongly blaming CodeBuild. Under phase 4a, CodeBuild had absorbed those jobs.
- **Fix.** The profile now lists `previousImages`, and `spawn` accepts an image from that list. Each box is started with the job's own image. The re-pin procedure moves the old digest into the list, and the refusal message no longer blames CodeBuild.
- **Non-blocking, also adopted:**
  - The startup check now also refuses an unrecorded launch whose image no box runs.
  - Two generic reconciliation tests are restored with the fixture provider: one where the sandbox is found and recorded, one where it isn't found and the job is paused.
  - The first sentence of `coding.md` is corrected.
  - The teardown runbook gives exact commands for inline and managed policies.
- **Tests.** 299 coding and box tests pass, with 1 Docker test skipped.

**Re-review of `862635f` (Claude Opus 5.5): approved.** Two of its notes were adopted:

- The startup check now fails closed on a job with no image.
- The docs say listed images must still speak the host's current box protocol.

**Devin on PR 287.** Both findings are fixed:

1. **Startup would block recovery of a live box.** An unrecorded launch whose image had been retired from the list would refuse startup, although the box sandbox finds its box by key. Startup now accepts such a launch when its box exists.
   - The finding also exposed a related gap, present since phase 4a. When a box launch failed before its row was written, "not found" left cleanup pending forever and held the coding queue.
   - Box lookups are authoritative (`authoritativeFind`), so "not found" now pauses the job with nothing to clean, or settles a pending cleanup, and the queue moves on.
2. **Learning guide.** The coding-agent learning guide gained its entry.

New tests cover both paths.

**Released and torn down.**

- **Release.** PR 287 passed exact-head review (Claude Opus 5.5), Devin and CI. It merged as `bd2ce04`, which has been live since 10:46 UTC on 20 October: healthy, no startup error, and no CodeBuild code in the deployed build.
- **Teardown.** The owner removed the inline `ChiefCodingProjectOnly` policy and deleted the `chief-coding` stack in CloudShell, after Claude had read the policy and confirmed it held only CodeBuild permissions.
- **Measured afterwards:**
  - no CodeBuild project, stack or worker role;
  - only the boxes policy on the controller;
  - the dry-run IAM check passes for both box templates.

CodeBuild is gone from the code and from AWS.

### Owner-facing wording — 20 October 2026

The owner noticed stale wording during the medium canary: "Python implementation is queued in a new sandbox", progress lines such as "Pi build: Running build" and "Pi plan: waiting_approval", and pause messages about the "sandbox". The host now rewrites them:

- the approval notice says the implementation is queued in a fresh coding box;
- worker progress is stored and shown in plain words, for example "Implementation started", "Plan ready for your approval" and "Check passed: npm run check". The translation is deterministic, so a retried report still matches its stored record;
- owner-visible pause and cancel messages say "coding box" instead of "sandbox".

The worker image is unchanged.

### Longer coding attempts on boxes — 20 October 2026

**Measured: the medium canary.** Job `791b6d8b` (`coding_status` box view):

- **Planning:** 20 model calls in one box.
- **Implementation:** ran the full 40-minute allocation in box `566f0543` (12:29 to 13:10 UTC), with 272 model calls costing about $0.26 (mostly `deepseek-v4.1-flash`). Context stayed near 26k tokens a call, with occasional compaction.
  - It carried on through a gateway restart (another session's release at about 12:56).
  - At the deadline it had saved a 20.6k-character patch across 4 files ("Ready"), but had not reached checks or review. The controller paused it ("time expired"), and the box ended cleanly.

The 40-minute limit (`limits.ms` 2,400,000) was set under CodeBuild's unexplained 45-minute cap ([journal 80](80-codebuild-timeout-mismatch.md)). Boxes have no such cap: a box task has a 2-hour deadline and a box a 3-hour maximum.

**Owner decision (20 October).** Raise the limits; most calls are cheap DeepSeek calls.

The settings schema capped attempts at 400 model calls and 1,000 tool calls, and the worker in the box validates its settings against its own copy of that schema. Raising them therefore needs a new worker image:

1. **Code (this change).**
   - The caps become 1,000 model calls and 2,500 tool calls; time stays at most 2 hours. The run-memory, Pi-state and squad-state counters follow.
   - Review found that the controller also capped every Pi attempt at 40 minutes, whatever `limits.ms` said: the same CodeBuild leftover. That ceiling is now 100 minutes, inside the box task's 2-hour deadline. Jobs already created keep their own 40-minute `limits.ms`.
2. **Configuration, after the image is rebuilt.**
   - Re-pin the image, moving the previous one into the coding profile's `previousImages`.
   - New jobs get 90 minutes, 800 model calls and 2,000 tool calls.
   - Jobs keep the limits they were created with.

**Review of PR 293 (Claude Opus 5.5): approved.** It confirmed that nothing else caps model or tool counts, and that older images never receive the higher limits, because a job snapshots its image and limits together. It also found the 40-minute controller ceiling, fixed above.

### Resumed canary paused by a host refusal — 20 October 2026

**Measured.** The owner resumed job `791b6d8b`, and the new attempt ran in box `09cac962`: launched at 15:17:09, first report 107 s later. Ten minutes in, after 111 completed model calls, the host refused the next model call with HTTP 409 `worker_request_rejected`. The worker treats that as fatal and paused ("Model run did not finish cleanly"), and the box ended cleanly.

- The refused call never reached the model-call ledger, so it failed a precondition on the host.
- The previous attempt had been cut off at its deadline with one coder call still `uncertain`. The resumed session continued from that state, and its patch grew from 20.6k to 49.2k characters (4 files to 11).

**Not known.** Which precondition refused the call; the rejection record carried no reason. Hypotheses, unconfirmed:

- the model slot was still busy for an overlapping call;
- a mismatch between the resumed session and the previous attempt's uncertain call.

**Change (in review).** Generic rejections now record a fixed reason code, and the model-slot claim names its refusing condition: `model_slot_busy`, `model_allocation_exhausted`, `attempt_deadline_passed`, `attempt_inactive` or `recovery_already_used`. The reason appears in `coding_status` as `lastFailure.reason`.
