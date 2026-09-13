# Conversational preparation and Sheets

Postgres is authoritative. The TypeScript agent chooses tools conversationally. The Google workbook is a one-way viewing mirror with three managed tabs: Target roles, Preparation gaps, Preparation tasks. User edits inside those tabs are overwritten on the next successful sync; extra tabs are untouched. No application submission or email sending is available.

## Tools and evidence

- `web_search(query)`: Tavily if configured; otherwise an isolated OpenRouter/Exa search request using the configured model, three results and a 1,000-token output limit. No conversation history or saved profile is attached. Only provider citation annotations are returned, not the model's uncited prose. Search incurs OpenRouter search/model charges.
- `web_read(url)`: Tavily if configured; otherwise Jina Reader. Public HTTPS hostnames only; retrieval happens at the hosted provider, not on the private server network. No cookies or credentials are forwarded. Store the bounded content as an owner-scoped source with retrieval time and return `sourceId`. Login walls and rate limits may prevent retrieval; accept pasted listing text instead.
- `prep_save(id, topic, importance, sourceQuote, assessment, sourceId?, evidence?, question?)`: upsert one topic for a saved role. Required/preferred/inferred are distinct. The quote must exist in the saved listing description or the specified retrieved source. Strength/gap requires nonempty background evidence; unknown requires a question. Semantic truth remains the model/user's responsibility, not something a string check proves.
- `prep_list(id?)`: return requirements and compact shared tasks, bounded to 500 each. An exact role filter includes only tasks linked to that role. Lists expose link IDs/counts rather than replaying the full evidence chain. The sheet export uses the complete snapshot up to 5,000 rows per tab and fails rather than silently truncating above that.
- `prep_task_save(topic, exercise, completionCriteria, priority, status?, links?)`: shared lowercase topic identifies a task. New tasks and previously unlinked tasks require links `[{scopeId, jobId, preparationId}]` to saved alignment actions. The host resolves the chain from owner-scoped frozen reports, source records and background snapshots; it does not accept model-authored replacement quotations. Further links merge atomically while preserving other contributing roles. Omitting links is allowed only for an already-linked task. Omitting status preserves progress. At most 16 references per call, 32 stored links and 256 KiB of chain data per task; split overly broad tasks rather than dropping evidence.
- `prep_task_read(id, offset?, version?)`: read the complete saved task/chain in bounded, JSON-escaping-aware pages. Start at offset zero, then follow `nextOffset` using the returned `version`. Concurrent edits invalidate later pages and require restarting the read. Owner scope is checked before returning data.
- `sheet_sync()`: exports a consistent owner-scoped database snapshot. One atomic Sheets batch updates all tabs, removes stale managed cells, freezes/stylizes headers and adds filters. Literal string cell values prevent formula execution from external text. The agent is instructed to sync after changes. This is agent-triggered, not a background outbox; retry through Telegram if it fails. Database saves survive sync failure.

Do not equate missing resume information with lack of skill. Ask at most three focused questions at once. Do not label inferred interview topics as explicit hiring requirements, invent experience, or assign numeric hiring probabilities.

## Preparation evidence chain

Version 0.3.10 preserves this chain in the task itself:

```text
frozen selected job → quoted requirement → background evidence or unresolved question
                   → report action and rationale → readiness check
```

Each source link records scope/job/action IDs, originating child run, frozen job identity/description hash, skill identity, requirement importance, exact source quotations, source URLs/retrieval dates where present, fit categories and frozen background quotations. Full descriptions remain in the existing alignment scope; they are not recopied into every task. Unknown fit needs an explicit requirement-specific `fit.question`. New report actions must link to a sourced role requirement; interview findings can supplement that basis, but cannot replace it. Misidentified roles, unsupported source or memory quotes and foreign-owner links fail before a task changes. Saved-only posting snapshots remain qualified; they are not proof of a currently open role.

The coordinator may combine actions into a shared exercise and readiness criterion. Original per-role actions/checks remain in the chain alongside that synthesis. The host verifies references and quoted support, not whether the synthesized exercise is pedagogically sufficient or a passage entails every conclusion. The existing runtime call journal records saves/reads and their run IDs; stored chain references identify the source assessment.

Migration 015 adds an empty chain to older tasks without inferring links, changing status or regenerating work. Legacy tasks remain readable and labelled unlinked; they need explicit valid references before further writes. Historical alignment reports remain readable unchanged. Older reports with unknown experience but no specific question cannot seed a new chain: obtain a new assessment only when requested, rather than inventing the missing question or silently reprocessing an old task.

The preparation Sheet adds linked roles, quoted requirements, experience/questions, rationale, source references and original checks to its task tab. Long cells are explicitly shortened for the viewing mirror; `prep_task_read` retains the complete data. Existing legacy gap rows remain separately editable through `prep_save`; they are not the authoritative basis of linked tasks. A failed Sheet sync does not undo a saved task.

`todo`, `doing` and `done` record reported progress. Marking a task done is not an assessed proof of mastery; evaluation of submitted work and learning-result history remain future capabilities. Private skill overrides and existing task pins are preserved, although current host validation applies to every new report/save.

See [reviewed rollout and rollback](preparation-rollout.md), [job alignment](job-alignment.md) and [engineering journal](journey/21-preparation-chain.md).

## Google setup

1. Enable Google Sheets API in the existing Google Cloud project.
2. Run `node scripts/connect-sheets.mjs CLIENT_JSON TOKEN_JSON EXPECTED_EMAIL`. Complete Google consent in the browser. The loopback callback uses state and PKCE, verifies exact scopes and account identity, and writes a private token file without logging secrets.
3. Run `node scripts/create-preparation-sheet.mjs TOKEN_JSON SHEET_JSON` once. It creates private tabs with IDs 0, 1, 2; no sharing is added. Do not retry creation after an uncertain result without checking Drive for an existing workbook.
4. Set `SHEETS_OWNER_USER_ID`, `SHEETS_REFRESH_TOKEN`, `SHEETS_SPREADSHEET_ID` plus existing Google client fields in private local/cloud environments. Recreate the gateway.
5. Call `sheet_sync` and verify the returned URL and counts. Gmail's separate token and `gmail.readonly` scope remain unchanged.

Sheets consent requests `drive.file`, `openid`, and email identity. The application only targets its fixed provisioned spreadsheet; the model cannot choose another file. `drive.file` is supported by the Sheets API and avoids broad access to all spreadsheets. Google OAuth testing-mode token lifetime remains an operational limitation; do not assume permanent refresh-token validity.

## Verification

Tests cover owner isolation, source ownership, quote validation, unknown/gap evidence requirements, upsert identity, progress preservation, literal sheet cells, provider failure propagation and uncited search rejection. Live provider checks and cloud health checks are recorded in HANDOVER.md. Public page content is untrusted and may be stale, incomplete or malicious; exact-quote validation is provenance checking, not protection against every semantic hallucination.

References: [Sheets create](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create), [OpenRouter search](https://openrouter.ai/docs/guides/features/plugins/web-search), [Jina Reader](https://jina.ai/reader/).
