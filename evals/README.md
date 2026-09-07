# Small runtime evaluation suite

Run before improving the runtime, then repeat unchanged cases after each focused change. These are synthetic role records because they exercise the currently available domain tools. They are not production user records or proof of general performance across other domains.

## Run

- `npm run eval`: offline context-retention probe, no network or credentials required.
- `npm run eval -- --live`: real Sol medium with controlled web responses and an isolated in-memory Postgres-compatible database per case.
- `npm run eval -- --live --case=missing-evidence`: run one case.
- `npm run eval:compare -- BEFORE/report.json AFTER/report.json`: compare matched fixtures, graders and settings.

Live mode requires a private OPENROUTER_API_KEY. It never uses DATABASE_URL or starts Telegram, Google or speech providers. Only inference contacts an external service. Price ceilings remain $2/M input and $10/M output. Across the invocation, the runner admits requests against a $2 ceiling using a conservative input-byte/output-token upper estimate; returned cost replaces that reservation when known. Failed/unknown calls keep the reservation. This accounting is not a billing guarantee or statement. Each case also has model-call and runtime budgets. No automatic background worker runs; an unfinished case is recorded as unfinished.

Every run writes ignored `eval-results/<timestamp>/report.json`, `report.md` and per-case traces including the exact model inputs. Reports include code revision, dirty-tree flag, fixture/grader fingerprint, usage when available, latency, outcomes and call counts. Do not publish traces without reviewing them; the current fixtures are synthetic, but future ones may not be.

## Cases and interpretation

1. Collection: 22 roles, large descriptions and unrelated recommended jobs in page responses. Check exact ID/title fidelity and coverage under context pressure.
2. Missing evidence: requirements mention customer deployment, but the profile establishes only TypeScript work. Assessments must remain unknown.
3. Scope change: initially request IDs 1 and 2, then replace scope with 2 and 3. Grade the final reply against the revised set.

The final JSON request is an evaluation-only output contract. It makes ID/title/coverage scoring deterministic; it does not test natural Telegram prose or detect all unsupported claims inside reasons. Tool success is not rewarded as task success. Invalid JSON is an explicit format failure, not proof of hallucination. A correct partial result can have coverage without being a passing completed task. False completion is mechanically checked against collection/format errors only.

The separate context probe deliberately creates repeated bookkeeping tool responses and checks whether the inventory remains available. A failure diagnoses selection behavior; it is not a stochastic model-quality score or an exact replay of the production incident. Never tune fixtures merely to obtain a desired model failure. If the live baseline passes, record that and expand coverage based on evidence.

## Human review rubric

Read the reply alongside source fixtures and model/tool trace. Score each dimension 0 (wrong), 1 (mixed), 2 (supported): source interpretation; uncertainty handling; useful explanation; completion honesty. Cite the specific offending or supporting sentence. Keep human ratings separate from deterministic pass/fail. There is no model judge yet.

One run is a smoke baseline, not a reliable success rate. Repeat identical invocations (initially three) when comparing candidates, inspect variation and do not claim statistical significance. Current cases are development cases, not a held-out test set. Add untouched scenarios before making broader quality claims. Keep model settings fixed while changing one runtime mechanism at a time.

Eval commands report failures without a nonzero exit code, so a baseline defect can be recorded; they are not yet CI release gates. Grader unit tests and evaluation TypeScript checks run in the regular check command. Production data recovery and runtime fixes are separate work.
