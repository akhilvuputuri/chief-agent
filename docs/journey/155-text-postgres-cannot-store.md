# 155 — Why did one model reply pause a coding job?

Work date: 2026-11-08. Written: 2026-11-08.
Status: tested on synthetic jobs; release pending.

## User-visible problem and preceding iteration

Study-links job `280f2d70` had reached PR 428 ([journal 154](154-failed-checks-go-back-to-the-coder.md) describes the worker it ran on). On 8 November a docs-only merge moved main, so the host rebased the job automatically and started building the approved plan again on the new main. About eight minutes in, the job paused with "Model run did not finish cleanly; session retained", and its last failure read only `worker_request_rejected`, reason `unclassified`. The owner asked what the problem was.

## Evidence

- **Measured (production, read-only, 8 November 09:32 UTC):** the gateway logged `coding.request_rejected` with phase `model`, HTTP 409 and reason `unclassified`. At the same second Postgres logged `unsupported Unicode escape sequence` ("\u0000 cannot be converted to text") on `UPDATE coding_model_calls SET state='complete',result=$2::jsonb`. The coder's reply quoted a regular expression containing a NUL character (the escape `\u0000` had been decoded into the character itself). The call was left `uncertain`. The 120 calls before it in that attempt completed.
- **Measured:** this is the only such Postgres error in the logs the container kept; their history starts at its last restart.
- **Code:** `src/coding/controller.ts` wrote the readable copy of each model request and reply as jsonb. It filtered credentials (`scrubTrace`) but nothing else. The exact reply is sealed in `result_box`, which is a byte box and stores anything. Worker progress, checkpoints and finish reports were written as received.
- **Code:** `src/learning.ts` and `src/mail-index-store.ts` already removed NUL before writing, for the same reason. The coding host had no such step.
- **Code:** the API turns any error without a known message into a 409 with reason `unclassified`, so a database refusal looked like a worker fault.

## Diagnosis and alternatives

Postgres text and jsonb cannot hold NUL or a lone surrogate. Model replies, test output and summaries can contain either. Written as text, `\u0000` is harmless; it becomes a real NUL once decoded, for example when Pi parses tool-call arguments or when the provider decodes the reply. The host accepted such text and then failed to write it. The reply was sound; only its readable copy could not be stored. Had that write succeeded, the next request, which carries the reply back, would have failed the same way when its own readable copy was written.

The fix makes descriptive text storable once, where the host writes it, and keeps everything exact that must stay exact:

- **Made storable** (NUL removed, a lone surrogate replaced with U+FFFD, in values and keys): the readable copies of model requests and replies, model progress and usage records, worker progress, and the descriptive parts of checkpoint and finish reports (plans, findings, check output, summaries).
- **Kept exact:** the request hash, the request sent to the provider, the response returned to the worker, the sealed response copy, and Pi session entries. Session entries are sealed whole and compared by hash on resume, so rewriting them would break resumes.
- **Refused, never changed:** text that must stay exact. The published code must be exactly what was checked and reviewed. A report document is bound to its hash, which later checks recompute. Review findings are compared with the exact sealed reviewer reply, and a document's plan and saved findings with the document. A patch, file entry (path or content), review findings, or (alongside a report document) the plan or saved findings that are not storable text are refused with `exact_content_not_storable`. A report document with a NUL fails the checkpoint schema, which calls the runtime's `reportDocument()`, so it is refused as `invalid_worker_payload`. The Pi runtime already refuses NUL files before export, and its `reportDocument()` now refuses NUL, so a worker on the next image gives the model a tool error and it rewrites.
- **Named:** a Postgres data exception (SQLSTATE class 22) on a worker request is recorded as `database_value_rejected` rather than `unclassified`.

Rejected:

- Changing `scrubTrace`. It also checks plugin definitions for credentials by testing whether scrubbing changed them, so a NUL would be reported as a credential.
- Making whole request bodies storable when they arrive. That would change file contents and Pi session entries, and alter what the model is sent.
- Rewriting every SQL parameter in a database wrapper. That hides the rule from the code that relies on it, and cannot tell code from description.

## Implementation and review

- `src/storable.ts`: the shared helper, moved from `src/learning.ts`, which now imports it. It walks plain data only and normalizes keys too.
- `src/coding/controller.ts`: `storableCheckpoint`, and storable readable copies in `generate` (request, reply, progress and usage records), `progress`, `save`, `finish` and `recordRejection`.
- `coding_runtime_pi/src/report.ts`: `reportDocument()` refuses NUL. The host gets this at release; workers get it with the next pinned image.
- `src/coding/rejection-reason.ts`: `exact_content_not_storable` and `database_value_rejected`.

Independent review (Claude Opus 5.5) requested changes on the first version:

- **Blocking:** report documents were normalized, but each is bound to its hash. A plan document with a NUL would be saved with its old hash, and after the owner's approval every implement attempt would be refused when it carried the document forward. Before the change the write failed and nothing was saved. Fixed: report documents are exact content, refused rather than changed, and the runtime refuses NUL so the model rewrites.
- **Important:** an approved review containing a NUL would fail the reviewer proof after publication, with a misleading reason. Fixed for Pi by the same change. File paths were normalized before validation, so a bad path would be renamed rather than refused; the exactness check now covers whole file entries. The tests covered only the legacy model route.
- **Nits fixed:** object keys are normalized, only plain objects are walked, the model progress and usage records are normalized, and the replacement character is written as an escape.

Re-review approved, and recommended two more fixes, both made: the legacy reviewer proof still compared normalized findings with the exact sealed reply, so review findings are now exact content; and the schema test reused a hash computed for other text, so it would have passed without the NUL check. It now hashes the NUL text as an older worker would, and fails when the runtime check is removed. Its nits are also fixed: the plan and saved findings are exact alongside a document, the docs give the code a NUL document actually gets, the progress test checks the stored text, and the Pi test covers streaming.

## Verification and outcome

- **Tested:** `tests/coding-storable-text.test.ts` uses PGlite (Postgres). Before the fix, a model reply with a NUL and a lone surrogate was refused with 409, and a finish report with them failed with `unsupported Unicode escape sequence`. That is the production failure. After the fix:
  - On the legacy model route and the Pi route, the worker gets the reply exactly, the same call replays the exact sealed reply without a new model call, the readable copies hold the storable text, and a request carrying the reply back is stored.
  - Progress, a plan and a summary with such text are stored.
  - A file whose content or path contains NUL, a patch containing NUL, and review findings containing NUL are refused with `exact_content_not_storable`.
  - `reportDocument()` refuses NUL, and the checkpoint schema refuses a NUL document with a correct hash; that test fails when the runtime check is removed.
  - The streamed Pi response carries the exact text.
  - Postgres code `22P05` maps to `database_value_rejected`.
- **Not yet measured:** job `280f2d70` resumed on a release containing this fix.

## Follow-up and next iteration

After release, the owner resumes `280f2d70`, and its rebuilt PR 428 is reviewed again against the five findings recorded before the rebase. Chief's main agent writes run events and tool-call arguments as jsonb in the same way (`src/db.ts` `event`, `src/execution.ts`) and has the same exposure to NUL in tool output; no failure there has been observed.
