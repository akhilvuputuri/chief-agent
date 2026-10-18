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

The plan is now: build the box layer with a fake provider for tests and a local Docker provider for development, then the EC2 provider and its CloudFormation, which the owner applies. Coding moves onto EC2 boxes after that, and its current CodeBuild path stays untouched until then.

### Phase 2a: foundation (dormant)

Added:

- `db/032_boxes.sql`;
- `src/boxes/` (provider interface and fake provider, credentials, `BoxController`, `/boxes/*` routes);
- `tests/boxes.test.ts`.

Nothing is wired into the gateway yet.

Implemented as designed:

- The bootstrap secret is the epoch-0 credential, so the bootstrap exchange and later restarts share one rotation path, which is idempotent until first use.
- Credentials are derived (HMAC of host key, box, predecessor hash and epoch), so only hashes are stored.
- A retired credential sent to `hello` is refused and alerted; one used on the channel is compromise.
- A box cannot complete `hello` before its provider resource is recorded.
- Restarts of stopped boxes count against concurrency.

Long-polls last 8 s, below the server's 15 s request timeout.
