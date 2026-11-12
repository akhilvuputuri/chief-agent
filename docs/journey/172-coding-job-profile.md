# 172 — How do we compare one coding job's time and cost with another's?

Work dates: 12 November 2026. Written: 12 November 2026.
Status: tooling only, tested against PGlite and run read-only against production. No runtime change. Not yet merged.

## User-visible problem and preceding iteration

[Journal 169](169-three-hour-coding-attempts.md) measured job `9600af57` (Opus 5.5 at `high` effort) by hand-written queries: phase times, model calls and cost per role, thinking share, the gaps between calls and the coder's tool use. PR 462 moves new jobs to `medium` effort, and the owner wants the next job compared with `9600af57` on the same measures. Rewriting those queries for every job is slow and easy to get subtly different, and an ad-hoc query can print private content by accident.

## Evidence

**Measured, production database, job `9600af57`, read 12 November 2026 at about 06:10 UTC with the new script** (the job was still running its fourth attempt, so attempt 4 is partial):

| Attempt                         | Role     | Model calls | Cost   | Thinking share | One tool call per response |
| ------------------------------- | -------- | ----------- | ------ | -------------- | -------------------------- |
| 1 (plan, 6.7 min)               | leader   | 15          | $1.12  | 43%            | 3 of 15                    |
| 1                               | reviewer | 7           | $0.56  | 86%            | 5 of 7                     |
| 2 (implement, 150.0 min)        | coder    | 173         | $19.55 | 83%            | 168 of 173                 |
| 2                               | reviewer | 62 (65 req) | $6.40  | 96%            | 58 of 62                   |
| 3 (review and repair, 46.6 min) | coder    | 51          | $2.16  | 71%            | 48 of 51                   |
| 3                               | reviewer | 50 (51 req) | $5.64  | 77%            | 44 of 50                   |

"Model calls" counts `model_usage` events; "req" counts requests in `coding_model_calls`, including ones lost to gateway restarts or the deadline. Attempt 2's coder made 169 `bash` calls; by first word 49 `sed`, 42 `grep`, 25 `python3`, 14 `cat`. Its gaps between answers: 105 under 15 s took 8.2 minutes, 35 over a minute took 77.7 minutes, of 102.2 in all; about 92 of those 102 minutes were spent waiting for the model. No response carries a thinking summary yet: none of the 331 reasoning entries read had text.

These reproduce journal 169's figures (173 calls and $19.55 for the coder; 62 completed of 65 reviewer requests before the 04:14 pause; 168 of 173 coder responses with one tool call) from the same tables.

**Tested:** `tests/coding-job-profile.test.ts` runs the script's SQL against the migrated schema with a synthetic two-attempt job, checks every section's numbers, checks that an ambiguous prefix matches nothing, and checks that a marker placed in the prompt, replies, tool arguments, thinking text, objective and end-of-attempt summaries appears nowhere in the output.

## Diagnosis and alternatives

The existing convention for production reads is a `.sql` file run with psql in the Postgres container (`scripts/storage-diagnostics.sql`, `scripts/library-diagnostics.sql`, `scripts/judge-report.sql`, the last tested the same way). The profile follows it, taking the job through psql's `-v job=…` and refusing a prefix that does not match exactly one job.

- **Per attempt and role, not per job.** A job's attempts can have different settings and phases (plan, implement, review and repair), and roles take turns inside one attempt, so a whole-job figure hides what changed.
- **Gaps within a run of one role.** The time between consecutive answers is the model's time plus tool and host time. A role's first answer after another role's turn is measured from its own first request, so the checks between implementation and review are charged to neither role. The second latency table separates the model's own time (each request to its answer) from the rest.
- **Only the first word of a `bash` command.** It shows how the coder works (reading with `sed`, editing with `python3`) without printing arguments. An assignment or an unusual token is grouped as `(assignment)` or `(other)`, never printed. (Update, 12 November 2026, after review: the directory is dropped and long or token-like words are grouped too; see below.)
- **Thinking summaries as counts.** Summarized thinking is being added separately; the profile counts non-empty summaries and their length so the effect is visible without printing any text.
- **Alternative: a TypeScript command.** It could share the code with `coding_status`, but production reads go through the operator connection and psql today, and a SQL file needs no deployed code. Not chosen.

## Implementation and review

[scripts/coding-job-profile.sql](../../scripts/coding-job-profile.sql), [tests/coding-job-profile.test.ts](../../tests/coding-job-profile.test.ts), a dated section in [docs/coding.md](../coding.md#profiling-a-job--12-november-2026). Independent review pending.

**Update, 12 November 2026:** independent review of `b610f5cb` approved, with non-blocking findings, and these fixes followed in the same PR:

- A running attempt with no end marker showed nothing in `ended`; it now shows `(running)`.
- Stage summaries are not all fixed labels: a failed run reports its error message (`coding_runtime_pi/src/runtime.ts`), and a requirement check prefixes the runtime's text (`src/coding/pi-worker.ts`). Only known labels are printed now; anything else keeps a known prefix (`Implementation: (other)`) or becomes `(other)`. The script's comment and the PR description called the summaries it showed the worker's fixed progress labels; that was wrong when written.
- The `bash` program is shown without its directory, only when it is at most 20 characters of `[A-Za-z0-9._-]` and not token-like (16 or more characters mixing letters and digits); a `cd` prefix no longer crosses a newline. Tool names get the same kind of allowlist.
- A usage or progress value that is not a JSON number counts as 0, or is skipped, instead of stopping the report under `ON_ERROR_STOP`.
- `SET LOCAL statement_timeout = '60s'` and `lock_timeout = '2s'`, and separate messages for a prefix matching no job or several.
- Tests for a running attempt, non-JSON and object-form tool arguments, free-text stage summaries, path-like and token-like program names, a disallowed tool name, non-numeric usage values and a quoted prefix.

Re-run read-only against production after the fixes: attempt 2's figures are unchanged (coder 173 calls, $19.55, 168 of 173 with one tool call, 169 `bash`: 49 `sed`, 42 `grep`, 25 `python3`, 14 `cat`), no stage summary of `9600af57` falls outside the known labels, and the running fourth attempt shows `(running)`. Attempt 2's reviewer span is 38.8 minutes instead of 38.7, because a run's span now also reaches its last unanswered request.

**Update, 12 November 2026:** the delta review of `cdb115d1` approved, with three tightenings made before merge. A check line is printed only for the worker's four check commands (`kite ci`, `kite run check`, `kite run build`, `kite run format:check`, from `src/coding/pi-worker.ts`) with exit code and duration; any other becomes `Check passed: (other)` or `Check failed: (other)`. Tool names are printed only when they are one of the Pi worker's tools (`read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`, `report`, `read_document`, from `coding_runtime_pi/src/tools.ts` and `documents.ts`). Tests now cover a `Requirement check N: Running review` line, a check line that falls back to `(other)`, and the run span reaching an unanswered request (a reviewer run of 40 s with 30 s of model wait); replacing `greatest` with the earlier `coalesce` fails the test. Re-run read-only against production: all eight check lines of `9600af57` and all its tool names are still printed, and attempt 2's figures are unchanged.

## Verification and outcome

Tested locally and run read-only against production as above. The comparison it exists for, the first `medium`-effort job against `9600af57`, has not happened yet.

## Follow-up and next iteration

`coding_model_calls` has no index on `job_id`, so every section scans that table (hence the statement timeout). An index would make the profile cheap as the table grows; it needs a migration and the operator procedure, so it is a possible follow-up, not part of this change.

Run it for the first job created at `medium` effort and record the comparison in journal 169's follow-up or a new entry. If thinking summaries land, check that section 6 counts them.
