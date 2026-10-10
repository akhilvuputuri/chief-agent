# Coding model selection and compatibility

Chief supports separate planner (internally `leader`), coder and reviewer choices. An explicit owner request changes one role through `coding_model_set`; `coding_models` reads current preferences and the eligible live OpenRouter catalog. Roles are owner-scoped and changes apply to new jobs only. Existing jobs retain their model/image/settings snapshot, including approved scope and explicit recovery. The main Chief model is separate.

Examples of owner requests:

- Use Claude Sonnet 5.5 for my coder; keep planner and reviewer unchanged.
- Switch the reviewer to Gemini 3.8 Flash.
- Change the planning model to GPT-6.1 Sol.

Chief resolves the requested model to an exact catalog ID and checks tool/reasoning support and the existing provider price filters. Unavailable, unsupported or over-filter choices leave that role unchanged. No price filter, dollar cap or allocation is changed automatically. For switching models on an existing job, prepare a new job with the intended choices; do not reinterpret its saved conversation or silently change approved settings.

## Verified interfaces

The runtime uses Pi's native OpenAI-compatible transport through Chief's OpenRouter facade. These tests concern models routed through OpenRouter, not direct vendor APIs, image/audio inputs or every future catalog model. Pi preserves structured and opaque reasoning during tool continuations. The facade remains strict and bounded; exact role/model identity, request journals and owner implementation approval remain host authority.

The report tool advertises only valid results for the current intent and the actual planning-summary bound. A clean prose-only ending receives one report-only finalization prompt within the active run and original allocation. Repository/command tools are deactivated for that prompt. Repeated missing reports, errors, cancellation or exhausted allocation stop visibly; the handoff does not resume a paused job, approve implementation or replace checks. A valid question or reviewer REQUEST_CHANGES remains a real workflow outcome. Review context labels the approved plan’s historical starting state separately from the completed candidate. Empty or truncated provider generations stop with fixed diagnostics; an uncertain call ID is not replayed.

## Evidence and limits

[Journal 79](journey/79-coding-model-compatibility.md) records actual-provider fixture runs, native profile regressions, rolled-back deployed control checks and real Chief-model command interpretation. A protocol pass, valid question or reviewer verdict is distinct from an accepted changed artifact. The seeded numerical workload is small; it establishes neither arbitrary task reliability nor a cross-model quality/cost ranking. Credentials stayed on the host, and owner preferences/jobs were not changed for testing.
