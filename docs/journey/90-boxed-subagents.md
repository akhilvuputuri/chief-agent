# 90 — Can Chief delegate heavy work to sub-agents with their own boxes?

Work date(s): 2026-10-17. Written/revised: 2026-10-17.
Status: proposed. [Design](../boxes.md) recorded with owner decisions. No implementation yet, and no AWS resources created.

## User-visible problem and preceding iteration

The owner asked (reported) to rework delegation around sub-agents that get their own on-demand box, as opposed to today's light in-process sub-agents. Chief would spawn a box, delegate tasks to it, steer it, collect results and close it, or let a time-to-live close it. Coding would be one kind of task among several, with data analysis and web crawling to follow. The owner's view was that current coding jobs feel "less like a sub-agent and more like just throwing a runtime job, and there's not much access into it from chief." This builds on [journal 89](89-agentic-coding-subagent.md), where the coder gained commit authority, and on issue #219, the earlier exploration of an independent coding service and EC2.

## Evidence

Four parallel read-only explorations of main `9fae411` produced this evidence. Facts come from code, docs and cited sources; the ranking of options is judgment.

**Tested (read from code):**

- The worker channel is pull-only. Its routes are `assignment`, `heartbeat`, `progress`, `checkpoint`, `finish`, `model`, `logs`, `github-token`, `pi-session` and the Pi chat-completions proxy (`src/coding/api.ts`). The host can only refuse calls, abort model calls or stop the build. `coding_runtime_pi/src/rpc.ts` has a reply/approve/cancel/events RPC that only the CLI uses.
- Eleven places tangle the generic box lifecycle with coding workflow ([design](../boxes.md#what-exists-today-and-why-it-is-not-enough)). The worst:
  - the global `coding_one_active_worker` index also counts host-side `publishing`;
  - approval policy sits inside worker authentication and heartbeat;
  - `coding_events` is overloaded.
- `agent_run` is classed as a read operation (`src/execution.ts`). A placement that starts infrastructure would bypass the uncertain-write guard.
- The CodeBuild attempt token is passed as a `PLAINTEXT` environment variable (`src/coding/provider.ts`). Only the controller principal can read builds (`deploy/coding/controller-policy.json`), and its host already holds the token-derivation key, so the practical exposure is account administrators.

**Measured (earlier journals):**

- CodeBuild overhead is about 27–56 s per attempt. This is derived from the [journal 83](83-pi-context-verification.md) runs as total build seconds minus runtime seconds.
- CodeBuild medium costs $0.01 per minute, billed per whole minute ([journal 70](70-coding-allocations.md)).
- The 45-minute lifetime clamp was observed on 10 October; on 13 October a 125-minute timeout was admitted ([journal 80](80-codebuild-timeout-mismatch.md)).
- `spawn ENOMEM` occurred on both the medium and large compute sizes.

**Documented by vendors (web, dated 2024–October 2026):**

- EC2 lets an instance stop with its disk kept and start again later.
- Fargate does not cache images and does not allow privileged mode.
- Hosted sandboxes (E2B, Modal, Daytona, Vercel) start fastest, but send code and data to a third party, Singapore residency is unconfirmed, and published limits and prices conflict between sources.
- "Grok Bot" (xAI) and "Muse" (Meta), the likely meaning of the owner's "grokbot muse" reference, describe an always-on coordinator, compute per agent, and credentials held by a separate authority behind approvals.

## Diagnosis and alternatives

The two-way channel and multi-task boxes do not need new compute. A box agent that long-polls the host gets steering over the existing HTTPS origin on any provider. The provider decision matters for what happens between tasks:

- **CodeBuild and Fargate** can only end and restart, so every round clones and installs again.
- **EC2 can stop with its disk kept.** That makes the owner's "short warm TTL" nearly free, and lets feedback and rebase rounds resume an existing workspace. It also removes the CodeBuild memory caps and the one-build limit.

The cost of EC2 is operating the lifecycle ourselves: launch templates, tags, IAM conditions, IMDS lockdown, sweeps and image updates. Fargate is simpler to run but cannot keep a disk across stops. Hosted sandboxes were deferred for residency and vendor reasons.

## Owner decisions — 17 October 2026

- Coding moves onto boxes first.
- Short warm TTL: about 15 idle minutes, then stop.
- Move from CodeBuild to self-managed EC2. The owner asked for an evaluation first, then approved the plan; CodeBuild stays as fallback.
- Go ahead with the phased plan. The owner applies the AWS resources.

Default pending: only Chief spawns boxes.

## Implementation and review

Design only: [boxes.md](../boxes.md). Implementation follows the phases listed there, each with exact-head review.

## Verification and outcome

Nothing is implemented or measured yet. Still to measure: EC2 boot to `hello`, warm start to `hello`, provisions per coding job, and cost per job.

## Follow-up and next iteration

Phase 2 is the box layer with a CodeBuild provider and an `echo` profile, with no new infrastructure. Open questions are listed in the design.
