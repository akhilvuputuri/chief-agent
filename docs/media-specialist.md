# Bounded media processing

Issue #27 phase 2. The main agent can call `media_delegate` to have an isolated, read-only media specialist read images and stored documents. It reuses the specialist runner, traces and shared allocations from [research delegation](research-specialist.md); there is no new service, queue or database table.

## Why a specialist rather than direct vision

Before this change the main model received image bytes in every iteration of the turn that carried them. Now the coordinator never receives image bytes. Its message holds a note with a per-turn `attachmentId`; only the child model input carries the `image_url` part, once per child invocation. Image tokens are paid once for the specialist's short loop rather than on every coordinator step, raw content stays out of the coordinator's context, and a task-specific vision or document model can be configured with `MEDIA_MODEL` without changing the main model. The cost is one delegation round trip for even the simplest image question; PDF excerpts remain inline because deterministic extraction needs no model.

## Assignment and authority

`media_delegate(objective, context, attachmentIds, sourceIds)` takes one to four targets: current-turn image attachment IDs from the user's message note, and/or owner-scoped `research_sources` IDs (PDF text from intake, earlier `web_read` pages, or earlier image extractions). Unknown attachment IDs fail with an explicit message that images are available only during the turn they arrive. Foreign or missing sources are rejected before a child starts.

The child receives the assignment, the image parts and a description of each stored document. It can use only `source_read`, `media_report` and `finish_turn`. No web, email, calendar, memory or write operations exist in its tool set, and the dispatcher independently checks the live parent/child link and owner. Neither file content nor model arguments can widen that scope. The coordinator remains responsible for the user reply and for any authorized saves; the system prompt states that processing a file does not authorize saving its claims as memories or taking actions.

Limits per child: two minutes, six model calls, twelve tool calls, further bounded by the parent's remaining allocation with a small response reserve. Parent counters include child consumption; provider charges belong to the child run and are included in the parent's usage summary.

## Report contract and validation

`media_report` returns exactly one entry per assigned target with the exact `targetId`, `kind` (`image` or `document`), `status` (`complete`, `partial`, `blocked`), a summary, up to sixteen facts with a reference (page or image region) and qualitative confidence, document quotes, omissions and uncertainty. Runtime checks: the target set matches the assignment exactly, kinds match, complete targets carry at least one fact, image targets carry no quotes, and every document quote occurs verbatim in that same stored source and the child actually read it with `source_read` in this run. These checks establish recorded access and exact quotation. They do not certify that a fact is a correct reading of an image or that a quote proves a conclusion; those remain model judgments retained for review.

## Attachment lifetime and storage policy

- Image bytes exist in process memory for the turn only. They are never written to conversation history, runtime checkpoints, memory sources, events or research sources. `research.model_input` traces replace image parts with a size placeholder.
- The specialist's image extraction (question, summary, facts, omissions, uncertainty) is stored as an owner-scoped `research_sources` row under `telegram:image/<sha256>/<name>` and returned as `extractionSourceId`, so later turns can `source_read` it. The image itself cannot be re-examined unless the user resends it.
- PDF text continues to be stored in full at intake, as before.
- Identical content and question within seven days reuse the stored result: the cache key is a hash of the normalized objective, the image content hashes and the source IDs, looked up in owner-scoped `media.processed` events. A cache hit records `media.cache_hit` and makes no model call. A different question over the same file runs a new child.

Scanned PDFs without selectable text are still reported at intake; OCR and page rendering are not implemented.

## Model selection

`MEDIA_MODEL` (blank by default) selects a separate OpenRouter model for media children only, using the same price ceilings and provider filters. Nothing verifies a model's vision or document capability before use; a provider that cannot accept image input fails with the existing provider error, which the specialist reports as incomplete. Validate a candidate model with a real photo and PDF before relying on it.

## Trace inspection

Same private records as research delegation, with `role: "media"` in `research.child_started` and its `profile` holding the cache key, attachment hashes, sizes and source IDs. Parent-side `media.processed` carries the compact result and status; `media.cache_hit` links a reused result to its original child run. Successful `media_report` runtime calls hold the validated report. Start from an owner-scoped parent run, select children by `research.child_started` with that `parentRunId`, then read events, calls and charges for those IDs. Never paste model inputs, extractions or file content into CI logs or issues.

## Verification

`tests/media.test.ts` covers coordinator image isolation, child tool set and image parts, stored extraction and trace scrubbing, cache reuse across turns by content hash, stale attachment and foreign source rejection, document quote and read enforcement, kind validation, denied writes, a separately configured media model, and incomplete processing. `tests/attachments.test.ts` and `tests/telegram.test.ts` cover intake and the persisted note. No paid model call was made; real-photo reading quality, provider vision support under price-first routing and actual cost per image remain to be observed in use.
