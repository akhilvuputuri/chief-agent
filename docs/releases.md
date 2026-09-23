# Versions and release notes

## Released v0.3.24 — parcel tracking and Calendar recovery

[v0.3.24](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.24) points to exact deployed commit `69274943db264770c1c26468dce941113eb91bce`. [PR #67](https://github.com/akhilvuputuri/chief-agent/pull/67) added the delivery tracker and additive migration 019; [PR #89](https://github.com/akhilvuputuri/chief-agent/pull/89) fixed blocked Calendar draft classification and reconnection guidance; [PR #90](https://github.com/akhilvuputuri/chief-agent/pull/90) made failure status guidance task-specific. Main checks passed, and the independently reviewed migration-019 operator rollout from `7b1cff9` reported the exact commit healthy. Separate checks confirmed the migration marker, Calendar account/read and owner-only environment permissions. The normal release workflow could not start because GitHub Actions reported an account payment/spending-limit block; it did not deploy this version. Live Telegram Calendar creation and real-mailbox parcel tracking remain owner acceptance checks. See [Calendar incident](journey/31-calendar-authorization-failure.md) and [delivery tracker](journey/33-delivery-tracker.md).

## Released v0.3.23 — reviewed main-model selection

[PR #82](https://github.com/akhilvuputuri/chief-agent/pull/82) introduced the bundled, versioned model policy. The initial `main: null` keeps the existing environment-derived model; this release did **not** switch to GPT-6. A future agent can select an OpenRouter model in a reviewed policy-file PR and use the ordinary automatic release without a server `.env` edit. Medium reasoning and provider price ceilings are unchanged. Independent GPT-6 Astra review approved the final head; full local and CI checks passed. The [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/35870399160) and exact-commit receipt verified `b22b09d0abca93bc6551468d0ad50ca68551f102` healthy, and the [v0.3.23 tag](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.23) resolves to it. No database or Compose change. See [journal 32](journey/32-repo-controlled-model.md) for the skipped stale-SHA attempt and acceptance limits.

## Released v0.3.15 — scheduled independent agent routines

Historical milestone: [v0.3.15](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.15). The [standard release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/35503855161) also passed for the exact SHA below.

[PR #58](https://github.com/akhilvuputuri/chief-agent/pull/58) and [release coordination #59](https://github.com/akhilvuputuri/chief-agent/pull/59) ship owner-selected schedules, durable occurrence/task identity, latest-only catch-up, non-overlap and saved Telegram delivery results. The reviewed operator rollout applied additive migration 017 and verified deployed SHA `c1f8e7088676d4ee3d041993d5e08412e4c73a70` healthy. Astra approved that exact integrated head. Full checks passed (297 application tests + 2 script tests), as did 13 offline rollout tests. Existing record counts were preserved; no paid live routine was created. See [journal 24](journey/24-scheduled-routines.md) and [the extension contract](scheduled-routines.md).

Previous verified published milestone, checked 20 September 2026: [v0.3.14](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.14), deployed SHA `dd2be311e4cbfaecd75eca64bb0bcb730abfab76` ([release run 35502859189](https://github.com/akhilvuputuri/chief-agent/actions/runs/35502859189), app-only, no migration, reported `{"deployed": "dd2be31…", "healthy": true}`). Previous: [v0.3.12](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.12), deployed SHA `71de810f370d109f859a845de262ae694d3e552f` by the reviewed operator rollout `scripts/deploy-library.py` (migration 16, health verified, recovery clean). Previous: [v0.3.11](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.11), deployed SHA `9c71f61d3578ae5718804b56aa281ee469d38396`; [v0.3.10](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.10), deployed SHA `672021f2afcea620224fd9f7ce7ccfdc53b9ba89`. The reviewed migration 015 operator rollout and [standard release/health workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/34773911229) passed; the immutable tag resolves to that SHA. See the [engineering journal](journey/21-preparation-chain.md) for independent review, preserved-data verification and limitations. Memory/evaluation checkpoints and real-model behavioral acceptance remain separate.

Use immutable semantic-version tags for meaningful, verified shipped milestones. Keep continuous app deployment from main. Tags identify releases; they do not trigger deployment. There were no existing Git tags when this policy was prepared on 12 September 2026. Do not invent retrospective version history.

## First published baseline

[v0.1.0](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.1.0) labels already deployed commit `e6837c0ab0061d768ea752a42548c3921ca3c095`, verified by [release run 34370129968](https://github.com/akhilvuputuri/chief-agent/actions/runs/34370129968). It includes release notes and explicitly excludes unfinished memory and Python evaluation work. Creating the tag did not deploy the checkpoint.

## Version policy

- Start with v0.1.0 as the verified baseline when publishing the first release.
- From 13 September 2026, increment **only the patch** for every new versioned release, including features: v0.3.0 → v0.3.1 → v0.3.2. Do not increment minor or major without a new explicit owner decision. Existing v0.1.0/v0.2.x/v0.3.0 tags remain unchanged. Describe compatibility changes in the notes; patch numbering does not replace migration review.
- Do not tag every documentation commit or unsuccessful candidate. Do not move/reuse tags. Keep checkpoint and experiment branches untagged as production releases.
- Update package.json and package-lock.json in the PR before merging, without creating a local tag (`npm version patch --no-git-tag-version`). Check the latest integrated version first to avoid concurrent release collisions.

## Publish a verified release

1. Merge the reviewed PR after checks. Observe the release job for the exact SHA and confirm healthy deployment. Check current diagnostics if later changes may have deployed.
2. Write notes identifying that exact SHA and the successful workflow link. Include user-visible changes, relevant fixes, validation, migrations, rollback constraints and known limitations. Keep private data out.
3. Create an immutable vX.Y.Z tag/GitHub Release at that verified SHA. Use gh release create with an explicit --target SHA and a --notes-file, or the GitHub UI. Never rely on the default branch head while another task may be merging.
4. Confirm the release target and report it. A GitHub Release is a historical shipped milestone, not evidence that production still runs that version forever.

Release publishing is currently a documented manual agent/operator step; there is no automatic tag or note generation workflow. Future automation should run only after successful deployment with narrow contents-write permission. Keep deploy credentials separate from publication permissions.

## Notes template

Title: vX.Y.Z — concrete capability or fix

- Deployed commit and successful release workflow.
- Changed behavior and why it matters.
- Validation actually performed, including limitations of health versus behavioral checks.
- Migration requirements and rollback restrictions, if any.
- Known gaps; distinguish unfinished memory/evals from shipped features.

Use [docs/journey](journey/README.md) for the deeper engineering story; release notes should summarize shipped behavior. Never claim cost savings or quality improvements without comparable measurements.

## Other practices to adopt gradually

Use GitHub issues for bounded tasks and acceptance criteria, independent branches/draft PRs, short-lived changes, lockfiles, mocked CI, additive migrations, reproducible sanitized incidents, and current handover notes. Add main-branch protection requiring checks and blocking force pushes if the repository's plan supports enforcement. Branch protection and protected deployment environments must be verified in GitHub settings; they are not established by writing this policy.

A later improvement is pinning Actions to reviewed commit SHAs with automated dependency updates. A remote reviewed migration path is also future work. Neither is installed by this document.

## GitHub settings verification — 12 September 2026

The branch-protection API returned HTTP 403 with a requirement to upgrade to GitHub Pro or make this repository public. The environments API returned an empty list. No plan, visibility or account setting was changed. Therefore required PR checks/force-push protection and protected deployment environments are not claimed as enforced. Keep this repository private; a plan upgrade is an owner decision. The existing release workflow independently requires passing checks and current main before deployment.

## Released v0.3.9 — checkpoint steering

[PR #42](https://github.com/akhilvuputuri/chief-agent/pull/42) shipped at `9c6335be09582432d9bf7c4a475c90f9b5e9272a`, the exact target of the published v0.3.9 tag. Two independent GPT-6 Astra reviewers approved `79297e16dd218d8565c86545b7d2ef98da94d1e0`; the merged tree matches that head. The release records 230 application tests plus two scope tests, typecheck/build/format, three offline release-guard tests and eight mocked rollout scenarios.

The reviewed migration014 rollout used the released v0.3.8 baseline, preserved data and paused work, and passed exact deployment/health verification. See the [behavior and rollback guide](checkpoint-steering.md) and [dated journal closure](journey/18-checkpoint-steering.md) for the linked release and diagnostics evidence. No paid model evaluation or production conversation replay was performed. A real Telegram behavioral acceptance check remains separate from startup health and mocked tests; deferred memory/evaluation work was not released.

## Released v0.3.14 — mailbox search that returns what it found

[PR #54](https://github.com/akhilvuputuri/chief-agent/pull/54) merged at `dd2be311e4cbfaecd75eca64bb0bcb730abfab76`; [release run 35502859189](https://github.com/akhilvuputuri/chief-agent/actions/runs/35502859189) deployed it with startup health verified on 20 September 2026. `gmail_search` returns sender, recipient, subject, date, snippet and an unread flag for each of up to ten hits instead of bare identifiers, with a computed hint to narrow or widen and a five-minute cache; `gmail_thread` reads one conversation within bounded limits and degrades to a message list rather than failing on an oversized conversation; a ceiling of 40 Gmail requests per turn is enforced in the adapter, not in an instruction. Guidance was added to runtime context and to `personal-assistance` version 3, and the daily briefing no longer reads message bodies. App-only, no schema or Compose change.

Independent review requested changes on the first head and found a defect 275 passing tests could not see: the conversation reader charged its character budget only against extracted plain text, so messages with no plain-text part cost nothing and a long HTML thread returned every message, overflowing the model projection and silently dropping the untrusted-content warning. Threads are now bounded by message count, by a minimum charge per message and by capped headers, and results are trimmed until they serialise below the projection limit. A second review approved `bea824c`; its minor findings were closed in `4ad749e`, including tests for four fixes that had survived being reverted with the suite green. 287 application tests and 2 scope tests pass.

The version number skipped 0.3.13, which was published the same day for an unrelated library linking fix while this work was in review. No phone acceptance has been recorded yet; the four checks are listed in [journal 23](journey/23-gmail-search.md).

## Released v0.3.12 — linked Libby identity, phone linking and shelf

[PR #52](https://github.com/akhilvuputuri/chief-agent/pull/52) merged at `71de810f370d109f859a845de262ae694d3e552f` after independent review requested changes once (an unrecoverable uncertain link, the NLB-card requirement, remote revoke of a cloned token) and approved `e7691a9`. The automatic release refused the merge as designed; the reviewed operator rollout ran on 20 September 2026 from baseline `794da5f`, generated `LIBRARY_IDENTITY_KEY` on the server, applied only migration 016, confirmed the widened constraint, and reported the exact SHA healthy. Startup recovery reported nothing to recover. Ships `/library`, `/library link`, `/library revoke`, `/library pending`, `library_shelf` and the encrypted identity; borrow, hold and cancel arrive in Phase 3. Owner acceptance (first real link) pending. See [library](library.md) and [rollout](library-rollout.md).

## Released v0.3.11 — NLB catalogue availability

[PR #51](https://github.com/akhilvuputuri/chief-agent/pull/51) merged at `9c71f61d3578ae5718804b56aa281ee469d38396`; [release run 35489220156](https://github.com/akhilvuputuri/chief-agent/actions/runs/35489220156) deployed it with startup health verified on 20 September 2026. Independent review requested changes on the first head (binary-flagged source, lending-period lookup, unwired throttle notice) and approved `cd5417e`. Ships `library_check`/`library_availability` with the Lucky Day verdict rule, the pinned-route paced client and the CI boundary test; no schema or Compose change. Owner acceptance from the phone remains to be recorded in [journal 22](journey/22-library-assistant.md). See [library](library.md).

## Released v0.3.10 — preparation evidence chains

[PR #44](https://github.com/akhilvuputuri/chief-agent/pull/44) merged at `672021f2afcea620224fd9f7ce7ccfdc53b9ba89`, with the same tree as [Astra-approved head `b01a9226c37ea73fa0cb3140fdfb43e11fc08772`](https://github.com/akhilvuputuri/chief-agent/pull/44#issuecomment-5655091129). Validation passed 242 application tests, two Google-scope tests, typecheck/build/format, 12 offline rollout tests and three existing cloud release-guard tests. The reviewer independently ran 20 focused application tests and all 12 rollout tests. The [journal](journey/21-preparation-chain.md) preserves the initial review failure and its correction.

The migration 015 [operator rollout](preparation-rollout.md) succeeded on 14 September 2026 (Singapore time) from baseline `16cb37f28625823df1c35d41bc7f8844db4b09b2`. Separate read-only verification confirmed deployed SHA `672021f2afcea620224fd9f7ce7ccfdc53b9ba89`, healthy startup, migration 15, all three existing preparation tasks retained with empty evidence arrays, and no active runs. [Main CI](https://github.com/akhilvuputuri/chief-agent/actions/runs/34773706544) passed; the [standard release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/34773911229) passed and the published [v0.3.10](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.10) tag resolves to that exact deployed SHA. No historical evidence backfill, production role reanalysis, automatic task resumption or mastery assessment is included.
