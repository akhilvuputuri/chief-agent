# Boxed sub-agents — design

Status: design, 17 October 2026. Nothing here is implemented yet. Tracking issue: [#245](https://github.com/akhilvuputuri/chief-agent/issues/245). Exploration: [journal 90](journey/90-boxed-subagents.md).

## Goal

Chief stays the always-on coordinator on Lightsail. For heavy work it **spawns a sub-agent in its own box**, **delegates** one or more tasks to it, **observes and steers** it while it works, **collects typed results**, and **closes** the box when done or when its time-to-live runs out. Coding is the first profile; analysis and crawling follow on the same layer.

Light sub-agents (`agent_run`, [agents.md](agents.md)) stay as they are: in-process children for context isolation. Boxed sub-agents are for work that needs real compute, untrusted code execution or a long lifetime.

## Owner decisions — 17 October 2026

- **Coding moves first.** No new profile is built before coding runs on boxes.
- **Short warm TTL.** A coding box stays alive for about 15 idle minutes so quick feedback reuses it, then it is put away. On EC2, "put away" means **stopped** (disk kept, compute released) rather than destroyed.
- **Self-managed EC2 is the target provider.** CodeBuild stays behind the same interface as the fallback until EC2 has passed a real coding job. Fargate and hosted sandboxes are deferred.
- **The plan is approved, including paid EC2 infrastructure.** The owner applies the AWS resources (CloudFormation in `deploy/boxes/`); Claude and Chief never create AWS resources or IAM.
- Cost is not the main concern provided boxes close themselves. Limits exist to stop runaways, not to save money; there are still no dollar caps ([cost-controls.md](cost-controls.md)).

Default pending an owner answer: **only Chief spawns boxes.** A box cannot spawn child boxes, matching the existing rule that sub-agents cannot run `agent_run` (`NEVER_GRANTED` in `src/plugins.ts`).

## What exists today and why it is not enough

The coding module ([coding.md](coding.md)) already contains a box system: the `SandboxProvider` seam (`src/coding/provider.ts`), HMAC attempt tokens, leases, deadlines, heartbeats, cleanup states, reconciliation of uncertain creates, the host model proxy with its sealed journal, and in-box process lockdown. It cannot be reused, for these reasons:

- **One build per attempt.** Every resume, feedback round and rebase waits for a fresh CodeBuild build to be provisioned and its image to be pulled. Boxes also re-clone and re-install for every task (see [Warm reuse and trust reset](#warm-reuse-and-trust-reset)); what warm reuse saves is boot time, the image pull and, later, verified package downloads.
- **Communication is one-way.** The worker pulls `assignment` and pushes heartbeat, progress, checkpoint and finish. The host can only refuse a call, abort a model call or `StopBuild`. Steering means a new revision and a new attempt.
- **Workflow and lifecycle are tangled.**
  - `coding_jobs` mixes box columns with workflow columns.
  - The global `coding_one_active_worker` index also counts host-side `publishing`.
  - `tick()` interleaves reconciliation with requirements approval, publication and merge automation.
  - Approval policy runs inside worker authentication, token issue and heartbeats.
  - `save` and `finish` hard-code npm checks.
  - `coding_events` is at once the outbox, the session store, the approval log and the automation state.
  - Workers strict-parse the whole `codingSettings` blob, so a schema change needs a new image.
- **CodeBuild is batch-shaped.** A build cannot stop with its disk kept, so a warm workspace cannot outlive a build.
  - Our own configuration adds limits on top: one concurrent build (`ConcurrentBuildLimit: 1` in `deploy/coding/codebuild.json`) and no privileged mode (enforced by `validate()`), so there is no Docker.
  - Memory was tight on the `general1` container sizes: `spawn ENOMEM` on medium, and a cgroup limit on large. The fix was partitioning test processes on an unchanged medium box, not a larger one ([journal 83](journey/83-pi-context-verification.md)).
  - A 45-minute lifetime clamp was observed on 10 October ([journal 80](journey/80-codebuild-timeout-mismatch.md)). After AWS Support replied, a 13 October probe was admitted at 125 minutes; this proves admission only, not a long run ([journal 83](journey/83-pi-context-verification.md)).
  - The attempt token travels as a plaintext build environment variable.

## Model

```
Chief (always on)
 ├─ light sub-agents (in process)                 agent_run, unchanged
 └─ box controller (host)                          new: src/boxes/
       ├─ provider: EC2 | CodeBuild               launch / find / describe / stop / start / terminate / sweep
       ├─ reconciler                               lifecycle truth, TTLs, orphan sweep, verified termination
       ├─ channel API  /boxes/:id/*                bootstrap, long-poll messages, events, heartbeat, artifacts
       └─ profiles: coding (first), analysis, crawl
                 │  host hooks: authorise task, validate checkpoint/result, publish
Box (EC2 instance; CodeBuild build as fallback)
 ├─ box agent (host systemd service, root, read-only install)   connects out, runs tasks, enforces TTL, reports
 └─ task container (fresh per task, UID 1000, locked down)      e.g. Pi coding runtime; repository code runs here
```

- **Box:** one compute lifetime, bound to exactly **one job, owner and repository**. Boxes are never reused across jobs. On EC2 a box can survive stop and start cycles with its disk intact.
- **Profile:** the image, runtime, instance size, egress policy, TTLs, concurrency and host hooks for one kind of work.
- **Task:** one delegated unit of work inside a box. A coding round is a task: planning, implementation, a feedback round or a rebase.
- **Box agent:** a small supervisor installed outside Docker, in root-owned read-only locations, from a pinned and checksum-verified artifact. It holds the box credential, long-polls the host, creates and destroys task containers, enforces the hard lifetime and streams events.
- **Task container:** a fresh container per task from the digest-pinned worker image. It runs as UID 1000 with:
  - `no-new-privileges`, all capabilities dropped and the default seccomp profile;
  - a read-only root filesystem;
  - no Docker socket, on a bridge network.

  The existing in-runtime lockdown (`setpriv`, `PR_SET_DUMPABLE=0`, subreaper, stripped environment) still applies inside it. No host user is in the `docker` group.

- **CodeBuild fallback.** CodeBuild cannot run Docker under our unprivileged configuration. A CodeBuild box therefore runs the box agent and one task as processes in the build container, as today, with **one task per box and a warm TTL of 0**, so it never holds the single build slot while idle.

## Lifecycle

```
requested → launching → booting → ready ⇄ busy
                                    │ idle 15 min (warm TTL)
                                    ▼
                         stopping → stopped ──(new task, within retention)──► starting → booting → ready
                                    │ retention expires / job ends / hard max
                                    ▼
                               terminating → terminated (verified)
any state → lost (no provider identity or heartbeat) → reconciler terminates or holds for an operator
```

- **Warm idle TTL:** 15 minutes running with no task, then stop (EC2). CodeBuild boxes terminate at once because they cannot stop.
- **Stopped retention:** proposed 24 hours, after which the box is terminated. Owner merge cards can wait longer than that; a later round then starts a fresh box from the job's checkpoint, exactly as today.
- **Hard maximum lifetime:** two limits, both kept on the host:
  - cumulative running time across stop and start cycles (about 24 hours);
  - an absolute wall-clock cap from launch (proposed 7 days).

  The box agent receives the remaining running time with each `hello` and shuts the OS down at zero. EC2's `InstanceInitiatedShutdownBehavior=terminate` turns that shutdown into termination. The reconciler terminates from outside as well.

- **Starting a stopped box can fail**, for example with insufficient capacity, since a stopped instance is pinned to its Availability Zone. The round then falls back to a fresh box from the job's checkpoint.
- **Host restarts are not box losses.** Polling doubles as the heartbeat, so every box goes quiet while Chief deploys. After the host starts, the reconciler allows a grace period before it treats a silent box as lost.
- **Task active window:** unchanged. Each coding round has its own active window (currently 40 minutes for Pi), with shared model-call and tool totals ([coding-automation.md](coding-automation.md)).
- **Terminal receipts are verified.** A provider's accepted lifetime is read back from the provider, not assumed from the request, and termination is confirmed by `describe`. This is the lesson of the 45-minute clamp.
- **Never retry an unknown launch.** Each launch carries an idempotent client token derived from the box ID, and the box row and token are written **before** the provider call:
  - EC2 uses the `RunInstances` `ClientToken`;
  - CodeBuild uses `idempotencyToken`, which is only honoured for 5 minutes, so "never retry" is the real guarantee.

  An uncertain launch is reconciled by the box-ID tag or the token.

- **The sweep is scoped.** Tags carry both the box ID and a deployment tag (`chief:env`). A sweep only touches its own environment's resources, and treats rows in `requested` or `launching` as owners of matching instances.
- **One stuck box never blocks the system.** Concurrency is limited per profile and provider; the single global `coding_one_active_worker` index is replaced. A box whose identity cannot be resolved is held for an operator without blocking others, and the owner is told.
- **Host-side side effects stay serialised where they need to be.** The old global index also serialised publication and merge automation. Coding keeps that guarantee with a **per-repository publication lock** on the host, so two coding boxes can run while PR writes, rebases and Merge cards for one repository still happen one at a time.

## Channel (two-way, box dials out)

All traffic goes over the existing HTTPS origin through Caddy. Boxes never accept inbound connections. Long-polling is used rather than WebSockets because it works through the current proxy, survives restarts on both sides, and behaves the same on every provider.

| Route                         | Direction | Purpose                                                                                                                                                                                                   |
| ----------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /boxes/:id/hello`       | box→host  | Exchange the one-time bootstrap secret (plus EC2 identity proof), or the stored session credential after a restart, for a session credential. Returns protocol version, box epoch and remaining lifetime. |
| `GET /boxes/:id/next?after=N` | host→box  | Long-poll (up to 25 s) for ordered messages: `task.assign`, `task.message` (steering, answers, follow-ups), `task.cancel`, `box.inspect`, `box.stop`. Doubles as heartbeat.                               |
| `POST /boxes/:id/events`      | box→host  | Ordered, idempotent event batches: task progress, tool calls, questions, artifacts, task results and box state.                                                                                           |
| `POST /boxes/:id/artifacts`   | box→host  | Bounded uploads of typed results (patch, files, report, dataset) stored owner-scoped on the host.                                                                                                         |
| Task-scoped routes            | box→host  | The existing model proxy and session store, authorised by a **per-task** token the box agent passes to the task runtime only.                                                                             |

- **Ordering and delivery.**
  - Messages carry a sequence number per box and are acknowledged by the next poll's `after`. Delivery is at least once.
  - The box agent persists its cursor and handles messages idempotently by message and task ID. A re-delivered `task.assign` never starts a second task.
  - Events carry a sequence number per box epoch and are deduplicated by the host.
  - A lost response never duplicates an effect.
- **Inspection.** `box.inspect` asks the box agent for:
  - the current task step and recent tool calls;
  - a bounded listing or read of workspace files;
  - resource use.

  The agent reads files as the task user, or with `O_NOFOLLOW` and `RESOLVE_BENEATH`, so workspace symlinks cannot expose root-only files. This replaces any need for SSH or SSM access, which would require AWS credentials inside the box.

- **Steering is not scope.** The box agent forwards `task.message` into the runtime through the reply side of `coding_runtime_pi/src/rpc.ts`.
  - **Messages carry answers and clarifications only.** A change of scope creates a new revision with a fresh owner approval, exactly as today.
  - **Approval stays host-only.** The runtime's in-box `approve` RPC is never reachable from the channel; approval is bound to revision and artifact hash.
  - **Steering is an owner-attributed host action.** Each `task.message` is bound by the host to the originating owner input ID, the same binding `conversation_read(inputId)` uses today, and the host refuses one without it. Chief relays an owner's message; it cannot steer a box on its own initiative, because box output is untrusted and must not be able to talk Chief into redirecting the box.

## Credentials and authority

These invariants carry over unchanged from [coding.md](coding.md), [coding-subagent.md](coding-subagent.md) and [AGENTS.md](../AGENTS.md):

- **No production secrets in a box, ever.** That covers Telegram, the database, Google, IBKR, provider keys, the publisher App and AWS credentials. EC2 boxes have **no instance profile**.
- **Model calls go through the host proxy**, which keeps the provider key, price routing, call journal and uncertain-call rules on the host.
- **Approvals stay bound to the exact task, scope and artifact.** A box cannot approve its own work, merge, deploy, send messages or write to Chief's memory.
- **Box content is untrusted data** when it comes back to Chief: reports, crawled pages, files and model output.
- **Scoped capabilities.** A capability such as the agent GitHub token from stage 1 is short-lived, scoped per task, issued only to an authorised running task and revoked when that task ends or the box closes.
- **Authorisation is checked per call.** Moving coding policy into profile hooks does not mean checking it once. Every task-scoped call re-checks on the host the task's state, deadline and approved revision: model proxy, session store, `github-token`, `checkpoint` and `finish`. This is what `authenticate` and `githubToken` in `src/coding/controller.ts` do today.

### Bootstrap (replaces the plaintext attempt token)

Today the attempt token is a plaintext CodeBuild environment variable. It is valid only while its attempt is active and before its deadline. Any principal with `codebuild:BatchGetBuilds` on the project can read it. Our policy grants that only to the controller, whose host already holds the token-derivation key, and administrators have it implicitly, so the practical exposure is low. The box protocol still removes it.

1. **Launch.** The host generates a random 256-bit **bootstrap secret**, stores only its hash, and passes the box ID and secret to the provider:
   - EC2: in user data. Anyone with `ec2:DescribeInstanceAttribute` can read user data, including read-only administrators, which is acceptable only because the secret is single-use.
   - CodeBuild: in the environment.
2. **First `hello`.** The box agent fetches user data from IMDS on every boot (cloud-init runs user-data scripts only once) and calls `hello`.
   - On EC2 it also presents the AWS-signed **instance identity document**. The host verifies the signature against the region certificate, and checks the instance ID and account against its record. A check of `pendingTime` against the latest start is added only once phase 3 has verified that `pendingTime` changes on every start.
   - The document is static and carries no nonce, so it binds the box to the instance; it does not prove freshness.
3. **Exchange.** The host consumes the secret atomically and returns a session credential bound to the box and epoch. The agent stores it in a root-only file on the encrypted disk.
4. **Restarts and warm starts.** After an agent restart, reboot or warm start, the agent calls `hello` with its stored session credential. The host rotates it to a new epoch. User data is never modified, so the controller needs no `ModifyInstanceAttribute` permission.
5. **Replay.** An agent never presents a bootstrap secret twice. An agent that has lost its session credential reports itself lost, if it can, and shuts the box down; the host replaces the box. Any second use of a consumed bootstrap secret therefore means **compromise**: the host stops the box's tasks, revokes its capabilities, terminates it and tells the owner.

The bootstrap secret is useless seconds after boot, and its theft is detected rather than silent.

### Inside the box (EC2)

- **Box agent.** A host systemd service outside Docker, running as root from root-owned read-only paths. It reaches IMDS with IMDSv2.
- **Tasks.** Each task runs in a fresh container on a bridge network, as described under [Model](#model).
  - IMDSv2 is required with hop limit 1, so bridged containers cannot obtain an IMDS token.
  - The Docker `DOCKER-USER` chain also drops traffic to `169.254.169.254` and `fd00:ec2::254`. The IPv6 IMDS endpoint and instance-metadata tags stay disabled.
  - With no instance profile, IMDS has no credentials. These controls protect user data and the identity document as defence in depth.
- **Repository code only ever runs inside a task container.**
- **Disk.** The workspace disk is encrypted and deleted when the instance terminates.

### Warm reuse and trust reset

Reuse saves boot time and the image pull. It never lets one task's state influence the next. Before every task the box agent:

1. destroys the previous task container and asserts that no task processes remain;
2. creates a fresh container, task home and caches;
3. gives the task a **fresh workspace**:
   - a fresh clone from GitHub, with the job's checkpoint files applied;
   - git run with no local hooks, filters, `core.fsmonitor` or other repository configuration from earlier tasks.

   The worktree of a previous task is never trusted.

4. installs dependencies with `npm ci` into the fresh container. An optional package cache is populated only by the agent, verified by lockfile integrity hashes and mounted read-only (a later optimisation, measured before adoption).

**Proposed default: a box is reused only within the rounds that follow implementation approval** (implementation, feedback repairs and rebases of the same job). The read-only planning box is not reused for implementation. The remaining risk is that a kernel or container escape in one round persists into later rounds of the same job. Today every attempt starts on a fresh machine.

### Delegation is a write

Starting a box creates infrastructure and spends money. `agent_run` is classed as a read operation today (`src/execution.ts`). The boxed placement must be journaled as a write behind the uncertain-write guard, and be idempotent by `requestKey`, like `coding_start`.

## EC2 provider

- **Network.** A dedicated VPC, or the default VPC, with a public subnet and public IPs, so no NAT gateway charges. One security group per profile with **no inbound rules**. Egress for coding and analysis is 443 and 80. Crawl also gets 443 and 80; a domain allowlist would need an egress proxy and is deferred. Security groups cannot filter by domain, and CodeBuild's egress is equally open today.
- **Launch template per profile:**
  - the image: Amazon Linux 2023 resolved through the public SSM parameter at first, a baked AMI only if first boot proves too slow;
  - instance type;
  - no instance profile;
  - IMDSv2 required with hop limit 1;
  - encrypted gp3 root with delete-on-termination;
  - `InstanceInitiatedShutdownBehavior=terminate`;
  - tag specifications.
- **Bootstrap script.** First boot installs Docker and the box agent (pinned and checksum-verified), then pulls the digest-pinned worker image from public GHCR. Warm starts reuse all three. Stopped boxes resume with whatever packages they had, so patching happens through retention limits and, later, a baked AMI.
- **Controller IAM.** A launch-template condition alone does not stop a caller from overriding the template's parameters in `RunInstances`, so each resource type is constrained separately:

  | Resource or action                                                  | Allowed only when                                                                                                                                                                                                                                                                                                                                    |
  | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `RunInstances` on `instance`                                        | `ec2:LaunchTemplate` is a box template; `ec2:InstanceType` is in the profile list; `ec2:MetadataHttpTokens=required`; `ec2:MetadataHttpPutResponseHopLimit` ≤ 1; `ec2:InstanceMetadataTags=disabled`; `ec2:Tenancy=default`; `ec2:InstanceMarketType=on-demand`; request tags include `chief:box` and `chief:env`, and no other tag keys are allowed |
  | `RunInstances` on `volume`                                          | `ec2:Encrypted=true`; `ec2:VolumeType=gp3`; `ec2:VolumeSize` ≤ the profile maximum                                                                                                                                                                                                                                                                   |
  | `RunInstances` on `image`                                           | the image is the profile's AMI, or is owned by Amazon (`ec2:Owner`) while the stock image is used                                                                                                                                                                                                                                                    |
  | `RunInstances` on `subnet`, `security-group`, `network-interface`   | `ec2:IsLaunchTemplateResource=true`                                                                                                                                                                                                                                                                                                                  |
  | `RunInstances` on `launch-template`                                 | the exact box template ARNs                                                                                                                                                                                                                                                                                                                          |
  | `key-pair`                                                          | never granted, so no key pair can be attached                                                                                                                                                                                                                                                                                                        |
  | `CreateTags`                                                        | only with `ec2:CreateAction=RunInstances`                                                                                                                                                                                                                                                                                                            |
  | `StartInstances`, `StopInstances`, `TerminateInstances`             | resource tagged `chief:box` and `chief:env` for this environment                                                                                                                                                                                                                                                                                     |
  | `DescribeInstances`, `DescribeVolumes`, `DescribeInstanceAttribute` | not resource-scoped by AWS                                                                                                                                                                                                                                                                                                                           |
  | `DeleteVolume`                                                      | resource tagged `chief:box` and `chief:env` (sweep of leftover volumes)                                                                                                                                                                                                                                                                              |
  | `ssm:GetParameters`                                                 | only the public Amazon Linux 2023 parameter, while the template resolves the image through SSM                                                                                                                                                                                                                                                       |
  - No `iam:PassRole` is granted for EC2: the existing grant is conditioned to `codebuild.amazonaws.com`. The controller therefore cannot attach an instance profile.
  - There is no `ModifyInstanceAttribute`, so it cannot change the instance type, security groups, shutdown behaviour or volume deletion.
  - Phase 3 includes negative tests: every override must fail with `UnauthorizedOperation`, including instance type, image, IMDS options, key pair, security group, subnet, unencrypted or oversized volume, and extra tags.

  - **Residual risk.** No condition key is known for `DisableApiTermination`, `DisableApiStop` or `InstanceInitiatedShutdownBehavior`; phase 3 checks this. If none exists, a compromised controller could launch a box that the sweep cannot terminate, or that only stops at its hard maximum. The reconciler therefore reads these attributes with `DescribeInstanceAttribute` (read-only) right after launch, and holds and alerts on any mismatch.

- **Sweep.** Each reconciler pass lists the instances and volumes tagged for this environment. It terminates instances, and deletes leftover volumes, that no live box row owns or that are past their limits.
- **Quotas.** Check the account's on-demand vCPU quota for standard instances in `ap-southeast-1` before enabling concurrency above 1.
- **Cost (approximate, to verify).** A 4 vCPU / 16 GB general-purpose instance lists at roughly $0.20–0.25 per hour, billed per second. CodeBuild's published rate for `general1.medium` (4 vCPU, about 7 GB) is $0.01 per minute, billed per whole minute, which is about $0.60 per hour ([journal 70](journey/70-coding-allocations.md)). A stopped box costs only its disk.

## Coding on boxes

- **The workflow stays host policy.** Requirements approval, review proof, publication from approved files, Devin feedback, rebases and the Merge card all stay on the host. They run as **coding profile hooks**:
  - `authoriseTask`: requirements are approved for this scope;
  - `validateCheckpoint`;
  - `validateResult`: checks, review and artifact hash;
  - `afterResult`: publication and automation, under the per-repository publication lock.

  The hooks replace the policy embedded in worker authentication and heartbeat, but per-call checks remain (see [Credentials and authority](#credentials-and-authority)). The uncertain model-call rules and per-job settings snapshots are unchanged.

- **Job to box.** `coding_jobs` gains a nullable `box_id`. An attempt becomes a box task.
- **Warm reuse after implementation approval:**
  - implementation → publication;
  - Devin feedback → repair;
  - main moved → rebase.

  Each round runs in the same box if it is running, starts it if it is stopped, and falls back to a fresh box if neither works. Every round begins with the trust reset above.

- **Concurrency.** Coding defaults to 2 running EC2 boxes; stopped boxes count against a separate retention cap. Through the CodeBuild fallback, coding stays at 1, with no warm TTL.
- **Owner view and steering.** `coding_status` gains:
  - box state: running, idle or stopped;
  - the current step;
  - recent activity from the channel.

  Chief relays an owner's answers and clarifications into a running task. A scope change still goes through a new revision and approval.

## Data model (new tables, independent of `coding_*`)

- `boxes`: owner, job, repository, profile, provider, provider ID, client token, environment tag, image digest, size, state, epoch, bootstrap hash, session credential hash, last seen, idle since, cumulative running time, retention deadline, absolute deadline, cleanup state, lease.
- `box_tasks`: box, kind, request key, state, active deadline, per-task token, result reference.
- `box_messages`: host to box, ordered, acknowledged.
- `box_events`: box to host, ordered per epoch, deduplicated; feeds Telegram delivery through the existing outbox routing.
- `box_artifacts`: typed, owner-scoped, bounded.

Pi sessions and model-call journals keep their storage, keyed by task.

## Phases

Each phase is a separate PR with exact-head independent review, CI, a release record and a journal entry.

1. **Design record.** This document and journal 90.
2. **Box layer with a CodeBuild provider; no new infrastructure.**
   - The tables, the reconciler (TTLs, sweep, verified termination, per-profile concurrency), the channel with bootstrap, and the box agent.
   - An `echo` profile proves spawn, steering, inspection, idle close and verified termination end to end, one task per box.
   - CodeBuild cannot run the per-task container reset, so the two-tasks-in-one-box proof moves to phase 3, on EC2.
3. **EC2 provider.**
   - Provider code plus `deploy/boxes/` CloudFormation and IAM for the owner to review and apply.
   - IAM negative tests.
   - Measure boot to `hello`, warm start to `hello`, the stop/start cycle, the orphan sweep and the trust reset with the `echo` profile.
4. **Coding on boxes.**
   - Hooks extracted, warm reuse, `coding_status` box view, steering.
   - Canary jobs on EC2; switch the coding default by configuration; keep CodeBuild as fallback.
   - In-flight jobs keep their snapshotted path.
5. **Generic boxed agent.** `agent_run` with `placement: box` and `requestKey`, plus `agent_send`, `agent_status` and `agent_close`; first non-coding profile (analysis or crawl).
6. **Retire the coding-specific sandbox path** once no snapshotted job uses it.

## Acceptance

- Chief can spawn a box, run two tasks in it one after the other, send a message to the running task, inspect its workspace, get typed artifacts back, and see it stop when idle and terminate at retention. Termination is verified.
- Restarting Chief mid-task neither leaks a box nor duplicates a task. Orphans are found and terminated, and their capabilities revoked.
- No production credential exists in any box. A replayed bootstrap secret terminates the box; an agent restart does not.
- A task cannot leave anything behind for the next task in the same box: no processes, git configuration, hooks, dependencies, home-directory files or caches survive. This is tested with a deliberately hostile `echo` task.
- Every IAM override attempt fails.
- A coding job runs end to end on EC2 with the current approval, review and merge guarantees, and its feedback and rebase rounds reuse the box (measured provisions per job against today's).
- Measured and recorded: boot to `hello`, warm start to `hello`, active time and cost per job.

## Rollback

- **Routing.** Provider and profile selection are configuration, snapshotted per job. Rolling back routes new jobs to CodeBuild.
- **Jobs already on EC2.** Jobs snapshotted onto EC2 keep it. If EC2 itself is the reason for the rollback, the owner cancels them, or resumes them from their checkpoint as fresh CodeBuild attempts through an explicit move action.
- **Stopped boxes** are swept by retention.
- **Infrastructure.** The CloudFormation stack is deleted only after the sweep shows every box terminated and every box volume gone.
- **Data.** Box tables are additive; coding tables only gain a nullable column.

## Open questions for the owner

- **Is the warm TTL still worth it?** With the trust reset, a warm box saves boot time and the image pull, plus verified package downloads once the cache exists. It no longer saves the workspace. Phase 3 measures this before coding relies on it.
- **Warm reuse across approval.** May a box be reused across the planning-to-implementation approval? The proposed default is no; reuse only after implementation approval.
- **Stopped retention.** Is 24 hours right?
- **Absolute cap.** Is 7 days right?
- **Sizes and placement.** Instance type and disk size per profile, and which subnets and Availability Zones.
- **Image patching.** When should we adopt a baked, regularly rebuilt AMI?
- **User data visibility.** Is it acceptable that read-only AWS administrators can read single-use bootstrap secrets in user data?
- **Alerts.** Who is told when a box is held for an operator or marked compromised? Proposed: the owner, in the Coding topic.
- **Concurrency.** Per profile beyond coding's 2.
- **Child boxes.** Should boxes ever spawn child boxes? Default no.
- **Owner view.** How much of the live box view should the owner see in Telegram or the Mini App, as opposed to only Chief?
- **Egress.** When do we want a domain-allowlisting egress proxy?
