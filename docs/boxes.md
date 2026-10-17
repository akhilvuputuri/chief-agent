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

- **One build per attempt.** Every resume, feedback round and rebase provisions a fresh CodeBuild build, then clones and installs again.
- **Communication is one-way.** The worker pulls `assignment` and pushes heartbeat, progress, checkpoint and finish. The host can only refuse a call, abort a model call or `StopBuild`. Steering means a new revision and a new attempt.
- **Workflow and lifecycle are tangled.**
  - `coding_jobs` mixes box columns with workflow columns.
  - The global `coding_one_active_worker` index also counts host-side `publishing`.
  - `tick()` interleaves reconciliation with requirements approval, publication and merge automation.
  - Approval policy runs inside worker authentication, token issue and heartbeats.
  - `save` and `finish` hard-code npm checks.
  - `coding_events` is at once the outbox, the session store, the approval log and the automation state.
  - Workers strict-parse the whole `codingSettings` blob, so a schema change needs a new image.
- **CodeBuild is batch-shaped.**
  - It allows one concurrent build (`ConcurrentBuildLimit: 1`).
  - Privileged mode is not allowed, so there is no Docker.
  - Containers are memory-capped: `spawn ENOMEM` hit both the medium and large sizes ([journal 83](journey/83-pi-context-verification.md)).
  - A 45-minute lifetime clamp was observed on 10 October and cleared by AWS Support on 13 October, for admission only ([journal 80](journey/80-codebuild-timeout-mismatch.md)).
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
Box (EC2 instance or CodeBuild build)
 ├─ box agent (trusted supervisor, root)           connects out, runs tasks, enforces TTL, reports
 └─ task runtime (UID 1000, locked down)           e.g. Pi coding runtime; repository code runs here
```

- **Box:** one compute lifetime. On EC2 a box can survive stop and start cycles with its disk intact.
- **Profile:** the image, runtime, instance size, egress policy, TTLs, concurrency and host hooks for one kind of work.
- **Task:** one delegated unit of work inside a box. A coding round is a task: planning, implementation, a feedback round or a rebase.
- **Box agent:** a small supervisor baked into the image. It holds the box credential, long-polls the host, starts and stops task runtimes, enforces the hard lifetime and streams events.

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

- **Warm idle TTL:** 15 minutes running with no task, then stop (EC2) or terminate (CodeBuild, which cannot stop).
- **Stopped retention:** proposed 24 hours, after which the box is terminated. Owner merge cards can wait longer than that; a later round then starts a fresh box from the job's checkpoint, exactly as today.
- **Hard maximum lifetime:** about 24 hours of running time. The box agent enforces it from inside by shutting down the OS (with EC2's `InstanceInitiatedShutdownBehavior=terminate`, an OS shutdown terminates the instance); the reconciler enforces it from outside.
- **Task active window:** unchanged. Each coding round has its own active window (currently 40 minutes for Pi), with shared model-call and tool totals ([coding-automation.md](coding-automation.md)).
- **Terminal receipts are verified.** A provider's accepted lifetime is read back from the provider, not assumed from the request, and termination is confirmed by `describe`. This is the lesson of the 45-minute clamp.
- **Never retry an unknown launch.** Each launch carries an idempotent client token derived from the box ID (EC2 `RunInstances` `ClientToken`; CodeBuild `idempotencyToken`). An uncertain launch is reconciled by tag or token.
- **One stuck box never blocks the system.** Concurrency is limited per profile; the single global `coding_one_active_worker` index is replaced. A box whose identity cannot be resolved is held for an operator without blocking others.

## Channel (two-way, box dials out)

All traffic goes over the existing HTTPS origin through Caddy. Boxes never accept inbound connections. Long-polling is used rather than WebSockets because it works through the current proxy, survives restarts on both sides, and behaves the same on every provider.

| Route                         | Direction | Purpose                                                                                                                                                                     |
| ----------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /boxes/:id/hello`       | box→host  | Exchange the one-time bootstrap secret, plus EC2 identity proof, for a session credential. Returns protocol version and box epoch.                                          |
| `GET /boxes/:id/next?after=N` | host→box  | Long-poll (up to 25 s) for ordered messages: `task.assign`, `task.message` (steering, answers, follow-ups), `task.cancel`, `box.inspect`, `box.stop`. Doubles as heartbeat. |
| `POST /boxes/:id/events`      | box→host  | Ordered, idempotent event batches: task progress, tool calls, questions, artifacts, task results and box state.                                                             |
| `POST /boxes/:id/artifacts`   | box→host  | Bounded uploads of typed results (patch, files, report, dataset) stored owner-scoped on the host.                                                                           |
| Task-scoped routes            | box→host  | The existing model proxy and session store, authorised by a **per-task** token the box agent passes to the task runtime only.                                               |

- **Ordering and delivery.** Messages carry a sequence number per box and are acknowledged by the next poll's `after`. Events carry a sequence number per box epoch and are deduplicated by the host. A lost response never duplicates an effect.
- **Inspection.** `box.inspect` asks the box agent for current task step, recent tool calls, a bounded listing or read of workspace files, and resource use. This replaces any need for SSH or SSM access, which would require AWS credentials inside the box.
- **Steering.** The box agent forwards `task.message` into the runtime. `coding_runtime_pi/src/rpc.ts` already has a reply, approve, cancel and events RPC that the CLI uses, and it is the natural in-box interface.

## Credentials and authority

These invariants carry over unchanged from [coding.md](coding.md), [coding-subagent.md](coding-subagent.md) and [AGENTS.md](../AGENTS.md):

- **No production secrets in a box, ever.** That covers Telegram, the database, Google, IBKR, provider keys, the publisher App and AWS credentials. EC2 boxes have **no instance profile**.
- **Model calls go through the host proxy**, which keeps the provider key, price routing, call journal and uncertain-call rules on the host.
- **Approvals stay bound to the exact task, scope and artifact.** A box cannot approve its own work, merge, deploy, send messages or write to Chief's memory.
- **Box content is untrusted data** when it comes back to Chief: reports, crawled pages, files and model output.
- **Scoped capabilities.** A capability such as the agent GitHub token from stage 1 is short-lived, scoped per task, issued only to an authorised running task and revoked when that task ends or the box closes.

### Bootstrap (replaces the plaintext attempt token)

Today the long-lived attempt token is a plaintext CodeBuild environment variable. Only the controller principal, whose host already holds the token-derivation key, and account administrators can read it, so the practical exposure is low. The box protocol still removes it:

1. At launch the host generates a random 256-bit **bootstrap secret**, stores only its hash, and passes the box ID and secret to the provider:
   - EC2: in user data, which can only be changed while the instance is stopped;
   - CodeBuild: in the environment.
2. The box agent calls `hello` once. On EC2 it also presents the AWS-signed **instance identity document**, which the host verifies against the region certificate and the recorded instance ID and account. IMDS is available without credentials because there is no instance profile.
3. The host consumes the secret atomically and returns a session credential bound to the box epoch. A second use of the same secret marks the box **compromised**: the host stops all its tasks, revokes its capabilities and terminates it.
4. Every warm start issues a new secret and epoch, written to user data before `StartInstances`.

The secret is therefore useless seconds after boot, and theft is detected rather than silent.

### Inside the box

- The box agent runs as root from the image.
- Task runtimes run as UID 1000 with the existing lockdown: `setpriv` with no new privileges and no capabilities, `PR_SET_DUMPABLE=0`, a subreaper, a stripped environment, and the runtime outside the checkout.
- Repository code only ever runs as the task user.
- The task user is blocked from the instance metadata address by an owner-matched firewall rule, and IMDSv2 is required with hop limit 1. With no instance profile this protects only user data and the identity document, and it is kept as defence in depth.
- The workspace disk is encrypted and deleted when the instance terminates.

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
- **Bootstrap script.** First boot installs Docker and pulls the digest-pinned worker image from public GHCR. Warm starts reuse both. The box agent then starts and calls `hello`.
- **Controller IAM** (no `iam:PassRole` needed):
  - `ec2:RunInstances`, only with the box launch templates and only with the required `chief:box` request tags;
  - `ec2:CreateTags`, only as part of `RunInstances`;
  - `ec2:StartInstances`, `StopInstances`, `TerminateInstances` and `ModifyInstanceAttribute` (user data), only on resources tagged `chief:box`;
  - `ec2:DescribeInstances`, which AWS does not scope by resource.
- **Sweep.** Each reconciler pass lists `chief:box`-tagged instances and volumes and terminates anything not owned by a live box row or past its limits.
- **Quotas.** Check the account's on-demand vCPU quota for standard instances in `ap-southeast-1` before enabling concurrency above 1.
- **Cost (approximate, to verify).** A 4 vCPU / 16 GB general-purpose instance is roughly $0.20–0.25 per hour, billed per second, against about $0.60 per hour measured for CodeBuild medium ([journal 70](journey/70-coding-allocations.md): $0.01/min, whole minutes). A stopped box costs only its disk.

## Coding on boxes

- **The workflow stays host policy.** Requirements approval, review proof, publication, Devin feedback, rebases and the Merge card all stay on the host. They run as **coding profile hooks**: `authoriseTask` (requirements approved for this scope), `validateCheckpoint`, `validateResult` (checks, review and artifact hash) and `afterResult` (publication and automation). They move out of worker authentication and heartbeat.
- **Job to box.** `coding_jobs` gains a nullable `box_id`. An attempt becomes a box task, and settings are still snapshotted per job.
- **Warm reuse:**
  - planning → approval → implementation;
  - publication → Devin feedback → repair;
  - main moved → rebase.

  Each step can run in the same box if it is still running, or start it again if it is stopped. Before a reused workspace is trusted, the runtime verifies it: the pinned base or last published head must exist with the expected tree, otherwise it starts with a fresh clone.

- **Concurrency.** Coding defaults to 2 running boxes; stopped boxes count against a separate retention cap.
- **Owner view.** `coding_status` gains box state (running, idle, stopped), current step and recent activity from the channel. Chief can relay owner messages into a running coding task.

## Data model (new tables, independent of `coding_*`)

- `boxes`: owner, profile, provider, provider ID, client token, image digest, size, state, epoch, bootstrap hash, last seen, idle since, retention deadline, hard deadline, cleanup state, lease.
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
   - An `echo` profile proves spawn, two tasks in one box, steering, inspection and close end to end.
3. **EC2 provider.**
   - Provider code plus `deploy/boxes/` CloudFormation and IAM for the owner to review and apply.
   - Measure boot to `hello`, warm start to `hello`, the stop/start cycle and the orphan sweep with the `echo` profile.
4. **Coding on boxes.**
   - Hooks extracted, warm reuse, `coding_status` box view, steering.
   - Canary jobs on EC2; switch the coding default by configuration; keep CodeBuild as fallback.
   - In-flight jobs keep their snapshotted path.
5. **Generic boxed agent.** `agent_run` with `placement: box` and `requestKey`, plus `agent_send`, `agent_status` and `agent_close`; first non-coding profile (analysis or crawl).
6. **Retire the coding-specific sandbox path** once no snapshotted job uses it.

## Acceptance

- Chief can spawn a box, run two tasks in it one after the other, send a message to the running task, inspect its workspace, get typed artifacts back, and see it stop when idle and terminate at retention. Termination is verified.
- Restarting Chief mid-task neither leaks a box nor duplicates a task. Orphans are found and terminated, and their capabilities revoked.
- No production credential exists in any box. A replayed bootstrap secret terminates the box.
- A coding job runs end to end on EC2 with the current approval, review and merge guarantees, and its feedback and rebase rounds reuse the box (measured provisions per job against today's).
- Measured and recorded: boot to `hello`, warm start to `hello`, active time and cost per job.

## Rollback

Provider and profile selection are configuration, snapshotted per job. Rolling back means routing new jobs to CodeBuild. Stopped EC2 boxes are swept by retention. Box tables are additive; coding tables only gain a nullable column.

## Open questions

- Stopped retention: is 24 hours right?
- Concurrency per profile beyond coding's 2?
- Should boxes ever spawn child boxes? Default no.
- How much of the live box view should the owner see in Telegram or the Mini App, as opposed to only Chief?
- When do we want a domain-allowlisting egress proxy?
