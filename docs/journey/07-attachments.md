# 07 — Reading photos and PDFs sent on Telegram

Work date: 2026-09-12. Written: 2026-09-12.
Status: released. PR #22, application `eb501b3c4fdf0bf1e1b0743c2b3772c0101225b3`, deployed 12 September 2026 with a passing health check. Production conversational quality with a real photo and PDF is not yet measured.

## User-visible problem

The bot accepted only text and voice. A photo of a sign, a screenshot or a PDF CV sent on Telegram was answered with "Please send text or a voice note", so the user had to retype or paraphrase content the phone already held. The owner asked whether the app could parse images and PDFs; analysis of the code showed no file intake, a text-only model message type, no parsing dependency and a Gmail reader that deliberately skips attachments.

## Evidence

Code inspection on main at `8b69d7e`: `telegram.ts` read `ctx.message.text` and `ctx.message.voice` only; `Message.content` was `string | null`; `package.json` had no PDF or image library. This is an observed capability gap, not a production incident. No production traces were needed or copied.

## Diagnosis and alternatives

Two separate mechanisms were needed and they have different costs.

Images. The main model reached through OpenRouter accepts OpenAI-style multimodal content parts, so no second provider is required. The risk is not capability but cost and history growth: a base64 photo is one to four megabytes of text. If it were persisted in `conversations.history` or runtime checkpoints it would be re-sent on every later turn until the history bound dropped the whole turn, and the byte-based cost estimate would report dollars for a single request. Rejected alternatives: storing images in Postgres (no blob table without a migration, and release automation refuses migrations); describing images with a separate cheap vision call and passing only text (loses detail, adds latency, and the owner's main model already sees images).

PDFs. Options were a local parser, OpenRouter's file content part, or rendering pages to images. The file part depends on which provider price-first routing selects, and rendering needs a native canvas. A pure-JavaScript text extractor is deterministic, runs in the existing container and produces text that fits the existing untrusted-content framing used for Gmail and web pages. `pdfjs-dist` pulls a 27 MB optional native canvas package; `unpdf` wraps the same engine in 2.5 MB with no native dependency and extracted the same text in tests, so it was chosen. Scanned PDFs have no selectable text; OCR is deferred and the user is told to send page photos instead.

## Implementation

- `src/attachments.ts`: classifies Telegram photos and documents, validates file paths against the `voice`, `photos` and `documents` directories, bounds sizes (10 MB images, 20 MB PDFs, 50 pages, 200,000 characters, 20 s), extracts PDF text page by page, detects text-free documents and builds the persisted user message.
- `src/telegram.ts`: downloads through the same bounded fetch used for voice, sends images to the agent for the current turn, stores PDF text in the existing `research_sources` table under a `telegram:document/...` URL, records byte and page counts as events (never content), and answers unsupported or unreadable files directly without a model call.
- `src/model.ts`: adds `ContentPart` and `ModelMessage` for model input only; `estimateInputBytes` replaces image data with a fixed 1,600-token allowance so cost accounting stays sane. Persisted `Message` remains text.
- `src/context.ts`: attaches image parts to the current user message in the model input without mutating the persisted history object, and tells the model that images are visible only in the current turn and that file content is data, not instructions.
- `src/protocol.ts`, `src/tools.ts`, `src/execution.ts`: new read-only `source_read(id, offset?)` tool returning 8,000-character windows of any owner-scoped stored source, which also lets the model re-read earlier `web_read` pages after they leave context.
- `src/agent.ts`: passes images through `respond` and `turn` without persisting them.
- Tests: `tests/attachments.test.ts` builds minimal PDFs in code (no binary fixtures), covers page and character caps, scanned detection, classification, path validation, message notes, model-input parts and the cost estimate. `tests/telegram.test.ts` drives photo, PDF, scanned, unsupported, oversized and path-traversal updates through the real grammy handler with mocked Bot API and fetch, and checks that history and memory sources contain no image bytes and that another user cannot read the stored source.

No database migration or Compose change; the Docker image gains only the pure-JavaScript dependency.

## Verification and outcome

Synthetic verification: 91 mocked tests pass, plus typecheck, build and format checks; PR checks passed. Release workflow run 34671433515 reported `{"deployed": "eb501b3c...", "healthy": true}` after recreating the gateway. No paid model call was made, so end-to-end vision quality and cost with the production model and provider routing remain unmeasured until the owner sends a real photo and PDF.

## Follow-up

- Production check after release: send one photo with a caption and one text PDF; confirm the reply, the `image.received` and `document.extracted` events and a plausible reported cost.
- If price-first routing selects a provider without vision, the request fails with the existing provider error; consider a modality hint in provider preferences if this is observed.
- Deferred: OCR or page rendering for scanned PDFs, DOCX and spreadsheets, multiple photos in one album treated as one request, and retaining a model-written image description in history automatically.
- Lesson: the expensive part of multimodal input is not the model call but everything downstream that assumes messages are small strings (history bounds, checkpoints, memory sources, cost estimates). Keeping bytes out of persistence was the central design decision.
