# Current work and pickup map

Updated 12 September 2026. Historical metrics and handover snapshots are not current production queries. Verify GitHub and production diagnostics when starting an incident investigation.

## Released baseline

Owned TypeScript runtime; Telegram text and ElevenLabs voice; research, tasks, reminders and Sheets; read-only Gmail; Calendar queries and explicit Telegram approval for event creation; basic explicit memories; token accounting and focused context/search optimizations. GitHub checks and automatic app release are installed. Last release verified while preparing this document: `e6837c0ab0061d768ea752a42548c3921ca3c095`. Later releases supersede this historical verification.

## Resume observable memory first

Code: [checkpoint/observable-memory](https://github.com/akhilvuputuri/companion-agent/tree/checkpoint/observable-memory), checkpoint `2a85839`. Read its [detailed checkpoint](https://github.com/akhilvuputuri/companion-agent/blob/checkpoint/observable-memory/docs/checkpoints/observable-memory.md). This is incomplete and not deployed. Start a new working branch from that checkpoint, incorporate relevant main changes, then finish tests/review and prepare additive migration 010. Do not merge it merely because code exists.

Known remaining issues include pre-mutation error classification, dedicated provenance/ownership/revision tests, trace inclusion semantics, bounded private export, full checks and reviewed deployment. Private memory-trace workflow support in that branch is not yet installed in production. No production secrets are required to reproduce the mocked tests.

## Subsequent agreed direction

1. Python trace analysis consuming versioned exports from the actual TypeScript runtime.
2. One narrow evaluation/improvement/comparison cycle with sanitized fixtures; no broad paid eval project.
3. Image/PDF ingestion: implemented on `feature/attachments` (Telegram photos and image files to the vision model for the current turn; PDF text extraction into `research_sources` with `source_read`). Not merged or deployed until its PR passes review; see [journey 07](journey/07-attachments.md). Remaining: OCR or page rendering for scanned PDFs, other document types, and a production Telegram check with a real photo and PDF.

## Deferred work

`feature/runtime-evaluations` is an earlier, explicitly deferred candidate. Its migration 007 is not production schema. Do not merge or run paid experiments incidentally. See [checkpoint](checkpoints/runtime-evaluations.md).

Realtime voice, delegation/shell execution, self-deployment and a Mini App are separate later milestones. Claude cloud setup instructions exist, but the account connection and a Claude-originated release have not been verified.

## Handover requirements

At each checkpoint record the branch and commit, objective, implemented behavior, actual checks, known failures, migration/rollback requirements and next concrete step. Publish source without secrets. Keep private traces out of Git; link their authorized inspection procedure instead.
