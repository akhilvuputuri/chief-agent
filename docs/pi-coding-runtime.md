# Independent Pi runtime and Chief bridge

Shipped default-legacy foundation/image pin as v0.3.60, 9 October 2026. An owner-authorized v0.3.61 candidate selects Pi for new tasks; exact review/release is pending, and real-model acceptance remains unmeasured. [Plan](pi-coding-runtime-plan.md), [dependency exploration](pi-coding-harness.md), [independent package](../coding_runtime_pi/README.md) and [journal](journey/77-pi-runtime.md).

## Execution and portability

`coding_runtime_pi/` is a self-contained TypeScript package with its own lockfile, library API, CLI, JSONL RPC transport, tests and Dockerfile. It imports Pi and ordinary Node facilities, with no Chief source, Telegram, Postgres or AWS dependencies. A copied external checkout uses the same npm install/build/check commands. Pi owns conversation/tool iterations, native model conversion and context compaction. The small runtime owns intent, approval identity, allocations, checks and results.

Learn/plan/review have read-only tool sets. Build needs an exact approved plan and configured checks. Approval hashes bind task, revision, repository base, workspace, objective, owner instructions, check commands and plan text. Signed task records prevent repository commands from forging approval/completion on disk. Client mutations use an exclusive lock. Restart exposes interrupted work as paused; explicit resume preserves consumed allocations and does not replay a saved tool.

Git artifact capture uses the same bounded/isolated command executor as build commands, including repository-controlled Git filters. It exports exact indexed regular UTF-8 content and validates blob identity rather than decoding invalid bytes into replacement text. Artifacts and check receipts remain inspectable when work pauses or checks fail.

## Chief boundary

The bridge is `src/coding/pi-worker.ts`, outside the package. It receives a job-capability assignment, clones the pinned repository in a disposable worker, invokes the independent runtime and maps progress, questions, plans, checkpoints and terminal results back to Chief. Chief retains leases, origin/owner authority, exact Telegram requirements confirmation, model role preferences, provider filters, model journalling and cleanup.

`config/coding-backend.json` selects the default for new jobs: `legacy` reads the unchanged `config/coding.json`; `pi` reads `config/coding-pi.json`. Each job captures its settings/image/runtime. Existing jobs remain on their original route even after a default change. The old Python source and Dockerfile are not refactored or removed. Controller ticks/status/cancel/publication reconciliation continue for legacy jobs.

Pi has one task-facing agent. Planning uses the owner-selected planner/leader model; implementation uses the coder model. For a publishable candidate the bridge runs actual checks and a separate read-only reviewer session in a fresh restored checkout. Requested changes return to the coder with unchanged approved scope and shared allocation. Pi profiles explicitly forbid the Python squad selector, harness-v2 metadata and automatic merge. Publication produces a draft for exact published-head independent review; it does not inherit the fixed Python squad's automatic merge exception.

## Native model facade

Job-capability endpoints `/coding/worker/:id/pi/{coder,reviewer}/v1/chat/completions` accept bounded native chat-completions requests. Chief selects the pinned role model/effort and retains provider credentials and policy. The caller supplies a request UUID, which maps to the existing encrypted call journal and exact-result reconciliation. Different owners/attempts, altered request identity, expired jobs and unknown model selections are rejected.

Chief currently returns assembled generations. The facade provides compatible SSE framing of a completed generation; it does not establish live token streaming from the provider. Pi's native parser handles text, tools, Unicode and structured reasoning replay. Images and unsupported message shapes are rejected. The worker disables overlapping automatic retries/cache warming and accounts compaction through the same admission boundary. Request byte limits remain distinct from model token context limits.

The only worker credential is its attempt-scoped capability. No OpenRouter key, GitHub App token, Telegram token or database credential enters the worker. It must load its Linux guard before reading bootstrap secrets. Command/search children receive stripped environments; generated commands cannot read the runtime environment/memory through proc. The immutable library/bridge is root-owned outside source.

## Durable Pi history

Pi session entries are uploaded as an immutable sequence, encrypted under Chief's existing host key and owner/job/original-attempt scope. They are stored once as suppressed coding events, not copied into every artifact checkpoint or public progress update. Prefix gaps/conflicting replays fail. Reads are bounded pages and remain job-capability/owner fenced. Storage limits fail visibly rather than truncating history. Host authentication-key rotation must rewrap both existing model response boxes and these Pi session boxes while workers are idle; changing the key alone does not migrate retained history.

Scope keys bind original objective/context/base/approved plan and phase; reviewer scopes also bind the candidate hash. Explicit unchanged recovery can reconstruct acknowledged session entries and files in a fresh worker. Scope changes use a different session key. Unknown upload/model/command outcomes stop for inspection; neither a session nor old reviewer output grants new approval.

## Reviewed rollout

1. Pass exact-head independent review, repository checks/build/format, external package extraction and actual Linux process-boundary tests. Merge the app-only foundation with backend default `legacy`. No database or Compose change is required.
2. Dispatch the main-only `pi-coding-worker-image` workflow. It builds `Dockerfile.coding-pi` and publishes a unique `pi-<main SHA>` tag in the existing public coding package. Old Python tags/digests remain intact. Verify anonymous pull, linux/amd64, non-root user, fixed entrypoint, installed Pi version/source and native guard; pin the immutable digest rather than the tag.
3. Review the image pin in `config/coding-pi.json`. Run a bounded separately authorized real acceptance task, keeping models, effort, price filters and allocations unchanged. Verify planning completeness, actual approved implementation/checks, independent exact-artifact review, draft publication and cleanup. Do not fabricate an owner Telegram approval or resume an old paused job for the trial.
4. Change only the new-job default selector to `pi` in a reviewed release after acceptance, or an explicit owner direction to switch earlier. On 10 October the owner requests the switch before a paid trial; this does not establish live acceptance. Verify the exact release receipt, running identity/health and a request using the intended worker. Startup health alone is not coding acceptance.

The new worker uses the existing dedicated unprivileged sandbox project and authenticated ingress. No new paid infrastructure, account permission or production credential export is needed. Running a real inference/sandbox acceptance task still has usage cost and its own authorization/Telegram decision boundary. Public CI/model mocks never receive production data.

Rollback switches the default for future requests back to `legacy`. Pi tasks keep their own image/session association for inspection/cancel/explicit recovery. Legacy cleanup must keep running until all old work and uncertain external writes are settled. No transcript migration, tag move, data reset or cancellation of user work is part of rollback.

## Current evidence boundary

Synthetic local fixtures cover the actual Pi loop/edit tools, real check commands, plan approval, stale/concurrent decisions, failed checks, metadata tampering, signed cancellation, budget exhaustion, UTF-8 artifacts and the native protocol round trip. Chief regressions cover role pins, replay, encrypted session restoration and launcher/profile isolation. The existing Python suite passes unchanged.

Local Docker verification is unavailable while the Mac is locked and Docker Desktop cannot finish startup. Hosted Linux CI is the verification path. Exact-head independent review, image publication/pin and deployment are verified in [journal 77](journey/77-pi-runtime.md#verified-image-pin-release-closure--9-october-2026). Real-model acceptance remains unmeasured. The owner-authorized new-task selection candidate and its review/release evidence are recorded in [journal 77](journey/77-pi-runtime.md#owner-authorized-new-task-default--10-october-2026); synthetic/health evidence does not establish coding quality.
