# 91 — Can Chief delegate heavy work to sub-agents with their own boxes?

Work date(s): 2026-10-17. Written/revised: 2026-10-17.
Status: in progress. [Design](../boxes.md) recorded with owner decisions; the box-layer foundation (phase 2a) is implemented and dormant. No AWS resources yet.

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
