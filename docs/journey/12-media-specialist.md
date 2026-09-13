# Media processing through the specialist boundary

Work date: 2026-09-13. Revised: 2026-09-14.
Status: released v0.3.2; production photo quality and per-image cost unmeasured.

## Problem and decision

The attachments release put image bytes into every coordinator model call of the turn that carried them and gave the coordinator the whole reading job. Issue #27 phase 2 asked for file processing with focused context, deliberate attachment lifetime, compact results with references and uncertainty, and room for a task-specific model. Reuse the read-only specialist runner rather than adding a second delegation mechanism.

## Change

Images are no longer visible to the coordinator. The user message carries a per-turn attachment ID; `media_delegate` resolves it against the in-memory attachment, runs a bounded child with `source_read` and `media_report` only, and returns facts with page or region references, document quotes, omissions and uncertainty. Image extractions are stored as owner-scoped sources for later reading; image bytes are never persisted and are replaced in model-input traces. Identical content and question reuse the stored result. An optional `MEDIA_MODEL` routes only media children to a different model behind the existing adapter.

## Validation and limits

Mocked PGlite tests cover isolation, permissions, quote enforcement, caching, stale references, trace scrubbing and the separate model. Quote checks verify recorded reads and exact text, not the correctness of an image reading. No paid call was made, so real-photo quality and provider vision support under price-first routing are unmeasured. The extra delegation round trip adds calls for trivial image questions; the design trades that for keeping bytes out of the coordinator's repeated context. OCR for scanned PDFs remains open.

## Release process

[PR #33](https://github.com/akhilvuputuri/companion-agent/pull/33). Independent review by a Claude Fable 5.1 subagent (GPT-6 Astra was unavailable in that environment): the first pass requested changes because blocked readings were cached and stored and an incomplete child returned research-shaped targets; both were fixed with regression tests and the second pass approved `8da472a`. A merge with main (#32) was re-reviewed and approved at `d466621`. Released as [v0.3.2](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.2), deployed commit `10a2716b589783972a9f3f00e279a0e1d30971cf`, [release run 34709810663](https://github.com/akhilvuputuri/companion-agent/actions/runs/34709810663) healthy. No migration or infrastructure change. See [media processing](../media-specialist.md) for the contract and inspection procedure.

## Release closure — 14 September 2026

Rechecked the published v0.3.2 release and successful workflow for the exact deployed SHA above. The release records 122 tests, typecheck, build and formatting, with no paid model call. The review failures remain in the original release account. This closes deployment status only; production vision quality, price-first provider support and scanned-PDF OCR remain as stated above.
