# Companion Agent development

Read `HANDOVER.md`, `docs/cloud-development.md`, and the relevant source before modifying behavior. Historical incident reports and deferred candidates describe earlier states; current code and verified production diagnostics take precedence.

## Commands

Node 22. `npm ci`, `npm run check`, `npm run build`, `npm run format:check`. Tests use PGlite and mocked integrations; production credentials are unnecessary. Use Prettier on changed files. `npm run smoke:runtime` is paid and must not be run as a routine test. Paid evals remain deferred.

## Architecture

`src/telegram.ts` is the client; `agent.ts` manages conversations; `custom-agent.ts` runs the loop; `model.ts` calls OpenRouter. `context.ts`, `record-context.ts`, `execution.ts`, and `work.ts` handle context and durable work. Tools run through owner-scoped `tools.ts` and Zod `protocol.ts`. Read the domain module before changing a tool. No production Hermes dependency.

## Product and safety constraints

- General personal assistant; job preparation is one domain.
- Preserve exact user-selected target records throughout research. Do not invent postings, user experience, evidence or completion claims.
- Telegram phone delivery context guides model-written prose. Do not impose fixed templates or replace answers with ledger summaries.
- Gmail remains read-only. Calendar queries and button-approved creation of primary-calendar timed events are supported; preserve the explicit Telegram confirmation boundary. Do not add email sending, invitations or applications.
- Preserve owner scoping, tool validation, approvals, private skill versioning, cancellation and uncertain-write handling.
- Do not add dollar caps. Keep existing model/provider price filters and time/model/tool allocations unless asked to change them.
- No data reset, automatic resumption of paused tasks, paid infrastructure, runtime shell access, self-deployment, subagents or deferred eval migration without a specific request.
- No secrets in source, examples, logs, artifacts or PRs. Production .env remains on DigitalOcean.

## Cloud work and release

Cloud/local capability parity is a standing owner priority. Cloud tasks should progressively gain the ability to inspect useful private traces, reproduce incidents, implement and evaluate fixes, and ship verified releases without the Mac. Treat current access gaps as engineering work to close where practical, not permanent product restrictions. Prefer shared tooling usable from both environments, scoped authenticated access and explicit release controls; do not copy unrestricted production credentials into cloud tasks. When proposing work, identify relevant remaining gaps and opportunities to close them.

The user permits merging passing ordinary changes and deploying them. Keep changes reviewable in a PR, wait for checks, and merge when the requested task is complete. Never merge the deferred `feature/runtime-evaluations` branch incidentally. If GitHub mutation credentials are unavailable, open the PR through the cloud task UI and clearly report that it needs merging.

A push/merge to `main` triggers `checks`, then `release`. A pushed feature branch is NOT live. Watch the release result and report deployed SHA, health, tests and limitations. Production releases refuse active runtime work and database/Compose changes. Follow `docs/cloud-development.md` for these cases; never bypass the restriction or claim deployment succeeded from CI alone.

Run `npm run doctor:cloud` early when a task needs GitHub or production access; report missing capabilities rather than discovering them only after implementation.

For runtime failures, use the manual `production-diagnostics` GitHub workflow if your GitHub access permits it. This returns bounded metadata rather than raw conversations. Never invent production findings when access is unavailable. Local browser sessions and SSH credentials are not inherited by cloud tasks.
