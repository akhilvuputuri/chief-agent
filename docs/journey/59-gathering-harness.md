# 59 — Gathering files without losing scope or coverage

Work date: 3 October 2026. Status: implementation candidate; not deployed.

## Preceding iteration and problem

The [manual bill tracker](54-subscriptions.md) keeps explicit statements, dates and reminders consistent. It does not retrieve original invoices, verify source coverage or support browser login. The [coordinator split](49-coordinator-agents.md) and [durable execution](../reliable-execution.md) already supply bounded domain agents and explicit continuation. The [Python coding foundation](57-python-coding-runtime.md) is separately installed off; it is not an invoice browser or a reason to copy production credentials into a sandbox.

## Current implementation

Fresh fetched main was `591ee4af071f9128b2c56ab82feda386d2a6f77e`. Work uses the existing clean managed worktree on `codex/gathering-harness`, preserving the unrelated dirty primary checkout. The [gathering contract](../gathering.md) describes the first invoice workflow: exact provider/account/month/source choices, an encrypted original-PDF vault, bounded source attempts, source-specific coverage, and isolated browser login takeover. Chief coordinates; the gathering agent does source selection and collection. This is foundation work for issues 132, 48 and 47, not completion of every feature in those issues.

Original PDF bytes stay encrypted and out of model/history payloads. Typed issuer/date/period clues drive candidate matching. Matched files and checked source coverage are distinct. Email coverage requires inspecting scoped pagination and PDF parts in each selected mailbox. Browser coverage requires the owner's invoice-history count; missing or unverified targets remain explicit. Scope revisions retain files/receipts and invalidate prior proofs and sessions. Existing budgets, price filters, approval gates and paused-task rules remain.

## Synthetic findings and verification

Eight initial PGlite tests pass: privacy of extracted clues, encrypted owner-bound storage and byte deduplication, separate capture/match/coverage/finalization, task isolation, refusal of invented dates, preserved files on scope revision, service-month matching without inventing an issue day, ZIP CRC/current-scope export and denied network/address/action classes. Initial fixtures omitted existing migrations; they now apply the complete stack. SQL parameter typing and a real idempotency defect were then fixed: a statement cannot update a row inserted by a sibling CTE, so reservation, domain writes and response persistence now use a true transaction with a second statement. These are synthetic findings, not production incidents.

The current TypeScript modules and initial integration compile. Dependency audit initially identified the existing Fastify URI-parser advisory; the compatible lockfile update now reports zero known vulnerabilities. Real Linux browser/sandbox verification is pending because the local Docker daemon is unavailable. Use the existing Linux CI path rather than starting an unknown local container fleet or using production credentials.

## Remaining work and limitations

Finish frontend/control and Telegram integration, real browser sandbox/egress checks, source/ownership/restart/race regressions, full check/build/format and exact-head independent GPT-6 Astra review. Add reviewed migration 026/Compose/key install and rollback; ordinary releases must keep refusing these prerequisites. No operator activation, actual merchant account login, production invoice collection, paid model smoke/eval, extra paid infrastructure or coding activation has occurred. Document deployed SHA/health, preservation, release receipt and version only after verification. Invoice gathering does not automatically change subscription records. Document generation, broader website writes, price-change alerts, monthly summaries and responsibility integration remain separate.
