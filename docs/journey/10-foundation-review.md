# Independent review of the specialist foundation

Work date: 2026-09-12. Revised: 2026-09-14.
Status: released v0.2.1 after independent review corrections.

An independent Astra review of shipped v0.2.0 identified two reproducible issues. Children had no runtime task ID by design, but search caching used that ID and therefore repeated the parent's identical search. Child counter updates refreshed the parent's timestamp while elapsed time waited for the outer tool to finish; a crash could lose already-completed child execution time from the task budget.

Search reuse now resolves the trusted parent link separately from budget attachment, within the authenticated owner and run family/attached task. Existing expiry and exclusion of cached copies remain. Elapsed time is charged atomically to child, parent and attached task as each child operation completes. Parent completion subtracts already-accounted child time before adding overhead. This prevents the reproduced loss and avoids double counting successful work. Recovery of an in-flight operation remains conservative; wall-clock time is not an exact process-runtime profiler.

New mocked/PGlite tests exercise parent/sibling/task reuse, owner and unrelated-run isolation, expiry, cache-copy exclusion, durable child time before parent completion, repeated recovery and successive successful children. No private production data or paid model calls were used. The fixes required an independent Astra re-review, passing CI and verified release; that completed sequence is recorded below. No database migration or infrastructure change is needed. The required independent review/fix/re-review loop is now documented in AGENTS.md.

## Release closure — 14 September 2026

[v0.2.1](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.2.1) shipped [PR #31](https://github.com/akhilvuputuri/companion-agent/pull/31) at `cdc5a0027dd750e70512aa143640e3c2505b7604`. The [release workflow](https://github.com/akhilvuputuri/companion-agent/actions/runs/34686797702) completed successfully for that exact SHA; published release evidence records deployment and health verification. The review sequence was REQUEST CHANGES → fixes → independent Astra APPROVE at `89a87453edbcffc1a4c1b4208582d6f1ccddc13b`. Full implementation validation recorded 102 tests, typecheck, build and formatting. The dependent [alignment release](09-job-alignment.md) incorporated these fixes before shipping. Reproduced cache reuse and accounting behavior do not quantify production savings.
