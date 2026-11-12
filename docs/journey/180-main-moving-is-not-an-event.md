# 180 — Main moving is not an event

Work date(s): 2026-11-13. Written/revised: 2026-11-13.
Status: implemented and tested offline on branch `coding-revamp/a-no-main-trigger` from `2910171b`; review, merge and release are pending. Part of the coding-loop revamp that follows [179 — first full coding job review](179-first-full-coding-job-review.md).

## User-visible problem and preceding iteration

When a Pi owner-merge job had a reviewed PR and was heading for its Merge card, any commit on main, conflicting or not, made Chief throw the saved change away and re-implement it from the plan on the new main, up to twice. The owner then waited for a second (and third) full implementation and review before the Merge card came back.

The trigger came from the owner policy of 17 October 2026 (re-implement on current main; the plan approval carries over) and the two-rebase cap. The 179 review found it was the largest single cost in the first full job. A normal pull-request workflow does not treat "main moved" as an event: a PR that is behind main but has no conflict merges fine.

## Evidence

- **From journal 179 (measured there, not re-measured here):** job `9600af57` was rebuilt twice after it already had a reviewed PR, once for a docs-only commit; everything after the first reviewed PR cost $68.39 of $104 and 7 h 1 min of about 10 machine-hours. Each rebuild cost about what the first implementation cost. Whether the second trigger (PR 460) would have conflicted is not known; nothing recorded GitHub's mergeability at the time.
- **Verified in source (`src/coding/automation.ts` at `2910171b`):** `tick()` computed `mainMoved = i.main !== j.base_sha` for owner-merge jobs and called `rebase()` whenever it was true, before readiness, feedback and the Merge card. `rebase()` cleared `checkpoint.files` and `patch`, moved `base_sha` to main's tip and re-queued an implementation; it stopped after two `rebase:%` revisions.
- **Verified in source, further assumptions on the merge path:**
  - after the owner's Merge tap, the final re-read refused to merge when `final.main !== j.base_sha`, for owner-merge jobs too;
  - `GitHubAutomation.ready()` and `merge()` refused when the PR's `base.sha` differed from the job's base (`MergeTarget.baseSha`). GitHub's `base.sha` follows main, so a PR on a moved main could not be marked ready or merged;
  - GitHub reports `mergeable: null` while it recomputes mergeability, which it does after pushes to main. The merge gate treated that like a failing check: it moved a job out of `awaiting_merge_approval` (making a tap in that window fail), moved `merge_approved` back to `awaiting_ci` (discarding the owner's tap and sending a second card), and parked the job in manual review once an hour had passed since the automation record started.
    These were all hidden while every moved main triggered a rebuild.
- **Verified in source, no assumption found:** publication builds the PR commit on `j.base_sha` with the reviewed files and checks that the head tree equals that candidate tree (the PR's own content, correct on any main). The approval check `approvedArtifact` binds the reviewer's verdict to the artifact hash. Merge-card answers bind to revision and head. The `merging` reconciliation checks only `merged` and the head. Release tracking (`release(mergeSha)`) follows the merge commit GitHub made, not a tree.

## Diagnosis and alternatives

The cause is the trigger itself: "main differs from the job's base" was treated as needing work. The correct signal is GitHub's own answer about whether the PR merges: `mergeable: true` merges, `false` is a conflict, `null` is not computed yet.

Alternatives considered:

- Make the reaction cheaper (PR 469: `git apply --3way` and re-review only the difference). Closed by the owner as a symptom fix: it keeps the trigger.
- Require the branch to be up to date before merge, as some repositories do. Not used: it reintroduces the event this piece removes, and main's own CI and the release runs on the merge commit anyway.
- Resolve a real conflict with an in-box `git rebase` of the reviewed commit. That is the next piece of the revamp. Until then a real conflict still uses the existing re-implementation (`rebase()`); this is the **remaining interim behaviour**, marked in code comments.

The two-rebase cap is removed rather than kept. With conflict as the only trigger, each re-apply needs a new commit on main that conflicts with this PR, so the path cannot loop by itself. The re-apply still stops when the job's existing model-call and tool totals are spent. No new limit was added.

The legacy squad path (`autoMerge`, Python runtime) keeps its "Main changed since approved requirements; reconcile base and review before merging" stop unchanged. The bundled selector `config/coding-backend.json` picks `pi`, whose profile is `owner_merge`, and the schema refuses `autoMerge` on Pi, so no new job reaches that stop. Only a job created under the legacy profile that still sits in an automation stage could. Production rows were not inspected, because this work had no host access.

## Implementation and review

- `src/coding/automation.ts`:
  - an owner-merge job's base and main are no longer compared;
  - `rebase()` runs only when `mergeable === false`, and its owner text says the PR conflicts with main;
  - the two-rebase counter is removed;
  - the final re-read before merge compares head and tree (and base and main only for the legacy flow);
  - `mergeable: null` with checks passed and no open threads waits in its current stage, touching `updated_at` so other jobs still get their turn. This applies at the first read and after the final re-read. A waiting card and an owner tap both survive, and nothing times out because of it.
- `src/coding/github-automation.ts`, `src/coding/merge-policy.ts`: `ready()` and `merge()` no longer compare the PR's `base.sha`; `MergeTarget.baseSha` is removed because nothing else used it. The merge is still pinned to the reviewed head (`sha: head`).
- `src/coding/controller.ts`, `src/runtime.ts`: tool and status texts no longer say the job is rebased when main moves; they say main moving does not change the job and only a merge conflict sends the change back to the coder.
- Dated notes in `docs/coding-automation.md`, `docs/coding.md`, `docs/boxes.md`.

A squash or merge commit of a clean PR onto a moved main has a different tree from the reviewed candidate. Nothing on the path compares them. Approval stays tied to the PR's own head commit and tree.

## Verification and outcome

Run locally on 13 November 2026 (results in the builder's report):

- `tests/coding-pi-owner-merge.test.ts`, new and changed tests:
  - main moved with a clean merge: no rebuild, the Merge card is reached and survives a further move, the tap merges, and the release is tracked by the merge commit to `deployed`;
  - unknown mergeability over two hours keeps the card and the tap, including a `null` on the final re-read, and merges once it is `true`;
  - a conflicting PR is re-applied (interim), including after three earlier re-applies;
  - a re-apply never carries over an unapproved scope.
- `tests/coding-github-automation.test.ts`: a moved `base.sha` neither blocks readiness nor the exact-head merge.
- The test "automatic rebases stop after two rounds" was deleted with the cap.

Not run: any real GitHub call or paid model call.

## Follow-up and next iteration

- Replace the interim conflict re-implementation with an in-box `git rebase` of the reviewed commit (next revamp piece).
- Release tracking waits for a `companion/production` receipt on the exact merge commit. Within the `companion-production` concurrency group, a later push to main can supersede a still-pending release run, so the merge commit may never get its own receipt and the job would park after an hour. This was not changed here. It is a property of main moving after the merge, not before it.
