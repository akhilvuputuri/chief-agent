# Runtime evaluation checkpoint — 7 September 2026

## Decision

The user asked to checkpoint and defer because the evaluation work had expanded too far. Stop paid trials and implementation at this point. Do not deploy this candidate or automatically resume the 22-role task. The production assistant is unchanged by this branch.

## What is saved

Branch: `feature/runtime-evaluations` in `akhilvuputuri/companion-agent`.

- Isolated synthetic eval runner, deterministic grader, comparison command and baseline report.
- Compact tool observations with retrieval pointers and per-call refreshed task context.
- Candidate additive migration 007, scope binding, per-target findings, owner checks and final declared-target coverage checks.
- Candidate validation/repair handling and bounded retries for empty model responses.
- Architecture, experiment notes and eval learning guide under `docs/`.

Earlier commits: `b23d527` (eval foundation), `8a088e9` (compact observations). This checkpoint commit contains the remaining candidate work. No production migration, history quarantine or rollout has been performed.

## Verification and evidence

Latest completed local checks: type checking plus 74 application tests and 2 OAuth-script tests passed (76 total). The added end-to-end regression checks that scope appears in fresh model context, invalid finding input is repairable, a supported finding persists, and completion uses the declared target ID. These deterministic tests do not establish real-model task quality.

The original controlled-model baseline failed the collection case and passed the two smaller cases. Compact observations alone still exhausted the collection tool budget. The first scope trial exposed misclassified validation failures. Those were corrected, but subsequent trials encountered empty provider responses. The eval wrapper initially hid the diagnostic and prevented normal retries; it now preserves ModelError. A direct replay returned valid tools. The adapter now permits bounded retries for empty responses, with tests.

The final candidate live run was interrupted at the user's request. It has no completed suite report and must not be reported as passing or failing. No further model spending is scheduled. Completed sanitized baseline results are in `docs/evals/baseline.json`; full synthetic traces remain local in ignored `eval-results/`.

## Local trace locations

Within `eval-results/`:

- `2026-09-07T13-21-32-259Z`: finalized baseline.
- `2026-09-07T13-39-21-167Z`: compact-observation trial.
- `2026-09-07T14-51-54-955Z`: first durable-scope trial; validation classification failure.
- `2026-09-07T14-59-56-900Z`: provider-error trial with insufficient error diagnostics.
- `2026-09-07T15-02-58-926Z`: diagnostic missing-evidence trial; empty response.

Raw history-retention probe still fails by construction. The candidate protects scope through refreshed durable context rather than changing raw recency selection. Do not equate that old probe with the whole candidate runtime.

## Resume narrowly

1. Read the diff and `docs/runtime-hardening.md`, especially its limitations. Do not restart infrastructure setup or add another eval framework.
2. Review unresolved correctness issues before shipping: model-selected initial subset; later user-turn scope authorization; declared IDs versus natural reply content; task `done` transitions before findings are complete; identical-ID source refresh; and repair behavior for plain-text completion rejection.
3. Use deterministic regression cases for those boundaries first. If live validation is resumed, start with one bounded collection trial, inspect its trace, and stop expanding the suite without a concrete reason.
4. The eval wrapper changed error propagation after the baseline. Fixtures/grader remained the same, but retry behavior differs; disclose that when comparing. Fingerprinting does not yet cover all runner/dependency changes.
5. Keep the evals as development diagnostics; they currently do not return failure exit codes suitable for CI gating.
6. When ready for rollout, inspect current production state, archive/exclude known bad synthesis and operator-test conversation context, preserve all saved roles/memories/integrations, apply migration 007 and run an isolated smoke check. These steps remain undone.

## Lessons about development scope

The intended first milestone was a small baseline, not a comprehensive evaluation platform. Building scope enforcement while debugging provider and harness behavior made the work much larger. Future milestones should have a clear stopping point: one regression, one runtime mechanism, one comparison, then a usable checkpoint. Broader eval coverage can follow actual daily-use failures.
