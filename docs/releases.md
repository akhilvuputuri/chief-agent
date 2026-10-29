## Coding reviewer moves to Claude Opus 5.5 (29 October 2026)

- **Configuration.** `config/coding-pi.json` and `config/coding.json` change the default coding reviewer from `google/gemini-4-argon` to `anthropic/claude-opus-5.5` ($4/$20 per million tokens, inside the existing price ceilings). It applies to new jobs; a job keeps the models it was created with.
- **Paused job.** At the owner's request, the paused job `a30098ba` had its pinned reviewer changed to Opus 5.5 by a guarded one-row production update (paused, unleased, previous reviewer Gemini), with Opus's 1,000,000-token context window added to its snapshot.
- **Why.** The job finished implementation with every check passing, then paused three times at the same step of review: Google cut the Gemini reply off mid-generation (a 502, then empty replies, with no finish reason). See the [coding-agent lessons](journey/coding-agent-lessons.md).

## Installed `6e90db7` by operator rollout — agentwatch on the host, traces with content (#323)

- **What merged.**
  - [PR 359](https://github.com/akhilvuputuri/chief-agent/pull/359) merged as `e6abb13` and was released by the workflow. It adds opt-in message content on traces: messages, tool arguments and results, scrubbed and capped.
  - [PR 360](https://github.com/akhilvuputuri/chief-agent/pull/360) merged as `6e90db7`. It adds the `agentwatch` Compose service (GHCR image pinned by digest, 90-day retention, loopback only) and points the gateway at it with content on. `CHIEF_TRACE_ENDPOINT` and `CHIEF_TRACE_CONTENT` in `.env` are kill switches.
- **Review.** Independent review (Claude Opus 5.5):
  - PR 359 took four rounds, including one blocking finding (quadratic base64 scrubbing). It was approved at `6a9fb82`.
  - PR 360 was judged safe to run at `d284a6b`, after it gained a check that agentwatch can store a span before the gateway is touched.
  - Hosted CI passed on both heads.
- **Release.**
  - The automatic release refused the Compose change, as designed.
  - The operator ran `scripts/deploy-agentwatch.py` from an exact archive of `6e90db7`, with hashes verified on both sides, at about 15:00 UTC on 29 October.
  - It reported the deploy healthy with agentwatch up. The gateway logged `trace.export_enabled` with `contentCaptured: true`.
  - agentwatch is healthy, uses about 50 MB of its 512 MB limit, and is reachable only on `127.0.0.1:4318`, through an SSH tunnel ([lightsail](lightsail.md#traces-agentwatch)).
- **Since:** the next automatic release, `b431444`, the first to pull the CI-built gateway image, deployed healthy and left agentwatch untouched.
- **Pending:** the first real turn's trace.

[Journal 134](journey/134-agentwatch-on-the-host.md#release-closure--2026-10-29).

## Coding limits raised (29 October 2026)

- **Code.** [PR 357](https://github.com/akhilvuputuri/chief-agent/pull/357) merged as `8e53d52`. Exact-head independent review (Claude Opus 5.5) approved it after one blocking fix: Pi session entries had stayed capped at 512 KB.
  - Coding artifacts may now have 500 files of up to 1 MB each, 10 MB in all.
  - Uploads may be up to 64 MB, model requests up to 4 MB, and messages and tool arguments up to 1 MB.
  - Session entries may be up to 4 MB, with 512 MB of session storage per job.
  - Files over 256 KB, or past 1 MB inline, are published to GitHub as separate blobs.
  - A Pi attempt may run up to 3 hours, inside a 4-hour box task deadline; the schema allows up to 4 hours, 2,000 model calls and 5,000 tool calls.
- **Configuration.** [PR 358](https://github.com/akhilvuputuri/chief-agent/pull/358):
  - re-pins the worker image to `sha256:97cee1ae…`, built from `8e53d52`;
  - gives new jobs 150 minutes, 1,500 model calls and 4,000 tool calls;
  - raises the coding box's hard maximum to 6 hours.
- **Why.** A medium coding job twice hit "Artifact too large": the repository's living docs alone used half of the old 500 KB budget. See the [coding-agent lessons](journey/coding-agent-lessons.md).

## Deployed `bc4c5c0` (untagged) — implicit redirect feedback on traces (#323 phase 4)

- **What merged.** [PR 355](https://github.com/akhilvuputuri/chief-agent/pull/355) merged as `bc4c5c09e077eb22bd32ee2c1f295c6de730e941` (version unchanged). The owner does not rate answers. When trace export is on, the owner's next message after a turn is checked against it with text patterns, with no model call: a retry, a correction (the learner's `isCorrection`) or a rephrase. The result becomes a `user_redirected` `gen_ai.evaluation.result` on that turn's root span: true with a fixed label, or false. Root spans carry `gen_ai.conversation.id` (`thread.<n>`). Only a fixed name, a boolean and a label leave the process. No migration.
- **Review.** Independent review (Claude Opus 5.5) found nothing blocking on `275997e`, but its should-fix findings drove three more rounds:
  - **Retries:** ordinary requests counted as retries ("add another one for Tuesday", "do it again next week"), and a follow-up message could exceed the "first message only" rule.
  - **Rephrases:** a single swapped word or digit counted as a rephrase.
  - **Corrections:** an over-broad fix then dropped real corrections that mention a time.
  - **Messages without owner words:** forwards and uncaptioned photos were scored.

  Each counterexample is now a test. The reviewer approved the exact head `8db624b`, on which hosted CI passed.

- **Release.** The [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/40845451244) deployed the exact commit at 09:01 UTC on 29 October, and startup health passed.
- **Pending:**
  - Nothing runs in production until an endpoint is configured, which needs an owner decision.
  - How often the rules fire or misfire on real messages is unmeasured.

[Journal 133](journey/133-implicit-redirect-feedback.md#release-closure--2026-10-29).

## Deployed `260c94c` in `b6e1071`, now `845595e` (untagged) — learning from conversation turns (#326)

- **What merged.** [PR 349](https://github.com/akhilvuputuri/chief-agent/pull/349) merged as `260c94c` (version unchanged). The learner's first night reviewed 7 tasks and skipped all of them (six routines, one cancelled), because most owner requests never become a tracked task. Each run now also labels up to 30 ordinary conversation turns: success when answered and not corrected in the owner's next message within six hours, pitfall when corrected, with the correction kept as quotable owner evidence. Evidence sizes are generous for now (owner's choice): about 8,000 characters a turn and 12,000 a task. Prompt `learner-v2`. No migration.
- **Review.** Independent review (Claude Opus 5.5) requested changes on `69e141c`: acknowledgements and new requests counted as corrections, and plain corrections were missed. It approved `c387758` and `076d7e2`, which also mark the correction label as a heuristic in the prompt and bound the current memory list. Hosted CI and Devin passed on `076d7e2`.
- **Release.** It had no release of its own: merges from other sessions landed minutes later, and the release went out for `b6e1071` (0.3.108). That release's third attempt started at 02:58:30 UTC and recorded its exact-commit receipt at 03:05:25 UTC on 29 October; it is now in `845595e`, recorded at 03:15:08 UTC; neither later commit touched the learner. The host reported `845595e`, healthy, with no `error`-level line in the gateway container's log since it started.
- **Pending:** the first run with turns, from 19:30 UTC on 29 October (03:30 Singapore on 30 October): counts, charges and what it learned.

[Journal 130](journey/130-nightly-learner.md#first-night-and-conversation-turns--2026-10-29).

## Deployed `7ba6831` (untagged) — OpenTelemetry trace export (#323 phase 1, Chief's half)

- **What merged.** [PR 347](https://github.com/akhilvuputuri/chief-agent/pull/347) merged as `7ba68314ddd4617f305c6d8471fac0a2a1c6ade2` (version unchanged, 0.3.107). With `OTEL_EXPORTER_OTLP_ENDPOINT` set, Chief exports runs, model calls and tool calls as OTLP GenAI spans (metadata only, never awaited by a turn). Production sets no endpoint, so export is off there.
- **Review.** Independent review (Claude Opus 5.5) approved `6fa316d` with fixes to make: provider HTTP failures exported `error.type=_OTHER`; a turn failing before `Execution.finish` left no run span; not every hook caught its own errors; the shutdown flush could exceed Docker's grace period. Fixed in `909a400`, which the delta review approved. Hosted CI passed on that head.
- **Release.** The [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/40745519047) deployed the exact commit at 18:35 UTC on 28 October and startup health passed.
- **Pending:** nothing runs in production until an endpoint is configured, which needs an owner decision on where the collector runs. The local full check passed except the corrupt-gzip test, which needs Node 22.23.4 (the laptop had 22.15; CI passed it).

[Journal 131](journey/131-otel-trace-export.md#release-closure--2026-10-28).

## Deployed `d7df9aa` (untagged) — the nightly learner (#326 phase 2)

- **What merged.** [PR 340](https://github.com/akhilvuputuri/chief-agent/pull/340) merged as `d7df9aa9dceace29174b907d0ef342ed3f9faaa0` (version unchanged, 0.3.107). Once a night from 03:30 Singapore, Chief labels the owner's finished work tasks and runs one bounded `standard`-tier review with four learning tools; the host checks every proposal (a fact must quote the owner's own words, and the quote must state it) and applies accepted items with provenance and trust tags. Telegram intake now marks forwarded messages as someone else's words, and no forwarded text is parsed as a command, control or approval. `LEARNING` in `config/runtime.json` switches the learner off. No migration.
- **Review.** Independent review (Claude Opus 5.5) requested changes twice: on `c77d295` (a quote did not have to support the fact; attached PDF text counted as the owner's words; unknown operations were not tagged untrusted) and on `64c8d44` (forwarded messages counted as the owner's words; negation and short words passed the quote check). It approved `f59dc11` with a non-blocking note that a forwarded `/approve`, `/status` or plain "yes" was parsed as the owner's, a gap that predates this work (fixed in `44f00fa`), then approved `44f00fa`, the rebase onto phase 1 (`c5e345f`, code identical) and a docs fix (`fa9e0d4`, merged tree identical). Hosted CI and Devin passed on `fa9e0d4`.
- **Release.** The [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/40721152167) deployed the exact commit at 16:04 UTC on 28 October; `gateway.started` logged it on Node v22.23.4, and the gateway's container log had no `error`- or `warn`-level line from its start at 16:03:49 to 16:06:35 UTC.
- **Pending:** the first night's run from 19:30 UTC (03:30 Singapore): `learner.finished` counts, its charges in `provider_charges`, and what it wrote (`memory_revisions` with `origin='learned'`). A fake model drove every test, so real proposal quality is unmeasured.

[Journal 130](journey/130-nightly-learner.md#release-closure--2026-10-28).

## Deployed `e6f75f7` (untagged) — revisioned memory for learning from work (#326 phase 1)

- **What merged.** [PR 338](https://github.com/akhilvuputuri/chief-agent/pull/338) merged as `e6f75f7352452f0e7543706584569628b75e4ad8` (version unchanged, 0.3.107). Memories become immutable revisions with provenance, trust tags and threat flags; each owner turn records what it had in context; learned items can be rolled back in bulk; `memories` stays as the projection of the owner's explicit facts. Migration 010 with its Compose line and `scripts/deploy-memory.py`.
- **Review.** Independent review (Claude Opus 5.5) requested changes on `16d55da`: undoing two learner runs one after the other could leave an undone value active, and a restored learned value could lose its labels. Fixed with the `memory_undone` ledger; approved `bd7fee2`, then the baseline pin and the rebase onto the Kite main (`211b9fd`, merged tree identical). Hosted CI and Devin passed on `211b9fd`.
- **Operator rollout.** Live and `main` were both `0a78485`, healthy and idle, with 7 memories for 1 owner and no memory tables. The archive and script hashes matched on the host. `deploy-memory.py` reported `{"deployed": "e6f75f7…", "healthy": true, "migration": 10}` at 15:42 UTC on 28 October. Separate checks: `RELEASE`, health, marker 10, 7 `legacy` revisions with trust `unknown` and heads matching every `memories` row, `memory.imported` with `importedCount: 7`, `projectedCount: 0`, and `gateway.started` on Node v22.23.4.
- **Automatic release.** Its first run tried to take the release lock at 15:40 while the rollout held it and stopped with `[Errno 11] Resource temporarily unavailable`; the [re-run](https://github.com/akhilvuputuri/chief-agent/actions/runs/40718375876) succeeded as a no-op at 15:43:58 UTC.
- **Pending:** the cached-token counts and `memory.selected` events of the next owner turns, compared with the days before; the prefix should be unchanged until the learner (phase 2) writes something.

[Journal 129](journey/129-revisioned-memory.md#release-closure--2026-10-28).

## Deployed `1ff88d2` (untagged) — mail index reads within Gmail's quota

- **What merged.** [PR 336](https://github.com/akhilvuputuri/chief-agent/pull/336) merged as `1ff88d24d3c05333df673bebb15a279f602f7981` (version 0.3.105). Index reads are paced at about two a second; a Gmail quota refusal pauses reading for a minute instead of abandoning messages; a cut-short top-up keeps what it read.
- **Review.** Independent review (Claude Opus 5.5) approved after one should-fix. Devin's non-quota-403 finding is accepted and documented. Hosted CI passed.
- **Release.** Live at 16:50 UTC on 27 October ([release](https://github.com/akhilvuputuri/chief-agent/actions/runs/40544135098)). The next release's build (`45bd6ed`) indexed 1,408 messages with none left out, against 384 left out before the fix.

[Journal 120](journey/120-email-memory-mvp.md#quota-fix-release--2026-10-27).

## Deployed `da2a5ff` (untagged) — closing the dependency hardening (#329)

- **What merged.** [PR 335](https://github.com/akhilvuputuri/chief-agent/pull/335) merged as `da2a5ff752e5501f313c51c8904b2df21540631d` (version unchanged, 0.3.104).
  - Upgrade requests answered over plain HTTP no longer leave their sockets open, on any route. Shutdown destroys WebSockets that ignore the closing handshake after 1 s.
  - One shared bounded body reader, and more refused bodies are cancelled.
  - CI terminates idle and in-transaction Postgres sessions on PostgreSQL 17.
  - A corrupt-gzip regression test.
  - `@fastify/websocket` 11.3.4.
  - Pool timeouts stay unset.
- **Review.** Independent review (Claude Opus 5.5) requested changes on `f28a83e`: a regression would have hung a test instead of failing it, there were stale records, and a smoke-script comment over-claimed. It approved the merged head `8498cae`. Devin found no issues.
- **Release.** The [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/40541427136) deployed the exact commit at 16:35 UTC on 27 October, about 10 minutes after the merge. `gateway.started` logged `nodeVersion: v22.23.4`, with no warn or error lines. No migration. #329 is closed.
- **First stop.** The next release, `1ff88d2`, stopped it at 16:50 UTC. It went through `closeServer()` and logged `gateway.stopped` 162 ms after `gateway.stopping`, with no `stop_incomplete`.

[Journal 127](journey/127-closing-dependency-hardening.md#release-closure--2026-10-27).

## Deployed `fcdb81c` in `c4ba246` (untagged) — mail index widened to 12 months

- **What merged.** [PR 321](https://github.com/akhilvuputuri/chief-agent/pull/321) merged as `fcdb81ceb908bb370fb15f1709f323489e8c341c` (version 0.3.104). The `gmail_recall` index covers 12 months of Primary mail instead of 30 days. The PR also records the 30-day retrieval eval.
- **Review.** Independent review (Claude Opus 5.5) approved the change, a docs delta and the merge of main. Devin flagged a stale journal index row, fixed before merge. Hosted CI passed on the merged head.
- **Release.** Deployed inside `c4ba246` at 15:47 UTC on 27 October ([release](https://github.com/akhilvuputuri/chief-agent/actions/runs/40534440754)). No migration. First build: 1,024 messages indexed and 384 left out by Gmail's per-user quota; the quota fix follows.

[Journal 120](journey/120-email-memory-mvp.md#release-closure-and-first-12-month-build--2026-10-27).

## Deployed `c4ba246` (untagged) — Pi worker image on Node 22.23.4

- **What merged.** [PR 334](https://github.com/akhilvuputuri/chief-agent/pull/334) merged as `c4ba246afeaf10d0473a4665125e6bec55516d3d` (version 0.3.104, bumped by PR 321, which this release also carried). New coding jobs use the Pi image `sha256:2fd65df…`, published by `pi-coding-worker-image` run 13 from `15e6def` on Node 22.23.4. `e8f1c2…` and `ba99d9…` stay in `previousImages` for snapshotted jobs.
- **Review.** Independent review (Claude Opus 5.5) approved `4e8621f` with three Low/Info record findings. It approved the merged head `fc3ca35` after a dropped sentence was restored. Devin's one yellow finding (a stale journal index row) was fixed.
- **Release.** The first release run for this commit ([286](https://github.com/akhilvuputuri/chief-agent/actions/runs/40534214107)) was triggered by PR 321's checks and refused at "Verify current main", because `main` had already moved to `c4ba246`. [Run 287](https://github.com/akhilvuputuri/chief-agent/actions/runs/40534440754) deployed `c4ba246` at 15:51 UTC on 27 October, about 10 minutes after the merge. That release also carries PR 321. `gateway.started` logged `nodeVersion: v22.23.4`. The previous release logged `gateway.stopped` 188 ms after `gateway.stopping`. No warn or error lines from 15:30 to 15:55. No migration.
- **Not yet observed.** A coding job running on the new image.

[Journal 126](journey/126-fetch-hygiene-and-node.md#pi-image-re-pin--2026-10-27).

## Deployed `9ab96c2` (untagged) — fetch hygiene and Node 22.23.4

- **What merged.** [PR 332](https://github.com/akhilvuputuri/chief-agent/pull/332) merged as `9ab96c2754370d170b60357b1faa0702df6a2b2b` (version unchanged, 0.3.103).
  - Node 22.23.4 is pinned in CI, the release workflow, `.nvmrc`, the host-built gateway and browser images and the Pi images. Its undici 6.29.1 fixes a fetch hang on corrupt gzip bodies, reproduced on Node 22.22.
  - `gateway.started` logs `nodeVersion`.
  - Fetch failures log the cause's code and class.
  - Unread error bodies are cancelled, and the Singapore client stops at its limit on the decoded stream.
- **Review.** Independent review (Claude Opus 5.5):
  - requested changes on `d0e139c`: the gateway image built on the host reused a cached floating Node base, so the fix would not have reached it; the Singapore test proved nothing;
  - found a Low gap on `ae90de6`: the log reader did not show the new fields;
  - approved the merged head `30537c4`.

  Devin found no issues.

- **Release.** The [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/40498941212) deployed the exact commit at 11:54 UTC on 27 October, about 10 minutes after the merge. `gateway.started` logged `nodeVersion: v22.23.4`. No migration.
- **Not yet done.** Republish the Pi image and update its digest in `config/coding-pi.json`.

[Journal 126](journey/126-fetch-hygiene-and-node.md#release-closure--2026-10-27).

## Deployed `211b2a2` (untagged) — Postgres connection drops and bounded shutdown

- **What merged.** [PR 331](https://github.com/akhilvuputuri/chief-agent/pull/331) merged as `211b2a2add939647e1e4a46e34932d839eca2430` (version unchanged, 0.3.103).
  - A Postgres session ending no longer stops the gateway: the pool and checked-out clients have `error` listeners, and broken clients are discarded.
  - Shutdown stops intake, waits for running handlers, then closes HTTP and the database within 8 s, and logs `gateway.stopped` or `gateway.stop_incomplete`.
- **Review.** Independent review (Claude Opus 5.5) approved, then requested changes once (polling could start after a stop began during startup), and approved the merged head `f105ad8`. Devin's red finding (a stuck fetch loop counted as a complete stop) was fixed in `f105ad8`; the reviewer rated it Low.
- **Release.** The [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/40495096407) deployed it at 11:22 UTC, about 10 minutes after the merge. No migration. Its first production stop, by the next release at 11:54 UTC, logged `gateway.stopped` 160 ms after `gateway.stopping`.
- **Not yet observed.** A Postgres restart in production.

[Journal 125](journey/125-db-drops-and-shutdown.md#release-closure--2026-10-27).

## Deployed `8ea6263` (untagged) — faster checks

- **What merged.** [PR 324](https://github.com/akhilvuputuri/chief-agent/pull/324) merged as `8ea62631b0a2e30f77e0076fde07a4bfd300d72e` (version unchanged, 0.3.103). Tests restore each PGlite database from a per-process migrated snapshot, a close hook stops `node:test` keeping closed databases in memory, and `checks` runs as parallel jobs with six serial test shards behind the unchanged `test` job. Tests, CI and docs only; no runtime change.
- **Review.** Independent review (Claude Opus 5.5) requested changes twice (a missed import, then Pi's tests no longer running against the root lockfile) and once on docs wording, and approved the merged head `0d2a1cc`. Devin found no issues. One CI run with four test files at a time lost a test process to SIGSEGV; the owner chose serial files per runner.
- **Release.** `checks` on `main` took 4 min 38 s ([run](https://github.com/akhilvuputuri/chief-agent/actions/runs/40476079773)), against about 26 minutes before. The [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/40476636054) deployed the exact commit with startup health passing at 08:59 UTC on 27 October, about 11 minutes after the merge. No migration.
- **Not yet observed.** A coding box's `npm run check` time with the new fixture.

[Journal 123](journey/123-faster-checks.md#release-closure--2026-10-27).

## Deployed `d98f912` (untagged) — email memory MVP

- **What merged.** [PR 320](https://github.com/akhilvuputuri/chief-agent/pull/320) merged as `d98f91201488956c2af7245007ac5991a3c9fdef` (version 0.3.103; the PR did not bump the version). The email agent gets `gmail_recall`, an in-memory meaning index over the primary mailbox's Primary mail from the last 30 days. Embeddings come from OpenRouter, and the index rebuilds after each start. Optional host tools keep the email agent usable without it.
- **Review.** Independent review (Claude Opus 5.5) requested changes: the email agent failed without the index, a top-up gap, re-reads after a failed build. It then approved, and approved a delta for an eval counter Devin flagged. Devin's deleted-mail finding is deferred. Hosted CI passed.
- **Release.** Live at 12:56 UTC on 25 October, with `release:status` success ([release](https://github.com/akhilvuputuri/chief-agent/actions/runs/40194920183)). No migration. First build: 119 messages, 65,925 embedding tokens, 40 seconds.
- **Not yet observed.** The retrieval eval and live use.

[Journal 120](journey/120-email-memory-mvp.md#release-closure--2026-10-25).

## Deployed `3130950` (untagged) — fewer coding notices

- **What merged.** [PR 314](https://github.com/akhilvuputuri/chief-agent/pull/314) merged as `3130950f492d0fc580330b8120ab8b90ac6965ea` (version 0.3.102). Coding progress goes into one Telegram status message per job, edited in place; progress that would start a new message is held 23:00–08:00 Singapore; cancellations within 15 seconds become one summary; non-owner-merge PR notices carry the coder's summary; a per-job lease serialises status edits; identical rebases are detected and logged only.
- **Review.** Independent review (Claude Opus 5.5): approve with nits, twice, with an outbox-stall finding fixed in between. Devin found two lease races under overlapping gateways on the merged-up head; the merge was held until both were fixed and a further delta review approved. Hosted CI passed.
- **Release.** Live at 14:41 UTC on 23 October, with `release:status` success ([release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39971116118)). No migration.
- **Not yet observed.** A live coding job showing one edited status message, overnight progress held, and message counts compared with the 107-a-week baseline.

[Journal 115](journey/115-fewer-coding-notices.md#release-closure--2026-10-23).

## Deployed `7084064` (untagged) — no more double replies

- **What merged.** [PR 315](https://github.com/akhilvuputuri/chief-agent/pull/315) merged as `70840644f11a0fc41d655e3cf781d6b466fc8e8d` (version 0.3.101). Text a model writes beside tool calls is not sent as progress when the `finish_turn` reply that will be delivered already contains it.
- **Review.** Independent review (Claude Opus 5.5): approve with nits; the containment check replaced the first version. Devin found an earlier or invalid `finish_turn` could hide text; fixed before merge by comparing only the reply that will be delivered.
- **Release.** Live at 13:51 UTC on 23 October, with `release:status` success ([release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39963924539)). No migration.
- **Not yet observed.** No progress delivery the same size as its run's answer, at the next weekly review.

[Journal 119](journey/119-double-reply.md#release-closure--2026-10-23).

## Deployed `a39f8eb` (untagged) — tolerant agent reports and partial results

- **What merged.** [PR 313](https://github.com/akhilvuputuri/chief-agent/pull/313) merged as `a39f8eb684a77192b468b352496c524b5b3d5330` (version 0.3.100). Short refs are accepted as whole tokens the child saw; research quotes match after normalising whitespace, quote marks and dashes, word-bounded and with bounded, qualifier-safe gaps; rejections list every failure; children are warned before their last call; rejected or late reports return as `partial` with unsupported items marked.
- **Review.** Independent review (Claude Opus 5.5) requested changes (meaning-inverting quotes reproduced), then approve with nits, then approve (40,000 fuzz cases against a brute-force reference). Devin posted two findings on the final head after its check passed and the merge did not wait; both were fixed in PR 317.
- **Release.** Live at 12:18 UTC on 23 October, with `release:status` success ([release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39951629213)). No migration.
- **Follow-up.** [PR 317](https://github.com/akhilvuputuri/chief-agent/pull/317) merged as `56e34ccde9bc0c19bb98445e27eefc97e1d3c881` (version 0.3.103) and deployed at 15:40 UTC on 23 October ([release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39979578299)): the shortest _acceptable_ quote span is used, and an incomplete child returns its latest 12 calls. Independent review approved (fuzzed against an exhaustive reference).
- **Not yet observed.** Fewer web-agent `budget_exhausted` endings without a report, compared with the two October reviews.

[Journal 116](journey/116-tolerant-agent-reports.md#release-closure--2026-10-23).

## Deployed `79933ce` (untagged) — coding cancel correctness

- **What merged.** [PR 312](https://github.com/akhilvuputuri/chief-agent/pull/312) merged as `79933cea6e377820ca87aa1a3b003dac92d67154` (version 0.3.99). Unique-index violations are reported by the index they name, so a busy coding worker slot no longer reads as a work-task conflict. Identical refused calls stop after two refusals. `coding_cancel` refuses with the reason and next step when nothing changed. Restarting coding work idle for more than 24 hours needs explicit owner confirmation.
- **Review.** Independent review (Claude Opus 5.5): approve with nits plus one medium finding (the stale gate ran before the state check) and one low-medium (bulk cancels tripped the form guard); both fixed, delta review approved. Devin and hosted CI passed.
- **Release.** Live at 11:26 UTC on 23 October, with `release:status` success ([release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39945473300)). No migration.
- **Not yet observed.** A refused cancel and a stale resume in live use.

[Journal 114](journey/114-coding-cancel-correctness.md#release-closure--2026-10-23).

## Deployed `fdb88c7` (untagged) — open loops that last and memory offers

- **What merged.** [PR 311](https://github.com/akhilvuputuri/chief-agent/pull/311) merged as `fdb88c79e644d037bb93ae0030dd742a527e1a87` (version 0.3.98). Lapsed monitoring cards stay in open loops until a day after their end date (seven days undated, at most 30); Chief's own unanswered questions are listed for three days; the coordinator offers to remember a stated durable preference and saves it only after the owner agrees.
- **Review.** Independent review (Claude Opus 5.5): approve with nits, then approve after stronger tests (13 mutations checked). Devin found that the note said a due card's date "has arrived" when it may be a day away; fixed before merge.
- **Release.** Live at 10:31 UTC on 23 October, with `release:status` success ([release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39939022244)). No migration.
- **Not yet observed.** Chief mentioning a due card, re-raising an unanswered question across topics, and making a memory offer in live conversation.

[Journal 117](journey/117-open-loops-and-memory-offers.md#release-closure--2026-10-23).

## Deployed `fac557b` (untagged) — telemetry gaps

- **What merged.** [PR 310](https://github.com/akhilvuputuri/chief-agent/pull/310) merged as `fac557b8cfa6922f0b21ac498cd9dab488b34744` (version 0.3.97). The `models` CloudWatch query returns token sums again (its aliases had shadowed the summed fields). Model calls log a fixed finish reason, cache-write tokens, a provider slug and the requested model; `context.selected` logs the older history admitted. New `finishes` and `context` queries.
- **Review.** Independent review (Claude Opus 5.5): approve with nits, then approve on the fixed head. Devin asked for journal 118 in the Context reading path; added before merge.
- **Release.** Live at 09:35 UTC on 23 October, with `release:status` success ([release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39932225778)). No migration.
- **Not yet observed.** No model calls between the release and this record, so the new fields (`finishReason`, `provider: claude-aws`, `historyChars`) are not yet seen on a production line.

[Journal 118](journey/118-telemetry-gaps.md#release-closure--2026-10-23).

## Deployed `9fc5ecc` (untagged) — compaction at about 300k tokens and cached fixed state

- **What merged.** [PR 309](https://github.com/akhilvuputuri/chief-agent/pull/309) merged as `9fc5ecceb519684254a4ede3385787529cccda35` (version 0.3.96). Compaction starts at about 1.08M characters (about 300k tokens), with a 1.3M hard ceiling. The 11k of runtime state that never changes moves into the cached opening system message.
- **Review.** Exact-head independent review (Claude Opus 5.5) approved, after a test that the opening message stays byte-identical and corrections to journal costs.
- **Release.** Live at 10:31 UTC on 21 October, with `release:status` success ([release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39584597049)). No migration.
- **Not yet observed.** No mid-turn history drop or wire compaction on ordinary Opus turns, and later calls reading the cached prefix, on a week of conversations.

[Journal 113](journey/113-bigger-context-and-cached-state.md#release-closure--2026-10-21).

## Deployed `eb03a02` (untagged) — US AQI next to PSI

- **What merged.** [PR 306](https://github.com/akhilvuputuri/chief-agent/pull/306) merged as `eb03a0257c00679faf67e9379f9f328924e6cb7a`.
  - `sg_air` adds each region's US AQI as aqicn.org computes it: EPA's pre-2024 PM2.5 breakpoints applied to NEA's 1-hour PM2.5.
  - On 21 October it tracked aqicn: four regions exact, the West within 1.
  - For haze questions, the weather skill pairs it with PSI in one line. No new data source or key.
- **Review.** Exact-head independent review (Claude Opus 5.5) approved `601b78b`. Its accuracy notes were fixed before merge: "tracks" rather than "matches", and "the US AQI aqicn uses" rather than the official US figure. Devin and hosted CI passed.
- **Release.** Live at 04:59 UTC on 21 October, with `release:status` success. No migration.
- **Not yet observed.** A production haze reply that gives the US AQI.

[Journal 111](journey/111-us-aqi-from-nea.md#release-closure--2026-10-21).

## Deployed `ac94d23` (untagged) — IBKR order drafts

- **What merged.** [PR 298](https://github.com/akhilvuputuri/chief-agent/pull/298) merged as `ac94d2355992b52839a6d1541fd048617be5658d`.
  - Chief can draft IBKR orders (IBKR "AI instructions") that the owner reviews and submits in an IBKR app. It cannot place, change or cancel an order.
  - Rules: US-listed whole shares, at most USD 100 per draft, review-and-approve sessions only, foreground owner requests only.
  - Chief accepts `mcp.read mcp.write` and refuses `mcp.orders.submit`; IBKR's live-order tools are never allowlisted.
  - A separate brokerage agent holds the draft tools and read-only IBKR lookups.
- **Review.** Exact-head independent review (Claude Opus 5.5) requested changes once: the cap did not bound sell limits, plus six lower findings. After the fixes it approved, and it re-approved each docs-only rebase up to `bf1255a`. Devin's findings were also fixed: a duplicate check that failed open, records cleared too broadly, repeat matching that ignored exchange and time in force, and replies without a draft id. Hosted CI passed.
- **Release.** Live in `ac94d23` since 18:44 UTC on 20 October (02:44 SGT, 21 October). The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39476720645) and `release:status` succeeded, and startup logged no errors. No migration or Compose change.
- **Owner action.** Chief's IBKR grant ended. The 02:27 SGT sync on 21 October failed with `not_connected`, likely because of the probe's second consent; an absolute grant lifetime is the alternative. The owner must reconnect, which also grants order drafts.
- **Not yet observed.** A draft created by Chief in production.

[Journal 110](journey/110-ibkr-order-drafts.md#release-closure--2026-10-21), [design](ibkr-portfolio.md#order-drafts).

## Deployed `0c54f89` (untagged) — plain rain replies

- **What merged.** [PR 302](https://github.com/akhilvuputuri/chief-agent/pull/302) merged as `0c54f89b2c35001bd31eeccb6b89be73807bad81`.
  - Merlion's rain answers become one to three everyday sentences, with no speeds, percentages or frame times unless asked, and use the radar only.
  - The picture caption is one line in 12-hour time, with a red dot only for a spot the owner gave.
  - Merlion's brief asks it to keep asked-for readings (bus minutes, PSI, lots) in every reply; this is untested outside rain.
- **Review.** Exact-head independent review (Claude Opus 5.5) approved `a059f77` after one blocking finding: the brief first applied plain wording to every domain without protecting asked-for numbers. Devin and hosted CI passed.
- **Release.** Live at 18:17 UTC on 20 October, with `release:status` success. No migration. This deploy also first shipped #301 (`6ab96c0`), whose own release was refused at 18:02 UTC because `main` had already moved to `0c54f89`.
- **Not yet observed.** A production rain reply under the new wording, and replies in other Merlion domains.

[Journal 109](journey/109-plain-rain-replies.md#release-closure--2026-10-21).

## Release incident — idle SSH drop during the host image build (20 October)

**Symptom.** Three automatic releases in a row failed after main moved past `8673bd5`: for `11c5269` (refused by the main-branch check) and twice for `da5e7a6`, each in "Deploy and verify health" after about 4.5 minutes with `client_loop: send disconnect: Broken pipe` (exit 255). Production stayed healthy on `8673bd5`, and nothing was half-applied.

**Cause, inferred from logs.** The host's release hook (`companion-cloud-release`) runs `docker build` with its output captured, so the SSH session carries no traffic while the image builds. Neither side sends keepalives. The host kernel log shows build containers running from 16:36 to 16:38, and the runner's connection dropped at 16:40:37. GitHub-hosted runners sit behind a NAT that drops idle connections after about 4 minutes, so a build past that length loses its session.

**Fix.** The release workflow's SSH now sends keepalives every 30 seconds (`ServerAliveInterval=30`, `ServerAliveCountMax=20`); [PR 300](https://github.com/akhilvuputuri/chief-agent/pull/300), merged as `8d26783`. **Confirmed:** that commit's release deployed with a 5 minute 21 second deploy step (17:36:38–17:41:59 UTC), longer than the idle limit, and went live healthy at 17:41.

## Deployed `adbba7b` and `8673bd5` (untagged) — Merlion rain radar and radar pictures

- **Rain radar.** [PR 288](https://github.com/akhilvuputuri/chief-agent/pull/288) merged as `d1c66bade2f075badae533e1b86b3d1bc034dc83`.
  - `sg_rain` reads up to 6 hours of NEA radar for a shared Telegram pin, a typed place or a region. It reports rain now, history, movement and a rough outlook. Telegram location messages now reach Chief.
  - Exact-head independent review (Claude Opus 5.5) approved `97d6b53` after several rounds. Fixes included:
    - sub-cell motion, after 8 km/h rain was read as 13 km/h;
    - an exact table of NEA's 33 legend colours;
    - sampling the pin's own radar cell;
    - stale-frame outlooks;
    - forecast-outage lookups.
  - Devin and hosted CI passed.
  - Live in `adbba7b` at 12:56 UTC on 20 October. The first release attempt stopped because `main` had moved.
- **Radar pictures.** [PR 291](https://github.com/akhilvuputuri/chief-agent/pull/291) merged as `9c184b59aec0155095d9b549471f6166ff779fb9`.
  - The radar is drawn on the host as a PNG map or looping GIF over a bundled outline of Singapore's regions, and sent after the reply, including background replies.
  - Review approved `6a454f5`; Devin and hosted CI passed.
  - Its own release attempt hit the job's 15-minute timeout during the deploy step. CloudWatch shows `adbba7b` stayed live, healthy and without a restart until 14:54 UTC, with no `9c184b5` line.
  - Live in `8673bd5` (#292 on top) at 14:54 UTC, with `release:status` success, then heartbeats and no errors.
- **Not yet observed.** An owner `sg_rain` call or picture in production. Acceptance: compare with myENV.

[Journal 105](journey/105-rain-radar.md#release-closure--2026-10-20), [journal 106](journey/106-radar-pictures.md#release-closure--2026-10-20), [design](singapore-open-data.md#rain-radar).

## Deployed `bd2ce04` (untagged) — CodeBuild removed; coding runs only in EC2 boxes

- **What merged.** [PR 287](https://github.com/akhilvuputuri/chief-agent/pull/287) merged as `bd2ce046cc71135468346fa824f59e2520e7488d`.
- **Review.** Exact-head independent review (Claude Opus 5.5) approved it after rounds that found and fixed two problems:
  - every in-flight job would have been refused after an image re-pin; the fix is per-job images from the profile's `previousImages`;
  - unrecorded box launches could block startup or the queue; the fix is an authoritative box lookup.

  Devin's findings were fixed, and hosted CI passed.

- **Release.** Live in `bd2ce04` since 10:46 UTC on 20 October. Healthy, no startup error or warnings, and no CodeBuild code in the deployed build. No migration and no Compose change.
- **AWS teardown, done by the owner.** The CodeBuild project, its worker role and the controller's CodeBuild policy are deleted. Read-only checks confirm they are gone, and the box IAM check still passes.
- **Not yet measured.** A longer real coding job on EC2: the suggested medium task.

[Journal 91](journey/91-boxed-subagents.md#phase-6-codebuild-removed--20-october-2026), [design](boxes.md#phase-6-codebuild-removed).

## Deployed `53a2cdb` (untagged) — cancelling paused coding jobs works again, and coding is proven on EC2

- **Fix.** [PR 283](https://github.com/akhilvuputuri/chief-agent/pull/283) merged as `53a2cdb37f33cd35eb5b99c05258afde45509e6b`.
  - Cancelling a paused job no longer reopens its settled sandbox cleanup. That reopening had made every cancel fail with `ACTIVE_WORK_EXISTS` while another attempt ran, or after the first cancel in a batch.
  - Exact-head independent review (Claude Opus 5.5) approved it, and hosted CI and Devin passed. A regression test reproduces the production error.
  - It went live in `97776fa` (healthy). No migration.
- **Coding on EC2, measured on 20 October.** One owner job ran entirely in EC2 boxes:
  - **Plan:** in its own box.
  - **Implementation:** checks inside the box, every one exiting 0. Review then hit provider 504s.
  - **Automatic retry:** a fresh box; the worker resumed straight into review.
  - **Result:** review passed and Chief published [PR 285](https://github.com/akhilvuputuri/chief-agent/pull/285). Every box was terminated after its attempt.
- **Not yet observed.** Subreaper cleanup on the AL2023 kernel.

[Journal 91](journey/91-boxed-subagents.md#first-real-coding-attempt-on-ec2--20-october-2026).

## Released v0.3.92 (untagged) — Singapore open data: Merlion, data.gov.sg and LTA DataMall

- **Code.** [PR 277](https://github.com/akhilvuputuri/chief-agent/pull/277) merged as `becf234038e128a34fe54974ffdd2d475c84239a`.
  - It adds read-only `sg_` (data.gov.sg) and `lta_` (LTA DataMall) tools and the `singapore` plugin.
  - Exact-head independent review (Claude Opus 5.5) approved `101b283` after four rounds of changes. The blocking finding was open-ended hawker closures reported as open. Devin found five issues, which were fixed.
  - Hosted CI passed. The picker eval passed (98.2% recall, 15 of 15 Singapore picks).
  - The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39317112618) succeeded with startup health at 20:14 UTC on 19 October, without keys.
- **Keys.** [PR 282](https://github.com/akhilvuputuri/chief-agent/pull/282) merged as `7f831582efa4930b6756ad1f7e4c20fe2f1d4676`.
  - It adds the two Compose names and `scripts/deploy-singapore-keys.py`. Review approved `8b90adb`.
  - The keys were added to the private `.env`, and the operator rollout installed the commit (it includes #281). RELEASE, health and the in-container key presence check were verified.
  - The automatic [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39368300270) then succeeded as a no-op.
- **Measured live inside production.**
  - A bus arrival returned live minutes, load and wheelchair access.
  - MRT status was normal.
  - Weather and PSI readings were fresh; West PSI was 128.
- **Merlion.** [PR 284](https://github.com/akhilvuputuri/chief-agent/pull/284) merges the two agents into one, `singapore/merlion`, and bumps the version to 0.3.92. Merlion is live once that PR's release succeeds.
- **Pending.** Owner Telegram acceptance.

[Journal 103](journey/103-singapore-plugin.md), [design](singapore-open-data.md), [catalogue](singapore-open-data-catalogue.md), [DataMall catalogue](lta-datamall-catalogue.md).

## Deployed `7e648f9` and `d6549b9` (untagged) — coding attempts run in EC2 boxes

- **Phase 4a code.** [PR 276](https://github.com/akhilvuputuri/chief-agent/pull/276) merged as `7e648f99d6fa0c6eb2107bb4e98f0678d4f82891`.
  - Exact-head independent review (Claude Opus 5.5) approved `082a1e7` after two rounds of changes: the coding task program's token boundary, and a rollback that could have wedged coding. Devin's three findings were fixed, and hosted CI passed on the final docs-only head `71527b3`.
  - Its [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39305976845) succeeded, and `gateway.started` was logged for `7e648f9` at 18:55 UTC on 19 October with no warn or error lines. Two earlier attempts were refused correctly, because main had moved.
- **Switch.** [PR 279](https://github.com/akhilvuputuri/chief-agent/pull/279) merged as `d6549b94dc56fd434d01e3f986c30a0e7e1fd0a2`.
  - It re-pins the Pi image to `sha256:ba99d955…` (rebuilt from `7e648f9`), adds the `coding` box profile and sets `sandbox: box`. Exact-head review approved it, and hosted CI and Devin passed.
  - It went live inside the [release of `becf234`](https://github.com/akhilvuputuri/chief-agent/actions/runs/39317112618) at 20:13 UTC: healthy, no startup error, and the live `config/coding-backend.json` reads `sandbox: box`.
- **Measured smoke test (20 October, 02:52 UTC, no coding job).**
  - The probe spawned a real `coding` box (`m7i.xlarge`) with the new image. It booted cold to its first report in 84 s.
  - Handed a deliberately invalid task, the task program answered "Invalid coding task". It only gives that answer after `--disable-sigusr1` and the native lockdown have succeeded, so its token boundary works on the box.
  - The box was terminated 12 s after it was closed. No warnings.
- **Not yet measured.** A real coding job on EC2 (the owner-requested canary): the worker's checks and review inside the box, termination after the attempt, and subreaper cleanup on the AL2023 kernel.
- **Still on CodeBuild.** Existing paused and plan-ready jobs keep their older image, so they would run on CodeBuild if resumed.

[Journal 91](journey/91-boxed-subagents.md), [design](boxes.md#phase-4a-coding-attempts-in-boxes).

## Released v0.3.89–v0.3.91 (untagged) — Opus 5.5, a leaner prompt, and replies for any model

Three changes from the two-week review, each with exact-head independent review (Claude Opus 5.5), hosted CI and Devin. These receipts show deployment and startup health only. Live measurements are pending and listed in each journal.

- **[PR 273](https://github.com/akhilvuputuri/chief-agent/pull/273), `f94e699`, 0.3.89.** Claude Opus 5.5 is the main model and the `standard` agent tier. The owner approved $4/M input and $20/M output price ceilings, set in the reviewed model policy. Provider-specific prompt-cache markers are added. [Release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39291865454) `success` at 17:14:44Z on 19 October. [Journal 100](journey/100-opus-main-model-and-caching.md).
- **[PR 274](https://github.com/akhilvuputuri/chief-agent/pull/274), `11c3bad`, 0.3.90.**
  - Coding tools get their own domain, and domain guidance travels only with its tools.
  - Older history keeps a capped 6,000-character floor, and selection never keeps a reply without its question.
  - The over-budget event fires once per turn.
  - The picker eval passed (98.3% recall).

  Its own release attempt failed the current-main guard. It first deployed in `7e648f9` ([release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39305976845) `success` at 18:55:35Z). [Journal 101](journey/101-lean-coordinator-prompt.md).

- **[PR 278](https://github.com/akhilvuputuri/chief-agent/pull/278), `57cfa9a`, 0.3.91.** Sharper reply instructions, plus a host filter that turns Chief's internal names into plain words and shortens long IDs in model-written replies. Code, links, paths and command IDs stay exact. Its own release attempt failed the current-main guard. It first deployed in `becf234` ([release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39317112618) `success` at 20:14:00Z). [Journal 102](journey/102-reply-style-for-any-model.md).

## Deployed `a229d91` (untagged) — box probe for phase 3, and the phase 3 results

[PR 269](https://github.com/akhilvuputuri/chief-agent/pull/269) merged as `a229d91398fb4312c0909c22b0865cd850648684`.

- **Review.** Exact-head independent review (Claude Opus 5.5) approved `a06900d` after three rounds. The first round blocked an orphan check that could not tell the sweep from the instance powering itself off. Devin's two findings were fixed, and hosted CI passed.
- **Release.** The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39287014208) succeeded, and the host ran `a229d91` with `dist/boxes/probe-args.js`. The earlier release attempt for `0aadc97` (PR 268, docs) was correctly refused because main had already moved.
- **What it adds.** An operator probe only: `delegate` flags, `steer` and `orphan`. No gateway behaviour changed.
- **Phase 3 measured on EC2:**
  - privileges;
  - the trust reset, including after a warm start;
  - steering across a gateway restart, with no duplicated task;
  - the orphan sweep, confirmed in CloudTrail;
  - idle stop and warm start (about 24 s);
  - `LaunchTime` changing on every start.
- **Still open.** Retention, which is being watched.

[Journal 91](journey/91-boxed-subagents.md#phase-3-on-ec2--19-october-2026).

## Enabled — boxed sub-agents on in production (configuration only, 19 October)

No new release: production stays on `0e33cfe`.

- The owner applied the `chief-boxes-prod` stack.
- `BOX_AUTH_KEY` was generated on the host and never displayed. It was added to `.env` with `BOX_AWS_ACCOUNT_ID` and `BOXES_RUNTIME=on`.
- The gateway was recreated at 14:35 UTC and became healthy with no warn or error lines.

**Measured:**

- **IAM dry-run check:** no failures for either template.
- **EC2 `echo` proof:**
  - cold boot to first report in 161 s;
  - two tasks in one box;
  - idle stop after about 15.5 minutes;
  - warm start to first report in about 28 s;
  - verified termination with no box instance or volume left.

**Not yet measured:** steering, the trust reset, the orphan sweep and retention on EC2. Only the `echo` profile exists, and coding still runs on CodeBuild. [Journal 91](journey/91-boxed-subagents.md#enabled-and-first-ec2-echo-proof--19-october-2026).

## Released v0.3.88 — monthly subscription summary

[PR 261](https://github.com/akhilvuputuri/chief-agent/pull/261) merged as `293bb0d9e4f7ae77c5d8cdd06751e0535a06d36f`.

- **Review.** Exact-head independent review (Claude Opus 5.5) approved `c3c522f`. Its earlier rounds and Devin's findings were fixed with regressions. They covered a setter change lost during a delivery, the excluded-item list, stale wording, decimal-equal prices, per-item status lines with reactivations, schedule protection and failure visibility. Hosted CI and Devin passed.
- **Release.** The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39239270629) recorded exact deployment and startup health. Logs show `gateway.started` for that release at 10:45:54 UTC on 19 October, with no warn or error lines in the 30 minutes before the check (about one minute after startup). No migration.
- **Behaviour.**
  - `subscription_summary_set` turns on one Telegram message a month (default the 1st at 09:00 Singapore), built from saved records with no model call.
  - It covers monthly equivalents, the previous month's recorded changes (new, ended or back, price changes with the price they replaced) and the next 30 days.
  - `subscription_summary` previews it.
- **Not yet measured.** Owner acceptance.
- No tag created yet. [Journal 98](journey/98-monthly-subscription-summary.md), [design](subscriptions.md#monthly-summary).

## Released v0.3.87 (untagged) — boxed sub-agents installed, off by default (`5f46cb4`)

[PR 265](https://github.com/akhilvuputuri/chief-agent/pull/265) merged as `5f46cb4f417dda258623626d5347f9ff80ff2ced`. Independent review (Claude Opus 5.5) approved the exact head `4f4bf33` after two rounds of fixes. Hosted CI, Devin, 1,087 application tests, 51 script tests, 107 Pi tests and 27 rollout tests passed.

**Operator rollout.** On 19 October `scripts/deploy-boxes.py` ran over the operator SSH connection, with the owner's approval:

- **Pre-checks:** the live `RELEASE` and main at merge time were both the baseline `3feef85`, the gateway was healthy, and the live Caddyfile's catch-all matched the reviewed anchor byte for byte. The archive and script hashes matched on the host.
- **Result:** deployed and healthy, migration 32 installed, Caddy route added.
- **Separate checks:**
  - the `RELEASE` and health checks;
  - marker 32 present, with `boxes` and `box_tasks` empty;
  - the route present in `/etc/caddy/Caddyfile`;
  - publicly, `/boxes/...` returns the gateway's JSON 404 (boxes are off) while other paths keep Caddy's plain 404;
  - `gateway.started` for `5f46cb4`, with no errors.
- **Automatic release:** the [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39214571810) for the same commit then succeeded as a no-op.

Boxes stay off (`BOXES_RUNTIME=off`) until the owner applies `deploy/boxes/boxes.json` and adds the box settings. [Journal 91](journey/91-boxed-subagents.md).

## Released v0.3.86 (untagged) — EC2 box provider, dormant (`3feef85`)

[PR 264](https://github.com/akhilvuputuri/chief-agent/pull/264) merged as `3feef85c63b18bbea9b9c7b56502b224ca0523c9` after exact-head review, CI and the full suite. Its [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39197933021) recorded exact deployment and startup health.

## Released v0.3.85 (untagged) — box agent and local provider, dormant (`af33a68`)

[PR 260](https://github.com/akhilvuputuri/chief-agent/pull/260) merged as `af33a68a326a7474662544c92e07345d8d1a31a7` after exact-head review, CI (including the first Docker-runner test against the real worker image) and the full suite. Its [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39164490351) recorded exact deployment and startup health. The box-layer foundation ([PR 259](https://github.com/akhilvuputuri/chief-agent/pull/259), `860c45e`) deployed in `c1d556b` after [PR 262](https://github.com/akhilvuputuri/chief-agent/pull/262) staged its migration to unblock releases.

## Released v0.3.84 — price-change alerts (in the `c1d556b` deployment)

[PR 258](https://github.com/akhilvuputuri/chief-agent/pull/258) merged as `18662ba1a1746cd843f65da8c723068bfd07cee4`.

- **Review.** Exact-head independent review (Claude Opus 5.5) approved `f8e0f57`. An earlier round blocked on price alerts that could not be turned off while reminders were on; it was fixed with regressions, as were Devin's later findings on pre-change invoices, the effective-day timeline and owner edits. Hosted CI and Devin passed.
- **Release.** Its own release was refused because main had moved to #259, and the next ones were refused for #259's migration. The [release of `c1d556b`](https://github.com/akhilvuputuri/chief-agent/actions/runs/39161166544) deployed it with exact receipt and startup health, and logs show `gateway.started` for that release at 20:02 UTC on 18 October. No migration of its own.
- **Behaviour.**
  - Saved price changes (`pendingAmount`, `pendingCurrency`, `pendingEffectiveDate`) are shown before their date, with a notice 3 days ahead even when reminders are off. From that date they are used in every view, and the next update records them.
  - Each invoice match is compared with its one tracked item. A background pass sends one Telegram alert per item and invoice when the saved price is absent.
  - `priceAlerts` per item.
- **Not yet measured.** Owner acceptance.
- No tag created yet. [Journal 97](journey/97-price-change-alerts.md), [design](subscriptions.md#price-change-alerts).

## Deployed in `c1d556b` (package 0.3.84, untagged) — coding transient retry

The host re-queues a paused coding job once, with a notice in the Coding topic, when the pause came from a stopped sandbox, a lost heartbeat or a provider 429/5xx that the worker did not recover from. A retried revision that pauses again waits for the owner. Jobs with a PR, pending cleanup or a revoked owner are never retried. `autoRetryTransientOnce: false` turns it off and is never sent to workers. This is an owner-approved exception to the no-automatic-resumption rule.

[PR 257](https://github.com/akhilvuputuri/chief-agent/pull/257) merged as `496fd50`. Exact-head independent review approved `44cfeef` in round 6, and hosted CI and Devin passed there. `496fd50`'s own release attempt ([run 39159688807](https://github.com/akhilvuputuri/chief-agent/actions/runs/39159688807)) failed the current-main guard because [PR 262](https://github.com/akhilvuputuri/chief-agent/pull/262) had already merged as `c1d556b`. The earlier `860c45e` release failed the database/Compose guard, which PR 262 cleared by moving the box migration out of `db/`. The change first deployed in `c1d556b` (package 0.3.84), whose [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39161166544) receipt is `success` at 20:02:44Z on 18 October. It is also in `af33a68` (package 0.3.85, [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39164490351) `success` at 20:45:56Z). Neither is tagged. [Journal 96](journey/96-coding-transient-retry.md). Live acceptance (a real transient pause) is pending.

## Deployed after v0.3.83 (untagged) — review-driven reliability fixes

Two fixes from the two-week production review (3–17 October), deployed on package 0.3.83 without a version bump or tag. A third, PR 249, deployed before v0.3.83 and is part of it (below). Each had exact-head independent review (Claude Opus 5.5) and hosted CI. Every Devin finding was fixed; one #251 thread was verified fixed by PR comment rather than resolved in the tool.

- **[PR 251](https://github.com/akhilvuputuri/chief-agent/pull/251), `11d13c6`.** Coding requirements and monitoring cards stay valid for 24 hours. Foreground turns list coding jobs and expired monitoring cards that wait on the owner. [Release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39145803289) receipt: `success`. [Journal 94](journey/94-open-loops-context.md).
- **[PR 252](https://github.com/akhilvuputuri/chief-agent/pull/252), `3b93fa7`.** Briefings lead with their own text and list live open tasks inline. Reminders to review the to-do list become briefings. [Release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39148881889) receipt: `success`. [Journal 95](journey/95-live-todo-reminders.md).

Live behavioural acceptance of both is still pending.

## Deployed `9437d86` before v0.3.83 (package 0.3.82, untagged) — uncertain coding write lock

[PR 249](https://github.com/akhilvuputuri/chief-agent/pull/249):

- coding writes that provably saved nothing settle themselves;
- coding refusals made before any write are validation errors;
- a write refused by the uncertain guard (`WRITE_BLOCKED`) blocks the rest of the turn, including re-delegation to another agent.

Exact-head independent review approved `7d36754` in round 4. Hosted CI and Devin passed. [Release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39134957820) receipt: `success` at 14:17:03Z, before v0.3.83 (`1733d48`), which contains it. Before this release, an operator cleared the 16 October uncertain `coding_reply` lock in production with the owner's approval. See [journal 92](journey/92-uncertain-coding-write-lock.md). Live acceptance (a real coding refusal) is pending.

## Released v0.3.83 — invoices linked to the subscription tracker

[PR 253](https://github.com/akhilvuputuri/chief-agent/pull/253) merged as `1733d48ac0fb0600aab7971dabc8dd13e0caf5a5`.

- **Review.** Exact-head independent review (Claude Opus 5.5) approved `ff135b1` in its sixth round, after three rounds of requested changes. Its earlier blocking findings were invoice identity, plan-name and ordering gaps, and all are fixed with regressions. Devin's five findings were fixed; a sixth, about paging beyond offset 10,000, was declined as unreachable at personal scale.
- **Checks.** Hosted CI passed on `ff135b1`; Devin completed there with one further finding, declined. Locally, 983 application tests passed on the merged branch before the Devin fixes, and 56 focused tests after them.
- **Release.** The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39143260571) recorded exact deployment and startup health. Logs show `gateway.started` for that release at 16:07 UTC on 18 October, with no warn/error lines in the 30 minutes before the check (about two minutes after startup). No migration.
- **Behaviour.**
  - A new `core/bills` agent gathers an exact invoice collection, then updates the subscription tracker from the matched invoices when the owner asks.
  - `subscription_invoices` lists matched invoices.
  - `subscription_record` can cite one invoice: the host checks its amount and invoice date against the PDF's recorded clues and refuses issuer, plan, account and ordering mismatches. Those fields are marked invoice-sourced, and amount changes are reported as price changes.
  - Gathering, subscriptions and bills share the core `invoice-gathering`, `subscription-ledger` and `invoice-ledger` skills.
- **Not yet measured.** Owner acceptance, amount selection by the agent, and behaviour with lazily read skills.
- No tag created yet. [Journal 93](journey/93-invoice-backed-tracker.md), [design](subscriptions.md#invoice-backed-fields).

## Released v0.3.82 — reasoning effort chosen per message by Jev

[PR 246](https://github.com/akhilvuputuri/chief-agent/pull/246) merged as `be3647e85dcac9de6b5d1b303ffef9ed1139b6dd`.

- **Review.** Exact-head independent review (Claude Opus 5.5) approved `c5e5994`. Earlier rounds found two blocking issues, both fixed: the image lacked `config/reasoning-effort.json`, so the gateway would not have started, and escalation after a failed tool call came one call late, or not at all. Devin found that absorbed follow-ups kept stale effort, also fixed.
- **Checks.** Hosted CI and Devin passed. Locally, 962 application and 51 script tests passed.
- **Release.** The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39027476521) recorded exact deployment and startup health. Logs show `gateway.started` for the release and, about three minutes after startup, no `effort.config_failed` or warn/error lines.
- **Behaviour.** Jev now picks `low`, `medium` or `high` for each foreground message. It can raise effort as the turn grows, after a failed tool call or when a follow-up is absorbed. Effort never falls within a turn. Each decision is logged as `effort.decided`. `EFFORT_PICKER=off` in `config/runtime.json` restores fixed `medium`.
- **Not yet measured.** The effort distribution, escalations, latency and quality.
- No tag created yet. [Journal 90](journey/90-jev-reasoning-effort.md), [design](reasoning-effort.md).

## Released v0.3.81 — owner continue for parked coding PRs

[PR 244](https://github.com/akhilvuputuri/chief-agent/pull/244) merged as `9fae41197066d44fcfd9f44a0cdbf50ae0cf42a8`. Exact-head independent review (Claude Opus 5.5) approved `eda7f0d` after one round of fixes; hosted CI and Devin passed; 956 application, 51 script, 61 coding-runtime and 107 Pi tests passed locally. The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39022531557) recorded exact deployment and startup health, and logs show `gateway.started` for that release at 09:51 UTC with no errors in the following minutes. The owner can ask Chief to continue an owner-merge PR parked at manual review or Keep open. [Journal 87](journey/87-pi-owner-merge-feedback.md#owner-continue-for-parked-prs--17-october-2026).

## Released v0.3.80 — automatic rebases for owner-merge jobs

[PR 243](https://github.com/akhilvuputuri/chief-agent/pull/243) merged as `69805d73cf67e1ebc5e9799bd2a94a21c1881844` after exact-head independent review (Claude Opus 5.5), hosted CI and local tests. The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/39011683129) recorded exact deployment and startup health. When main moves before an owner-merge PR is merged, the approved plan is re-implemented on current main and the same PR is rebuilt, with the plan approval carried over. [Journal 87](journey/87-pi-owner-merge-feedback.md#resume-moved-main-and-chiefs-guidance--1617-october-2026).

## Released v0.3.79 — Devin all-clear verdicts ignored, fresh window per feedback round

[PR 241](https://github.com/akhilvuputuri/chief-agent/pull/241) merged as `3b8628dbe974eb2bdf169bcf6dd6926d1d6e1be5`. The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/38775824850) recorded exact deployment; logs show `gateway.started` for that release at 17:19 UTC on 15 October. [Journal 87](journey/87-pi-owner-merge-feedback.md).

## Released v0.3.78 — agent git stage 1 (dormant)

[PR 240](https://github.com/akhilvuputuri/chief-agent/pull/240) merged as `0f05783773e64617c878355f9c5199c9b985361a`. The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/38771303648) recorded exact deployment. Agent-owned commits and PRs stay off until the separate agent GitHub App is configured and a worker built from this code is pinned. [Journal 89](journey/89-agentic-coding-subagent.md).

## Released v0.3.77 — Jev's own routing pick and a separate shadow switch (in the `1ec8c4d` deployment)

[PR 234](https://github.com/akhilvuputuri/chief-agent/pull/234) merged as `fff41bb8cb67aab5cee587740ac7f7f8a980fe88`. Exact-head independent review (Claude Opus 5.5) approved `a81229e` after one round of non-blocking fixes; hosted CI and Devin passed; 935 application and 51 script tests passed locally. Its own release was refused because main had moved; the [release of `1ec8c4d1ffe8b506903c7b4dacfe93cffc6c63a7`](https://github.com/akhilvuputuri/chief-agent/actions/runs/38719275433) deployed it with exact receipt and startup health, and logs show `gateway.started` for that release. Shadow routing records now keep Jev's pick below the threshold and whether it matched Chief; `SHADOW_DECISIONS` in `config/runtime.json` separates shadow mode from `TOOL_PICKER`. Replies, data sent to Jev per message and cost are unchanged; turning `TOOL_PICKER` off no longer stops all Jev traffic, which now also needs `SHADOW_DECISIONS=off`. Accuracy is not yet measured. No tag created yet. [Journal 88](journey/88-shadow-accuracy.md).

## Released v0.3.75 — Pi owner-confirmed merge loop and Coding routing

[PR 233](https://github.com/akhilvuputuri/chief-agent/pull/233) merged as `c44cb6fbd6b1c7df84fb04ca3f744e7259c556e2` after three independent review rounds (approved at `e93073c`), hosted CI and 1,194 local tests. The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/38705870411) recorded exact deployment and startup health; logs show `gateway.started` at 08:32 UTC with no errors. All coding messages now route to the Coding topic. The owner-merge loop shipped disabled until the worker pin. [Journal 87](journey/87-pi-owner-merge-feedback.md).

## Released v0.3.74 — Pi worker 0.1.5 and Gemini 4 Argon reviewer

[PR 231](https://github.com/akhilvuputuri/chief-agent/pull/231) merged as `b75fbc0bff30db2652383148f9a710b48e0aaaf8` with exact-head approval, hosted CI and 1,182 local tests. The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/38677712661) recorded exact deployment and startup health. The first owner job on it completed end to end with an Argon APPROVE and draft [PR 232](https://github.com/akhilvuputuri/chief-agent/pull/232). [Journal 85](journey/85-provider-routing-stability.md).

## Deployed `f9daace` — bulletin Save to Reader and Reader-based learning (package 0.3.73)

[PR 228](https://github.com/akhilvuputuri/chief-agent/pull/228) replaces bulletin 👍/👎 with idempotent Save-to-Reader buttons, caps editions at five and ranks by the owner's Reader saves through a read-only `reader-library` grant. Exact-head independent review (Opus 5.5) approved `c168238` after three rounds, including a Devin-found binding issue fixed by leaving the `reader` connection unchanged; hosted CI passed. [Release](https://github.com/akhilvuputuri/chief-agent/actions/runs/38611905703) verified `f9daace9d7499b752d9a59818017ba0dffd2e063` and startup health; sanitized production logs separately show its heartbeat and no errors for two hours. This release also first deploys main's #229 (`3e52623`, Pi context windows), whose own release run was superseded. Learning needs [PageStash PR 46](https://github.com/akhilvuputuri/PageStash/pull/46) deployed and the owner's opt-in; owner acceptance is pending. No tag created yet. [Journal 86](journey/86-news-reader-saves.md).

## Released v0.3.73 — Pi model context windows (host, in the `f9daace` deployment)

[PR 229](https://github.com/akhilvuputuri/chief-agent/pull/229) merged as `3e526235ada428dd6b6d18e2b6e5b7442f61e071` with exact-head approval, hosted CI and 1,179 local tests. Its own release was superseded by PR #228; the [`f9daace` release](https://github.com/akhilvuputuri/chief-agent/actions/runs/38611905703) deployed it with exact receipt, startup health and later heartbeats. Worker 0.1.5 was published separately and verified anonymously. [Journal 85](journey/85-provider-routing-stability.md).

## Released v0.3.72 — outage-aware provider routing and Gemini 4 Argon

[PR 227](https://github.com/akhilvuputuri/chief-agent/pull/227) merged as `cb2c4fc8452dc6079e17215fc20a47bfdac99ab9` with exact-head approval, hosted CI and 1,175 local tests. The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/38605869702) recorded exact deployment and startup health; logs show the gateway start with no errors. The routing benefit is a hypothesis pending post-release pause measurement, and the effective main model awaits a post-release conversation. [Journal 85](journey/85-provider-routing-stability.md).

## Released v0.3.71 — Pi worker 0.1.4 selection

[PR 225](https://github.com/akhilvuputuri/chief-agent/pull/225) merged as `aad30566ea135ad8c71e5a7a5cdd2fdc7d735faa` with exact-head approval, hosted CI and 1,175 local tests. The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/38507059612) recorded exact deployment and startup health; logs show the gateway start and a five-minute heartbeat. The first owner canary then paused on a provider disconnect, leading to journal 85. [Journal 83](journey/83-pi-context-verification.md).

## Released v0.3.70 — Pi context, review-evidence and provider-recovery host

[PR 222](https://github.com/akhilvuputuri/chief-agent/pull/222) merged as `ee2c3a13e87f12a14eee4d2d0250a368cb558d35`. Exact-head independent review (Claude Opus 5.5 at `30e28f6`, after GPT-6 Astra approvals of the product source), hosted CI and 1,175 local tests passed. The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/38503230794) receipt records exact deployment and startup health; sanitized production logs separately show `gateway.started` and a five-minute heartbeat for that release with no warnings or errors. New Pi jobs continued to use worker 0.1.3 until the separate image pin. Paid status workloads passed once each for three pairings; the remaining matrix was not run by owner decision, so no reliability or recovery-benefit claim is made. [Journal 83](journey/83-pi-context-verification.md).

## Released v0.3.67 — Pi planning worker activation

[PR 217](https://github.com/akhilvuputuri/chief-agent/pull/217) selects independently verified worker 0.1.2/Pi 1.1.0 and snapshot-bound 16,000-token output for fresh Pi jobs. Exact-head GPT-6 Astra approval, Devin/full hosted Linux/extraction checks, artifact and historical-snapshot probes passed. [Release](https://github.com/akhilvuputuri/chief-agent/actions/runs/38079689143) and separate current SHA/health/profile/five-module checks verify `4bcb32b0c69126699369825d22ec2cca1c525c8d`; immutable [v0.3.67](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.67). The 40-minute active profile is installed; the stopped probe verifies the 45-minute sandbox admission receipt, not complete attempt execution. Historical jobs keep saved images/settings and are not resumed. Full semantic owner-task acceptance remains separate. [Journal 81](journey/81-pi-planning-progress.md#verified-release-closure--11-october-2026).

## Released v0.3.66 — Bounded Pi planning foundation

[PR 216](https://github.com/akhilvuputuri/chief-agent/pull/216) bounds planning/reporting, rejects incomplete provider output and preserves trusted local pre-send context recovery. Exact-head review, 1,075 local tests and hosted Linux/extraction/Devin checks passed. [Release](https://github.com/akhilvuputuri/chief-agent/actions/runs/38078480784) and separate current health/module/profile checks verify `00d0c26bd9a1b9a544dfc8b39721ada9f5a3fbdc`; immutable [v0.3.66](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.66). This foundation intentionally retains the older worker; activation is v0.3.67. AWS Support is not a prerequisite and the observed 45-minute restriction remains unexplained.

## Released v0.3.65 — effective sandbox timeout protection

[PR 214](https://github.com/akhilvuputuri/chief-agent/pull/214) validates actual launch/recovered timeout receipts, preserves rejected/cancelled cleanup identities, safely waits for immutable Pi bootstrap and diagnoses timeout phases. Exact independent review/ten lifecycle probes, 1,057 tests/Linux/Devin passed. [Release](https://github.com/akhilvuputuri/chief-agent/actions/runs/38054577579) and separate current health/installed module checks verify `599695cb355236799461b2eb16299609119c7bb4`; immutable [v0.3.65](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.65). AWS's observed 45-minute restriction remains unresolved; application protection does not establish an accepted 125-minute launch. [Journal 80](journey/80-codebuild-timeout-mismatch.md#application-protection-release-closure--10-october-2026).

## Released v0.3.64 — verified model-compatibility worker activation

[PR 212](https://github.com/akhilvuputuri/chief-agent/pull/212) pins independently verified worker 0.1.1/Pi 1.1.0 for future Pi jobs. Exact-head independent review/Devin,1,044 local tests and Linux/extraction gates passed. [Exact release](https://github.com/akhilvuputuri/chief-agent/actions/runs/38043795404) verifies `cfc03dce204b5095856f1323b4ef5385b1a9d2a3`; separate current gateway health/default digest and unchanged models/effort/allocations passed. Immutable [v0.3.64](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.64). Existing jobs keep their image/model snapshots. [Journal 79](journey/79-coding-model-compatibility.md#verified-release-closure--10-october-2026).

## Released v0.3.63 — cross-provider coding role compatibility foundation

[PR211](https://github.com/akhilvuputuri/chief-agent/pull/211) hardens report finalization, review context and typed provider diagnostics. Eight models/seven families and real Chief role commands were exercised with retained negative outcomes. Exact independent review/1,044tests/Linux checks passed. [Release](https://github.com/akhilvuputuri/chief-agent/actions/runs/38042482050) and separate current health verified `949bfbe25dad112ae5f2984e62afb5c46309b87f`; immutable [v0.3.63](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.63). Worker activation is the separately verified v0.3.64 pin.

## Released v0.3.62 — Pi DeepSeek tool continuation

[PR 209](https://github.com/akhilvuputuri/chief-agent/pull/209) fixes the strict facade rejecting Pi’s valid `reasoning_content` compatibility field. Exact independent review, 1,030 local tests and hosted Linux/extraction checks passed. [Release](https://github.com/akhilvuputuri/chief-agent/actions/runs/38026894859) verifies `1c196c168710e776d1a513bb357a323bf851529b` and startup health; separate gateway-start and deployed-module checks confirm the schema correction. A direct real-model synthetic fixture passed learn/plan/approved build/four checks/independent assertions/separate review/cleanup. Existing owner jobs/approvals are unchanged; the original paused job was not resumed. Immutable [v0.3.62](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.62); original task and Chief delivery acceptance remain separate. [Journal 78](journey/78-pi-native-continuation.md#release-closure--10-october-2026).

## Released v0.3.61 — Pi default for new coding tasks

[PR 207](https://github.com/akhilvuputuri/chief-agent/pull/207) passed exact-head independent review, Devin, 1,029 local tests and hosted Linux/extraction checks. [Exact release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37978324102) verifies `76792d9a51ca6069ba6dda18e94ef44dc3394441` and startup health, with separate matching running SHA and healthy gateway/Postgres observations. Immutable [v0.3.61](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.61) identifies the default switch. Existing jobs retain their runtime/image/settings; old Python source/images and owner confirmation remain intact. Pi is draft-only. No paid real-model acceptance or quality/cost claim. [Journal 77](journey/77-pi-runtime.md#default-switch-release-closure--10-october-2026).

## Released v0.3.60 — verified independent Pi worker image pin

[PR 205](https://github.com/akhilvuputuri/chief-agent/pull/205), exact-head independent review, Devin and hosted Linux checks passed. [Release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37927101507) verifies `e793a91f445947d6b6991905144b8876d12787e1` and startup health; a separate private log observed its gateway start. Immutable [v0.3.60](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.60) targets the pin release. Anonymous verification matched 14 compiled source files, SDK 1.1.0, non-root entrypoint and native guard. Default remains legacy; no paid acceptance/default switch or auto-merge permission change. [Journal 77](journey/77-pi-runtime.md).

## Released v0.3.59 — independent Pi coding-runtime foundation

[PR 204](https://github.com/akhilvuputuri/chief-agent/pull/204), exact-head GPT-6 Astra approval, Devin and 1,028-test/Linux checks passed. [Release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37923924614) verified `5fa01cbeb2a8d54315f52c23d5a9ba5c35d98bef` and startup health; a separate private log confirmed the new gateway start. Immutable [v0.3.59](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.59) marks the foundation. The independent TypeScript/Pi package and Chief bridge are installed with default still legacy; Python source/images/jobs remain intact. Image pin, real-model acceptance and default cutover are separate. No quality/cost superiority is claimed. See [journal 77](journey/77-pi-runtime.md).

## Released v0.3.58 — verified coding recovery activation

[PR #201](https://github.com/akhilvuputuri/chief-agent/pull/201) selects the independently verified Python 0.1.9 image for new jobs. Exact-head Astra approval, 1005-test checks and [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37891797838) passed at `caa9ac51d7b1e72793cb77f3bac1bcd1ca4c23f8` (06:11:38Z, 9 October 2026); separate current SHA/health/policy reads and immutable [v0.3.58](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.58) verify activation. Real scoped planning recovered three empty summary responses; explicit feedback produced an independently accepted 309-word brief and complete retained handoff, delivered to Main. Previously paused jobs remain paused; saved jobs retain their pins. No implementation approval or live-record change; no general quality/reliability/cost gain is inferred. [Journal 75](journey/75-coding-summary-repair.md#activation-release-closure--9-october-2026) preserves the failures and limitations.

## Released v0.3.57 — field-local coding-summary repair

[PR #200](https://github.com/akhilvuputuri/chief-agent/pull/200), exact-head Astra review and 1005-test checks passed. Exact `a47e66a2cb9d9df5a24a1d50862d8ed386289c3d` [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37889221371), separate healthy gateway/Postgres reads and immutable [v0.3.57](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.57) verify the compatible foundation. Summary repair narrows field-local corrections while retaining valid evidence; planning guidance asks for final scope/handoff reconciliation. The independently verified Python 0.1.9 image and feedback-conditioned live acceptance precede separate default activation. See [journal 75](journey/75-coding-summary-repair.md); no general quality or cost benefit is claimed.

## Released v0.3.54–56 — coding recovery foundations

[PR #197](https://github.com/akhilvuputuri/chief-agent/pull/197) preserves known empty-response transient classification without admitting malformed wire output; [PR #198](https://github.com/akhilvuputuri/chief-agent/pull/198) adds bounded context-summary correction; [PR #199](https://github.com/akhilvuputuri/chief-agent/pull/199) separates transport recovery from validation repair. Independent exact-head Astra review, full hosted checks and exact release receipts passed. Immutable [v0.3.54](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.54), [v0.3.55](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.55) and [v0.3.56](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.56) target their verified foundation commits. Default image activation remains separate; live planning surfaced additional semantic gaps recorded in [journal 74](journey/74-coding-provider-recovery.md)/[journal 75](journey/75-coding-summary-repair.md). No general success-rate or cost benefit is claimed.

## Released v0.3.53 — concise coding approval and efficiency research

[PR #195](https://github.com/akhilvuputuri/chief-agent/pull/195) pins the independently verified Python 0.1.6 image. Exact-head Astra approval, 996-test PR/main checks/container smoke and [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37810460327) passed at `ad9e7553d897ec93c6708cf51e5598cc8ab0fd3d` (2026-10-08T16:41:35Z). Separate production reads confirmed v0.3.53, healthy services and the effective pin; immutable [v0.3.53](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.53) targets activation. Existing jobs retain their plans/settings. New proposals receive concise complete guidance and specific revision feedback; near-limit scopes can remain multipart. Research comparisons are proposed, not measured benefits. See [journal 72](journey/72-coding-approval-brief.md#release-closure--9-october-2026)/[journal 73](journey/73-coding-model-efficiency.md).

## Released v0.3.52 — coding approval foundation

[PR #194](https://github.com/akhilvuputuri/chief-agent/pull/194) delivers full owner scope once with visible headings and preserved exact confirmation/policy. Astra approval, full checks and [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37808251579) passed at `dbf4c70e5a2b03982f79829d77cf3f5805504f4a` (2026-10-08T16:24:41Z). Separate healthy production reads verified v0.3.52 with the prior worker selector; immutable [v0.3.52](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.52) targets the compatible foundation. Worker activation followed in v0.3.53.

## Released v0.3.51 — coding progress and recovery

[PR #191](https://github.com/akhilvuputuri/chief-agent/pull/191) selects the independently verified Python 0.1.5 image and `harnessVersion: 2` for new jobs. Exact-head review, 992-test PR/main checks and [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37779482330) passed at `2bc5ea36a11014c2515de171f19d5e1f5471bfe4` (2026-10-08T12:50:30Z). Separate gateway/Postgres/configuration reads confirmed the live selector. The immutable [v0.3.51](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.51) tag marks activation. Existing jobs remain paused/pinned; no paid/live trajectory or model-quality improvement is claimed. See [journal 71](journey/71-coding-progress-recovery.md#release-closure--8-october-2026).

## Released v0.3.50 — coding progress foundation

[PR #190](https://github.com/akhilvuputuri/chief-agent/pull/190) shipped compatible host/Python 0.1.5 support, with four independently reproduced review findings corrected. Exact approval of `12aaf0f`, PR/main checks and [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37777192044) passed at `3fa44daff4fddc0c2dbe4aa5722abddad297c4cf` (2026-10-08T12:31:37Z). Separate health verified the prior selector and preserved jobs. The immutable [v0.3.50](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.50) tag marks the compatible foundation; executor activation followed in v0.3.51.

## Released v0.3.49 — coding-sized default allocation

Pins the independently verified Python 0.1.4 image and enables two hours / 400 model calls / 1,000 tool calls for new coding attempts. The compatible foundation adds shared allocation/deadline hints, exact read-only command forms, explicit model/tool exhaustion and conservative host deadline reporting. Existing jobs retain their settings and checkpoints; no automatic resume, model/provider-price, permission, database or Compose change. [Journal 70](journey/70-coding-allocations.md#release-closure--8-october-2026) records exact deployed `b44e1cee723ccfdd624152bbea54e7f23b1134d7`, successful release and separate configuration/health checks; the immutable [v0.3.49](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.49) milestone is published.

## Released v0.3.47 — article link resolution

[PR #185](https://github.com/akhilvuputuri/chief-agent/pull/185) shipped selected-post
publisher resolution, explicit discussion targeting and frozen Reader retry payloads.
Exact-head independent review, PR/main CI, reviewed migration 031/browser installation,
[normal release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37740955551),
receipt and separate health verified `df3c08848c268e23f83c82303ecc31615d096ad4`.
[v0.3.47](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.47) is immutable.
One live owner-verified target returned Reader ready with a duplicate receipt and
same-key replay; anonymous Reddit remained blocked. New blocked links need publisher
URLs or future authorized access; phone offline/conversational acceptance is separate.
See [journal closure](journey/69-link-resolution.md#release-closure--8-october-2026).

## v0.3.46 — coding tool-call continuation

Fixes planning stops caused by provider tool-call `index` metadata in the Python worker’s next model request. Strict validation, exact arguments/reasoning, owner confirmation and allocations are preserved. Fixed host rejection categories become available through owner-scoped status and sanitized logs. No worker-image, schema, Compose, credential or model changes. The original paused job requires explicit owner resume. [PR #183](https://github.com/akhilvuputuri/chief-agent/pull/183) records the approved revision, exact deployment/startup-health receipt and immutable version tag; [journal 68](journey/68-coding-tool-index.md) records reproduction and validation.

## Released v0.3.45 — remote MCP connectors, off

[PR #181](https://github.com/akhilvuputuri/chief-agent/pull/181) ships reusable
remote MCP connections and Reader's save/status grants. The official SDK handles
Streamable HTTP; bounded workers validate discovered input/output schemas;
persisted keys/payloads protect exact retries and owner scoping. Final independent
approval covered `411e3fa`; PR/main CI and the reviewed migration 030/Compose install
passed. [Normal release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37717573236),
receipt and separate server health verified `c1b72c7ce394d8cfb52870d5228568c195a3999d`.
Public discovery and rolled-back deployed smoke passed; data/credentials/paused
work are preserved. [v0.3.45](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.45)
is immutable. MCP stays off pending fresh credential setup; authenticated
Reader/revocation/phone acceptance, OAuth, stdio and paid picker eval are separate.
See [journal closure](journey/67-mcp-connectors.md#release-closure--8-october-2026).

## Released v0.3.44 — explicit Main conversation

[PR #178](https://github.com/akhilvuputuri/chief-agent/pull/178) adds Main beside News/Coding/Markets, normalizes root intake before execution, routes default owner sends there and preserves guarded fallback plus actual destination receipts. Final independent GPT-6 Astra approved exact head `d628ec714be2741fa78e55bf63904452317d2f71` after failure-oriented review loops. Hosted full CI passed 794 application, 50 script, 30 Python evaluation and 32 coding-runtime tests plus isolation checks. [Release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37615771842), receipt and separate server health verified merge `e522f5349af2d7be869bb18bcff2ba0327b06e08`; the bot reported threaded mode and Telegram accepted one Main introduction with zero model calls. [v0.3.44](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.44) is immutable. No migration/Compose/history changes; All stays the aggregate and owner-client acceptance remains separate. [Journal 65](journey/65-main-conversation-topic.md).

## Released v0.3.43 — guarded coding MR automation

[PR #176](https://github.com/akhilvuputuri/chief-agent/pull/176) shipped [v0.3.43](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.43) at `60b3ec55f03f0296ef027b413debab61eef7d2f7`. New coding jobs capture automatic MR feedback repair and guarded ordinary-change merge/release. Planning and owner requirements confirmation remain mandatory; the configured independent reviewer loop is the only model review loop, with fresh review of changed candidates. Exact publication proof, CI/Devin/feedback/current-thread gates, protected paths, idle release and uncertain-write handling remain intact. Legacy/paused jobs keep their settings.

GPT-6 Astra approved exact head `d7f151e`; PR/main Linux CI and Devin passed. Owner-approved repository-only Checks/Actions/Commit statuses read scopes were installed and verified before merge. Existing writes/Metadata read, worker image, models, effort, shared allocations and provider filters remain unchanged. The [exact release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37567573205), separate current SHA/health/effective selector and actual App/diagnostic/model-preference reads passed. Coding and MR automation are on, with zero jobs and no paid/live acceptance. No DB/Compose migration or credential export. See [journal closure](journey/64-coding-automation.md#automatic-selector-release-closure--7-october-2026).

## Released v0.3.42 — coding model choices and scoped diagnostics

[PR #172](https://github.com/akhilvuputuri/chief-agent/pull/172)/[PR #173](https://github.com/akhilvuputuri/chief-agent/pull/173) shipped [v0.3.42](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.42) at `1136126e8a86439aec84b94c27183b1d41d1f4ff`. Telegram can select leader/coder/reviewer models for future jobs within existing provider filters. The pinned Python 0.1.3 worker gives all three members bounded owner-scoped operational diagnostics through Chief, without production credentials or raw private content. Separate roles and one review loop remain intact.

GPT-6 Astra approved exact implementation/pin heads `182fbdc`/`5118f28`; PR/main Linux CI and Devin passed. The [exact release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37524629358), separate server SHA/health/policy and read-only diagnostic/model-preference checks passed. Coding remains on with zero jobs. No DB/Compose migration or paid live acceptance ran. The integrated MR feedback/guarded merge framework remains off pending owner approval of additional App read scopes and a later reviewed selector; this milestone does not claim automatic merge activation. See [contract](coding-automation.md) and [journal closure](journey/64-coding-automation.md#verified-diagnosticmodel-milestone--7-october-2026).

## Released v0.3.41 — owner-defined stock rules

- **What it adds ([PR #168](https://github.com/akhilvuputuri/chief-agent/pull/168), Phase 2b of the [stock rules plan](stock-rules.md)).** The stocks agent turns "tell me when…" requests into structured rules: one watched stock, every IBKR holding on the watchlist, or every watched stock; above or below the previous close, IBKR average cost, 12/26/52-week averages, lows and highs, or all-time levels; an optional margin; intraday or at the close.
- **How rules behave.**
  - Rules are evaluated deterministically inside the watchlist monitor.
  - References exclude today, so "a new low" means below every earlier level.
  - Alerts fire on crossing, re-arm after a 1% recovery, and fire at most once per rule, stock and day.
  - Close rules accept only the session's final quote and are held for the monitoring window.
  - History is shared with `stock_lookup` and loaded from leftover credits.
  - Daily-drop alerts are unchanged.
- **Review.** Claude Opus 5.5 approved final head `7acf775` after three rounds, including two blocking fixes: history starvation with 7 or more stocks, and a delayed pre-close quote being accepted as the close. PR and main CI passed.
- **Deployment.**
  - Additive migration 029 was installed through the reviewed operator rollout at `84149f9c7569ee69525df219f8471817ab55f09c`, from the verified baseline `33c152c`, with matching archive and script hashes.
  - Separate checks of `RELEASE`, health, marker 29, the empty new tables, the preserved watch items and alerts, and IBKR and market data still on all passed.
  - The automatic [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37172042402) then succeeded.
- **Pending.** Owner acceptance of a live rule and alert, and the Phase 2c digest.
- **Version.** v0.3.41 tags this record's verified release, which carries the feature unchanged. See [journal 60](journey/60-stock-rules.md).

## Released v0.3.40 — Coding topic and main-channel updates

[PR #167](https://github.com/akhilvuputuri/chief-agent/pull/167) shipped [v0.3.40](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.40) at `1975525a7b5dd00b76c803d065cf2847298acbfb`: Updates is renamed Coding in place, preserving its thread/messages. Coding milestones go there; unprompted answers/responsibility findings and coding requirements/questions/terminal results go to General. GPT-6 Astra approved exact head `5c0cc77`; PR/main CI, [exact release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37169850070), separate health/policy and unchanged topic-identity checks passed. No DB/Compose/image change or synthetic message send. Live coding remains off with zero jobs; scoped project/App/auth/ingress configuration is absent, and the `chief` AWS identity check did not succeed. Activation and paid/live coding acceptance remain separate. See [journal closure](journey/63-coding-topic.md#release-closure--4-october-2026).

## Released v0.3.39 — durable invoice gathering and private PDFs

[PR #160](https://github.com/akhilvuputuri/chief-agent/pull/160) shipped [v0.3.39](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.39) at `3aeafe316aa04c310c8e2f4a651b94a2989a6509`. Chief coordinates exact provider/account/month/source scopes; the gathering agent collects original PDFs, matches recorded clues and verifies source coverage. Private PDF/ZIP downloads, read-only Gmail attachment retrieval and isolated owner browser handoff are enabled. GPT-6 Astra approved exact head `cd5b0633b0508837eaf8a41dbfe69ef72ffe8177` and the one-time operator artifact. Main checks, reviewed migration **028**/browser/ingress install, [normal release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37156340441) and independent SHA/health/access/preservation checks passed on 4 October SGT. Gathering is on; IBKR remains on and coding off. Actual merchant login/invoice acceptance and paid evals have not run. Invoice collection does not automatically change subscription records; price alerts, monthly summaries, responsibility adapters and broader document/website capabilities remain separate. See [contract](gathering.md), [rollout](gathering-deployment.md) and [journal 62](journey/62-gathering-harness.md).

Validation passed full check/build/format, actual constrained Chromium and disposable PostgreSQL 17 proofs, rolled-back deployed-module collection checks and unchanged counts/content hashes across 17 existing tables. Original files stay encrypted and out of model/history bodies. Owner controls sign-in and ambiguous product/account attestations; complex portals may need owner navigation, and unreadable files keep coverage incomplete. Sidecar updates and DB/Compose/key installation require the reviewed operator path. Rollback retains migration/data/encryption keys. See the journal for dated review and release evidence.

## Released v0.3.38 — fixed Python coding squad

[PR #163](https://github.com/akhilvuputuri/chief-agent/pull/163)/[PR #164](https://github.com/akhilvuputuri/chief-agent/pull/164) shipped the fixed Python leader/coder/reviewer squad as [v0.3.38](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.38) at `c0373741b0a0b289e9a245e309940c323ac4ceee`. GPT-6 Astra approved exact implementation/pin heads `52b2e4c`/`8bc9f618`; PR/main Linux CI, reviewed migration 027/operator install, immutable image verification, [exact release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37143007928) and separate health/policy/preservation checks passed. Chief assigns the leader; coder edits and reviewer independently reviews, with changes returned through the leader until exact approval. Separate contexts, restricted tools, typed durable handoffs and owner confirmation preserve authority; shared allocations/price filters are unchanged. OpenRouter uses DeepSeek V4.1 Flash for leader/coder and GPT-6.1 Sol for reviewer. Coding remains off with zero jobs; scoped provider/App/ingress activation and paid/live acceptance remain pending. See [journal closure](journey/61-coding-squad.md#release-closure--4-october-2026).

## Released v0.3.37 — read-only IBKR holdings and stock lookup

- **Read-only IBKR holdings ([PR #152](https://github.com/akhilvuputuri/chief-agent/pull/152), issue #146).**
  - The owner asks Chief, or sends `/portfolio connect`, to connect; Chief only queues a Telegram card, and the owner's own IBKR login and consent approve it.
  - Host-side OAuth accepts exactly `mcp.read`, stores rotating refresh tokens sealed, and calls only a three-tool read allowlist (IBKR lists write tools even under a read token).
  - Holdings are immutable, reconciled snapshots that a failed, empty-but-contradicted or truncated read cannot replace. They sync every 4 hours, and `portfolio_read` and `/portfolio` show them.
  - Phase 0 measured: read-only consent, rotation, a 12-hour idle refresh and owner-reconciled holdings.
  - Claude Opus 5.5 reviewed seven rounds, approving final head `b4e0ffb`; PR and main CI passed.
  - Additive migration 026 was installed through the reviewed operator rollout at `c3cea89d0a666ba1b64bb9235648358fce27ce7d`, then activated: a host-generated key, `IBKR_PORTFOLIO=on` and the Caddy callback route. The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37135022555), health and separate migration and preservation checks passed.
  - **Pending:** owner Telegram acceptance (connect, holdings, disconnect); whether IBKR accepts the hosted HTTPS redirect; the absolute token lifetime.
- **Stock statistics and lookup ([PR #161](https://github.com/akhilvuputuri/chief-agent/pull/161), Phase 2a of the [stock rules plan](stock-rules.md)).**
  - The stocks agent answers questions now: day change, 12/26/52-week averages, lows and highs, and all-time low and high with their since-date, from split-adjusted Twelve Data history.
  - One credit bucket is shared with the monitor, and lookups never use the daily monitoring reserve.
  - Claude Opus 5.5 approved final head `b80ca55` after three rounds.
  - The [release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37137918493) and health checks verified `7e8198517c141b0e64b93cf1d87f16001b9f2876`. No schema change.
  - **Pending:** owner acceptance of a live question.
- **Version.** v0.3.37 tags this record's own verified release, which carries both features unchanged.
- See journals [59](journey/59-ibkr-portfolio.md) and [60](journey/60-stock-rules.md).

## Released v0.3.36 — confirm requirements before Python implementation, off

[PR #157](https://github.com/akhilvuputuri/chief-agent/pull/157)/[PR #158](https://github.com/akhilvuputuri/chief-agent/pull/158) implement conversational coding without slash commands: plan first, show the complete brief, accept the owner’s bound button/direct yes reply, then queue Python. Models cannot confirm requirements; scope changes replan, decisions are revision-fenced and unchanged explicit resume retains approval. Python 0.1.1 preserves approved plans. Astra approved exact heads `aafecf3`/`140c97d`; full PR/main Linux checks and independent 47 controller/Telegram and 20 Python tests passed. The [exact release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37120011881), separate health/policy/preservation checks and immutable [v0.3.36](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.36) verify `67db5e135c99eee85a10416dbe159ce93432eee0`. No DB/Compose or allocation changes. Coding stays off with zero jobs; scoped activation/provisioning login and paid/live acceptance remain pending. See [journal closure](journey/58-coding-requirements.md#release-closure--3-october-2026).

## Released v0.3.35 — Python coding execution, off

[PR #154](https://github.com/akhilvuputuri/chief-agent/pull/154)/[PR #155](https://github.com/akhilvuputuri/chief-agent/pull/155) move disposable execution into an independently packageable Python runtime and pin its public image with the matching launcher. Chief remains TypeScript; OpenRouter uses DeepSeek V4.1 Flash for coding and the existing reviewer, price ceilings and allocations. GPT-6 Astra approved exact heads `e0b0b63`/`8b2dac7`; full PR/main CI passed 672 application, 22 JS script, 30 existing Python and 19 coding-runtime tests plus Linux isolation/descendant cleanup smoke. The [exact release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37099789621), separate health/deployed-policy/preservation checks and immutable [v0.3.35](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.35) verify `448597a475827c3eb88df5ae3f3697f04a125563`. No DB/Compose changes, automatic resumption or paid coding acceptance. Coding remains off with zero jobs; scoped provider/App/ingress activation is pending. See [journal closure](journey/57-python-coding-runtime.md#release-closure--3-october-2026).

## Released v0.3.34 — manual bills and subscriptions

[PR #142](https://github.com/akhilvuputuri/chief-agent/pull/142) adds explicit owner capture, a maintained read-only Mini App tracker, per-currency fixed monthly equivalents and opt-in renewal/trial/cancellation-deadline reminders. GPT-6 Astra approved exact integrated head `142486080c9094bbab151636d48e767dfc7e7d99`; its tree matches merged `b79fd27f8cdf5ecadb05622217ab61666a63f70b`, the immutable [v0.3.34](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.34) target. Full checks passed 670 application, 22 JavaScript and 30 Python tests, build/format and 14 offline rollout tests. The reviewer independently passed 101 focused and 18 adversarial checks. Reviewed additive migration 025/operator installation, [normal release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37030523500) and separate server health/preservation verification passed. A transaction-rolled-back deployed-module smoke checked ownership, retries, linked-date edits, cancellation and capacity with zero messages/model calls or retained fixtures.

Owner Telegram/reminder delivery acceptance remains separate. Email/browser/document intake, price alerts, monthly summaries and automatic responsibility monitoring are later milestones; issue 132 stays open. Rollback retains additive data and pauses pending linked reminders before an older app runs. Responsibilities and the default-off coding foundation are preserved. See [contract](subscriptions.md) and [journal closure](journey/54-subscriptions.md#release-closure--3-october-2026).

## Released v0.3.33 — coding-runtime foundation, installed off

[PR #150](https://github.com/akhilvuputuri/chief-agent/pull/150) adds durable Chief dispatch, an owned TypeScript/Node 22 worker in on-demand CodeBuild containers, private checkpoints, verification/review, draft PRs and Telegram updates. GPT-6 Astra approved `f05c4b20875e844417b672adb7d038a101ba4a4b`; PR/main CI passed 646 application, 22 JS and 30 Python tests plus Linux process-boundary smoke. Reviewed migration 024/Compose installation and [normal release](https://github.com/akhilvuputuri/chief-agent/actions/runs/37022132112), plus separate health/preservation checks, verified `1ee7c4bb4f6ef99ab79d9e648455e00ff4fc66ff`, the immutable [v0.3.33](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.33) target. Coding is **off**, with zero live jobs. The public worker image is published/pullable. Scoped provider/App/ingress activation and paid/live acceptance remain pending. No runtime merge/self-deployment or data reset is introduced. See [setup](coding.md) and [journal closure](journey/56-coding-runtime.md).

## Released v0.3.32 — owner-confirmed responsibilities

[PR #148](https://github.com/akhilvuputuri/chief-agent/pull/148) adds fixed sources/subjects, deterministic checks, bounded isolated investigations, explainable attention, feedback/history and lifecycle completion. Gmail remains read-only and narrowly query-scoped. GPT-6 Astra approved exact head `943d71e0c6a1b1caf328f3716488f77a9da034ac`; its tree matches merged `9f5031ccb3a45e54cdde7f3f41accaa498faceff`. Full checks passed (609 application, 21 JS, 30 offline Python tests), build/format and 17 rollout tests. Reviewed additive migration 023, [normal release](https://github.com/akhilvuputuri/chief-agent/actions/runs/36916132818), separate health/preservation verification and independently reviewed idle-only activation passed. [v0.3.32](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.32) immutably targets that verified SHA. No responsibility was created during rollout; Telegram confirmation starts monitoring. Source default remains off. Rollback retains additive data and requires disabling the capability; paused/uncertain work is never replayed automatically. Live Telegram/provider acceptance and one-week usefulness/cost measurements remain pending; no paid smoke/eval was run. See [journal 54](journey/54-responsibilities.md#release-closure).

## Released v0.3.31 — Libby refusal recovery

[PR #145](https://github.com/akhilvuputuri/chief-agent/pull/145) stops repeat linking after explicit provider refusals, safely settles matched historical failures and corrects borrowing guidance. GPT-6 Astra approved `86c7fea975a50d7cd368a4d2e1818029080d22d2`; full checks passed (569 application, 21 JS, 30 Python tests). [Release](https://github.com/akhilvuputuri/chief-agent/actions/runs/36893817001) and separate server health verified `3382c5d63a6551ea960615332d0fc0cd3643e672`, the immutable [v0.3.31](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.31) target. Both account commands passed live Telegram acceptance with zero extra library calls. No schema/Compose change. Catalogue checks work; account linking remains refused and borrowing unimplemented. See [journal closure](journey/22-library-assistant.md#release-closure--2-october-2026).

## Released v0.3.30 — exact Telegram feed references

[PR #139](https://github.com/akhilvuputuri/chief-agent/pull/139) adds sent feed identities, bounded General discovery, owner-scoped stored reads, frozen per-input anchors and shared thread-aware continuity. GPT-6 Astra independently approved exact head `cdab8b518bd08ceb00b95365d86c54d61209133e` after reproduced absorption/history/thread defects were fixed. Full checks passed (563 application, 21 JS script, 30 Python tests); the final reviewer passed 79 focused tests. [Release](https://github.com/akhilvuputuri/chief-agent/actions/runs/36875352644) and separate server RELEASE/health verified merge `7cdbda24d7e7145f9482eb47819ec822722dc649`. A rolled-back deployed-module smoke passed without fixtures, Telegram sends or model calls. [v0.3.30](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.30) is immutable. No new schema beyond migration 022; owner live acceptance remains separate. See [journal 53](journey/53-feed-destinations.md).

## Released v0.3.29 — General input and durable destinations

[PR #138](https://github.com/akhilvuputuri/chief-agent/pull/138) adds host-owned destinations, task origins, thread-aware FIFO/fences, scoped approval cards, slow pointers and durable ordinary-work delivery. The final independent GPT-6 Astra review approved head `2724d31cc44b893981ebb8754a48e39739ac18dd` with 62 focused tests after repeated failure-case fixes. The reviewed operator rollout installed additive migration 022 at merge `015b8a99d770977ada6035c3feed4b9bbdd7226d`; separate preserved-record/health checks and [normal release](https://github.com/akhilvuputuri/chief-agent/actions/runs/36872648089) passed. [v0.3.29](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.29) labels that merge. Email was renamed Updates without deleting messages; feed-reference resolution follows in v0.3.30.

## Deployed after v0.3.28 (untagged)

- `03a1ef4`, [PR #135](https://github.com/akhilvuputuri/chief-agent/pull/135): Telegram topics, phase 1. The news bulletin and stock alerts go to their own topics, and a message typed in a topic is answered there. App-only, with no migration. Release run 36857469977 succeeded, and the gateway logged that commit from 11:48 UTC on 1 October 2026. See [journal 52](journey/52-telegram-topics.md).
- `d434bc7`, [PR #134](https://github.com/akhilvuputuri/chief-agent/pull/134): shadow decisions. Jev's would-be continuity and routing decisions are recorded next to what Chief did, without changing replies. App-only. Host health reported that commit as healthy from 10:49 UTC on 1 October 2026. See [journal 51](journey/51-shadow-decisions.md).
- `5222e33`, [PR #129](https://github.com/akhilvuputuri/chief-agent/pull/129): Chief becomes a coordinator. One generic `agent_run` tool replaces the delegate tools, typed domain agents come from the bundled `core` plugin, and subagents default to Gemini 3.8 Flash. App-only. The release verified the exact commit with startup health on 1 October 2026. See [journal 49](journey/49-coordinator-agents.md) and [coordinator and agents](agents.md).
- `ebd3d0b`, [PR #126](https://github.com/akhilvuputuri/chief-agent/pull/126): the main model is GPT-6.1 Sol. The release verified the exact commit with startup health.
- `1c0e480`, [PR #122](https://github.com/akhilvuputuri/chief-agent/pull/122): bounded context within one long task (issue #77). App-only. The automatic release verified the exact commit with startup health on 30 September 2026. See [journal 48](journey/48-bounded-turn.md).

## Released v0.3.28 — stock monitoring hours and daily news bulletin

[v0.3.28](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.28) points to `8f7f7f791377eaf39138def8418cad3b97d3338b`. It includes:

- [PR #108](https://github.com/akhilvuputuri/chief-agent/pull/108): monitoring windows in Singapore time, migration 020, installed through the reviewed operator rollout at `069c8d5`.
- [PR #109](https://github.com/akhilvuputuri/chief-agent/pull/109): a daily news bulletin from followed sites with 👍/👎 learning, migration 021, installed through the reviewed operator rollout at `8f7f7f7`.
- #107 and #110–#113, which were released earlier the same day.

Opus 5.5 independently approved the exact merged heads of #108 and #109; the review records are on those PRs. The other included PRs were reviewed in their own sessions (see their PRs). `npm run check` passed 496 application and 21 script tests. The automatic release then verified the exact commit with startup health. Separate read-only checks confirmed both migrations, the preserved watchlist, and live feed discovery from the gateway.

Limits: owner Telegram acceptance is pending for both features. No monitoring window or news site is configured yet. See journals [39](journey/39-watch-monitoring-window.md) and [42](journey/42-news-bulletin.md).

## Released v0.3.27 — Lightsail production host and private logs

Production moved to one AWS Lightsail VM in Singapore with the same Compose app and Postgres. Changes:

- [PR #94](https://github.com/akhilvuputuri/chief-agent/pull/94): sanitized `chief.ops/1` operational log lines.
- [PR #96](https://github.com/akhilvuputuri/chief-agent/pull/96): host procedure, CloudWatch publisher and reader identities, the `npm run logs:cloudwatch` reader, a release handler that passes `RELEASE_SHA` and prunes images, and the `CHIEF_DEPLOY_HOST` release target.
- [PR #98](https://github.com/akhilvuputuri/chief-agent/pull/98): reboot-safe log exporter.
- This documentation release: corrected `errors` query and post-cutover docs.

Each PR's merged head was independently approved by Opus 5.5. Cutover evidence: identical row counts and per-table content hashes after restore; the normal release deployed `ebcc9dc` and later `5988e52` to Lightsail with exact-SHA receipts; reboot recovery was verified. [v0.3.27](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.27) points to `9c7b67cfa19eec1e9d774b93986a922c41221eb5`, the merge of [PR #99](https://github.com/akhilvuputuri/chief-agent/pull/99). The normal release workflow deployed that exact commit to Lightsail with startup health and an exact-commit receipt, and the server `RELEASE` matched. Limits:

- Owner Telegram acceptance is pending.
- The Sheets `invalid_grant` defect predates the move.
- Log delivery is at least once.

See [journal 35](journey/35-lightsail-private-logs.md).

## Released v0.3.26 — Nasdaq stock listing segments

[v0.3.26](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.26) labels deployed merge `f3ab7f10bea05e436424712a03a757f8744d9c02`. [PR #95](https://github.com/akhilvuputuri/chief-agent/pull/95) accepts three US Nasdaq listing-segment MICs while retaining exact provider identity. Independent GPT-6 Astra approved exact head `1b62f05fa42b4ae787a49eef8e194dda4f80daed`; 407 application tests and 10 script tests, formatting and CI passed. The [automatic release](https://github.com/akhilvuputuri/chief-agent/actions/runs/36234286230), exact-commit receipt and separate server health inspection passed. Live provider lookup/quote and a deployed validated-dispatcher add/list check passed with transaction rollback and owner isolation; no test watch remained and no alert was sent. Actual Telegram and threshold-triggered delivery remain separate acceptance checks. No database or Compose change. See [stock journal](journey/25-stock-watchlist.md).

## Released v0.3.25 — stock inspection and guarded recovery

[v0.3.25](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.25) labels deployed merge `d96cdb70dff85343efb57baac8988462f8120601`. [PR #93](https://github.com/akhilvuputuri/chief-agent/pull/93) classifies watchlist inspection as a read while preserving the uncertain-write guard. Independent GPT-6 Astra approved exact head `7665709f32e98d0de1592e9d9070358a39637ff9`; 405 application tests and 10 script tests, formatting and CI passed. The [automatic release](https://github.com/akhilvuputuri/chief-agent/actions/runs/36233697974) and separate server health inspection passed. A separately reviewed exact-call reconciliation resolved one old local Calendar draft uncertainty after a rollback dry run; it preserved the original error/timestamp and appended evidence without replaying an action. Provider acceptance then exposed a separate Nasdaq segment defect, addressed by v0.3.26. No database or Compose change.

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

Follow the a-stack `ship` skill: verify the exact deployed SHA and its successful release run, write notes, then `gh release create vX.Y.Z --target <SHA> --notes-file <notes>`. Never target the moving default-branch head while another task may be merging. A GitHub Release records a shipped milestone, not proof that production still runs that version.

In Chief, release publishing is a documented manual agent or operator step. There is no automatic tag or notes workflow. Future automation should run only after a successful deployment, with narrow contents-write permission, and keep deploy credentials separate from publication permissions.

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
