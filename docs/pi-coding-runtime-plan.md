# Independent Pi runtime implementation plan

Date: 9 October 2026. Status: standalone package, Chief bridge and verified image pin shipped as v0.3.60; real-model acceptance unmeasured; the owner explicitly authorizes a new-task default switch on 10 October before a paid trial, released as v0.3.61 with exact review/release and separate host health verified. See [release closure](journey/77-pi-runtime.md#verified-image-pin-release-closure--9-october-2026). Source baseline: freshly fetched Chief main `0547d4599ee6fd35666fabc9ebdf52b0fa04aec4`. See [exploration and SDK evidence](pi-coding-harness.md).

## Agreed boundary

Build a new independent TypeScript runtime around Pi. Leave the existing coding runtime untouched. Once the replacement is accepted, change Chief's connection for new coding tasks. Chief-side adapters and routing can change; the old Python implementation does not need refactoring, translation or deletion.

Preserve the existing runtime's code, immutable images, settings, checkpoints and stored jobs. Existing jobs retain their backend and remain inspectable/cancellable; cleanup and uncertain publication reconciliation must keep working. Do not resume paused jobs automatically or migrate their conversations. No old runtime code is copied into the new package merely for compatibility.

During development Chief continues using the existing runtime. Cutover is a later, explicit release step after standalone and integration acceptance. The original plan authorized no immediate switch or paid trial. The owner explicitly authorizes the new-task switch on 10 October; this supersedes the earlier acceptance-before-cutover order without authorizing a paid trial or granting implementation approval.

## Target structure

```text
Standalone CLI ──────────────┐
                            ├─> Independent TypeScript runtime ─> Pi SDK
Chief ─> new runtime adapter ┘          │
                                      ├─> isolated workspace / command execution
                                      ├─> private task, plan and session storage
                                      └─> configured model provider

Chief ─> preserved legacy path ─> existing Python runtime
        existing jobs and optional rollback for new tasks
```

The independent package owns execution and returns results. Chief owns its user interface, owner authorization and delivery. Pi owns the agent loop, tools and normal session/context mechanics. Model credentials and provider policy belong to an explicitly configured trusted boundary, outside generated commands.

Start under `coding_runtime_pi/` with a separate package manifest, lockfile, TypeScript build, tests, README and Dockerfile. No parent workspace dependency, Chief import, required root npm install or inherited environment file. This directory is a staging location, not an architectural dependency. It must work after copying to an empty directory or new repository. Creating a remote repository is not needed to prove this.

## First product contract

One agent supports three explicit intents:

- **Learn:** inspect a repository and return findings tied to source, relevant commands and unresolved questions. Repository access is read-only.
- **Plan:** produce a complete scope and acceptance checks, using more inspection as needed. Return a revisioned plan and wait for a decision before implementation.
- **Build:** consume the approved plan, edit the workspace, run checks, and return the patch, receipts and remaining issues.

These capabilities can be used independently. Do not require a leader/coder/reviewer team or force every question through a rigid three-stage pipeline. “Learn” means task-level understanding and evidence, not model training or automatic global memory.

The first product ends with a checked artifact. Review orchestration, public PR creation, merge, deployment, arbitrary MCP discovery and extensible agent teams are later work. Completion requires actual evidence: a final model message alone cannot mark checks passed.

## Milestone 1 — standalone foundation

Deliver a small package with the Pi coding-agent SDK, a library entrypoint and CLI. Pin Pi to the researched release initially, commit a complete dependency lockfile, and upgrade/pin a supported Node version consistently in development, CI and the container. The Node upgrade is routine setup, not a feasibility blocker.

Initial modules:

- `runtime.ts`: task lifecycle, events, cancellation and deadline.
- `workflow.ts`: allowed transitions and tool sets for learn, plan and build.
- `resources.ts`: explicit trusted Pi resources and small reporting extension.
- `workspace.ts`: file operations and bounded command execution.
- `store.ts`: task artifacts and Pi session persistence.
- `cli.ts`: standalone client of the same public API.

Use the Pi SDK directly. Do not introduce a graph framework, role supervisor or custom model/tool loop. Inject a synthetic provider for deterministic tests. Keep a Pi adapter boundary so public clients do not depend on Pi's internal event types.

**Acceptance:** install/build/test from an external copy with no Chief files, credentials, database, Telegram, GitHub or AWS connection. A synthetic task streams events and returns a result.

## Milestone 2 — learn, plan and approval

Expose read/grep/find/list through explicit tool allowlists. Use Pi's existing navigation behavior with workspace-scoped operations. Supply reviewed instructions as text and disable automatic executable resource discovery. Store findings and questions as task artifacts.

A plan includes its task ID, immutable revision/hash, complete proposed behavior and acceptance checks. Approval references that exact plan; a changed plan invalidates approval. The CLI can provide the decision directly. The later Chief adapter maps the existing owner-bound UI to this generic contract.

**Acceptance:** a repository fixture produces source-grounded findings and a plan; attempted mutations are denied in learn/plan; stale/duplicate approval behaves correctly; no build begins merely because the model requests one. Include a fixture with missing requirements that must return a question.

## Milestone 3 — build, checks and recovery

Enable Pi editing/writing and bounded commands only in an approved build workspace. Use isolated execution, explicit time/output limits, a stripped command environment and verified process cleanup. Protect private runtime/session/provider state from generated commands. Relative-path checks alone do not confine a shell.

Run actual requested acceptance checks and record command, exit status and bounded output. Return a patch/artifact hash plus summary and unresolved issues. The initial package should support one task at a time; parallel scheduling is unnecessary.

Persist a small task record and artifacts beside Pi's conversation/session record, outside editable source. For the local milestone use private per-task directories and atomic metadata updates. Record interrupted operations; resume only explicitly and do not blindly replay a write with unknown outcome. Approved scope is stored independently of compaction summaries.

**Acceptance:** a seeded bug is changed and verified in an actual workspace with a synthetic provider driving the tool loop; failed checks remain failures; cancel terminates work and descendants; restarting reconstructs the session and task without automatic continuation; a compaction fixture retains required scope/evidence. Test the actual supported Linux container, not just the Mac process.

## Milestone 4 — generic remote control and Chief adapter

Only after the standalone workflow works, expose a small versioned remote task interface. Proposed operations are `start`, `inspect`, `events(afterSequence)`, `reply`, `approve(planRevision, planHash)`, `cancel` and `resume`. Requests carry idempotency keys; events have task identity and monotonic sequence; revisions prevent stale decisions. Authentication and ownership must be enforced before remote exposure.

Add a Chief-side client and backend router outside the Python package. Chief stores the backend and remote task ID on each new task and translates existing conversational actions, approval receipts and delivery events. Preserve the current legacy path for old tasks; new routing must not steal cancellation, status or cleanup for them. Where routing metadata needs storage, use an additive reviewed migration and its operator procedure.

Use Pi's native provider support. If Chief retains production model credentials and price/allocation policy, add a narrow task-scoped compatible proxy on the Chief side. Do not force the new runtime to implement the old custom gateway. Preserve tool/reasoning continuation, call accounting, cancellation and uncertain-response handling; include compaction calls in the allowance. Keep existing production model/effort/price/allocation choices until explicitly changed.

Choose the remote execution host independently of the package. The existing sandbox infrastructure may be used through a runner adapter; CodeBuild is not an import or required service in the runtime. Disposable workers must persist private sessions/artifacts durably before cleanup.

**Acceptance:** mock end-to-end Chief request → runtime plan → exact owner approval → build → result; owner isolation, duplicate delivery, restart, timeout and cancellation tests; old task lifecycle tests pass unchanged. The new backend ships unselected for normal production requests. DB/Compose/image/operator prerequisites are classified before implementation.

## Milestone 5 — real acceptance and controlled cutover

Run a separately authorized bounded real task first through the standalone runtime, then through Chief. Freeze the requirements, repository base, model/effort and allocations. Independently inspect source understanding, plan completeness, correct patch, actual checks, retained state, cancellation and sandbox cleanup. Record observed usage and unknown accounting; no quality/cost superiority follows from a single success.

For every implemented runtime/feature change, follow the repository's exact-head independent review and required CI workflow. Publish a verified immutable runtime image. Verify production integration using the exact release receipt and separate health/behavior checks.

Once the new route is accepted, switch only Chief's default for **new** coding tasks to Pi. Existing legacy jobs remain on their original backend. Preserve status/cancel/reconciliation access until all old jobs and uncertain writes are settled; detaching new dispatch must not disable their controller prematurely.

**Acceptance:** one request through Chief reaches the intended Pi image and produces the expected artifact; old tasks still resolve to the legacy path; deployment SHA, health, runtime identity and acceptance evidence are recorded. No unreviewed Pi artifact receives legacy auto-merge authority.

## Rollback and repository extraction

Rollback changes Chief's default for future tasks back to the preserved legacy backend. Existing Pi tasks stay associated with Pi for inspection, cancellation and explicit recovery; never reinterpret them as Python checkpoints. Do not kill user work simply to change the default or release code.

A new repository can be created at any point after milestone 1's extraction test passes. Move only the self-contained runtime package, publish versioned artifacts, and update Chief's adapter configuration to the new image/package location. Chief source, owner data and production credentials do not move with it.

## Definition of the first complete harness

A fresh checkout of the independent package can install, build and test; its CLI can inspect a small repository, present a plan, accept an explicit decision, implement the scope, run real checks, and return a saved patch/result. Stop/restart behavior and isolation are demonstrated. Chief is optional.

That is the first implementation objective. Chief integration and cutover are follow-on milestones. The existing coding runtime remains untouched throughout; connection/routing changes happen in Chief.
