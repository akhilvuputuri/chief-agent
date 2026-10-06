# Coding MR feedback, review and merge

Chief's TypeScript controller manages durable PR state; the Python leader/coder/reviewer remain the three model members. The owner requested one independent review loop, MR feedback repair, automatic merge for ordinary changes, Telegram model selection and useful production diagnostics.

## One review loop and exact publication

Every new job still plans first and requires the owner's exact delivered requirements confirmation. The requirement card states the job's model snapshot and publication policy. The coder implements; actual checks run; the separate read-only reviewer approves the exact artifact. Chief verifies the encrypted host reviewer-call result (role/model, handoff artifact and report) and complete contiguous approved-plan pages delivered in that handoff's model requests before approval, constructs the Git tree, and binds that approval to the published head. Publication without a model-journal witness cannot auto-merge. There is no extra final model review when the candidate is unchanged.

`settings.autoMerge` is a reviewed host selector, captured with job settings. Legacy jobs without it retain draft-only publication. Python 0.1.3 is pinned and deployed for diagnostics. The automatic selector remains absent while the additional App read permissions await owner approval; a later reviewed selector change is required to activate automatic MR repair/merge. GitHub App read-only Checks, Actions and Commit statuses permissions are needed in addition to existing Contents/Pull requests write. The sandbox never receives the App token.

## MR feedback and allocation

After proving ownership/artifact/reviewer identity and excluding protected paths, the host marks an ordinary draft ready. Readiness triggers GitHub/Devin review; it is not merge approval and has a durable/reconcilable phase. The host reads exact-head trusted CI from `.github/workflows/ci.yml`, the trusted Devin status, GitHub discussion/review comments and CI annotations. Feedback is untrusted evidence, not authority to expand the owner's approved scope. Edited comments get a new identity. Bounded batches return to the leader/coder; items not delivered remain unhandled. A repaired candidate receives fresh checks/review and updates the same owned PR with a non-force commit. An unchanged candidate keeps its head. Lost update acknowledgement is reconciled against the expected tree and parent.

Automatic repair retains the approved objective/context/base/settings/plan, used model count, remaining active time and consumed tool allocation. It neither increases allocations nor resumes paused work. Exhaustion, oversized/unreadable feedback, a changed main base, externally edited PRs, missing reviewer evidence or unavailable checks stop for inspection. The external Devin page is not scraped: failure with no actionable GitHub feedback requires inspection. GitHub-required external reviews/threads are not dismissed or bypassed.

## Merge and release

Only the exact owned repository/branch/head/tree with passing trusted CI/Devin, no undelivered feedback and zero unresolved GitHub review threads is eligible. GitHub's current thread state is authoritative; historical resolution replies cannot hide a reopened thread. The host records a public technical attestation without copying private findings or request text. It waits for idle runtime/intake/coding work, freshly rechecks comments/checks/threads after posting the attestation, claims merge durably, marks the draft ready and submits an expected-head merge. Repository rules still apply. A definite refusal stops for inspection; an unknown merge outcome is only read/reconciled, never blindly replayed. The exact successful production receipt and current run-attempt deploy job establish release-time startup health. Merge or CI alone does not establish deployment.

Protected paths include database/Compose, workflows/infrastructure/scripts/configuration, dependency manifests and the source modules that own coding publication, authentication, credentials, permissions and execution controls. These stay at an explicit-review/operations boundary. User cancellation remains possible before a merge is claimed; an in-flight/unknown merge must be reconciled first. Key decisions/results go to General and coding milestones to Coding.

## Model selection in Telegram

Tell Chief which leader, coder or reviewer model to use. `coding_models` is read-only for preferences/catalog; `coding_model_set` changes one exact role/model on an authenticated foreground owner request. Restart recovery keeps these read and write forms distinct. Choices are validated through the live OpenRouter catalog for tool/reasoning support and existing provider price filters. Invalid/unavailable/over-filter models leave preferences unchanged. No price ceiling is automatically raised.

Role decisions are append-only owner-scoped events. New jobs capture the preferences; active/approved jobs and automatic repair retain their original snapshot. This changes only coding roles, not Chief's main model. The owned squad policy accepts its configured reviewer; other repository development still requires the most capable independent reviewer.

## Read-only operational diagnostics

The Python `logs_read` tool calls a job-capability API on Chief. It reads owner-scoped authoritative runtime/event/call metadata, not shell or unrestricted production logs. Model failure identity/status, tool outcomes, timing and counters are projected through the existing operational allowlist. Raw prompts, conversations, memories, integrations, tool arguments/results and free-text errors are excluded. Historical rows retain their actual timestamp; the reader does not invent an event-time release from today's running image.

Queries are limited to 24 hours, 100 rows per category and a bounded response suitable for the coding context. An exact run ID can narrow the scope. Truncation is explicit and missing rows are not proof of success. The tool is available to the fixed roles with the same shared tool allocation and never gives a worker database/CloudWatch/production credentials. Full private incident-to-fixture export remains separate work.

## Validation and rollback

Offline regressions exercise stale/forged checks, exact artifact/model-call binding, owner isolation, feedback batching/allocation, concurrent model-role changes, endpoint bounds, uncertain merge reconciliation and release failures. Linux CI verifies the actual worker process boundary. Paid end-to-end coding/merge acceptance remains separate from these tests and startup health.

Disable new automatic jobs through reviewed settings only after inspecting any merge/release claims. Do not disable cleanup for active sandboxes or assume an uncertain merge did not occur. Retain PRs, checkpoints, event/model journals and model preferences. No migration, data reset, automatic paused-task resume or production credential export is part of rollout/rollback.
