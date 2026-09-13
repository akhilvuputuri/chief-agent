# From long Telegram replies to read-only interactive views

Work date: 2026-09-13. Revised: 2026-09-14.
Status: released v0.3.1; real-phone navigation and real-model UX acceptance remain separate.

Issue [#26](https://github.com/akhilvuputuri/companion-agent/issues/26) identifies a delivery problem: a useful multi-record analysis becomes several long messages on a phone. The existing renderer split text at 3,500 characters and `/status` sent a fixed ledger. Reformatting every conversational reply would impose a template without making saved data browsable.

The implementation separates model prose from optional presentation data. `finish_turn` can attach sections, sources, numbers and saved record references. Plain long replies also become pages without rewriting or discarding the model’s text. Browsing loads Postgres state and edits the same message; it spends no model call and performs no domain action. A deterministic status view is appropriate when explicitly requested with `/status`; ordinary model replies remain natural.

A versioned private UI-state event avoids a migration and public ingress for phases 1/2. Owner/chat/message binding, opaque callback tokens and server-stored keyboard actions prevent a copied or stale button from revealing a different record. The callback controller has an expiring database lease and preserves existing approval boundaries. Calendar draft viewing cannot create an event. Authoritative approval notices never disappear behind disclosure buttons.

New tests reconstruct an entire long emoji/formatted reply through navigation, exercise restart/stale/expired/cross-owner callbacks, verify stored task support and known/unknown costs, and run actual grammy update handling with mocked Telegram. Runtime tests check envelope validation and persistence before delivery. These are functional checks, not evidence of improved real-world answer quality.

Delivery and interaction events support a later before/after analysis: message counts per reply/run, baseline formatter chunk counts, taps, first-tap latency and errors. The existing restricted diagnostics script gains aggregate fields so cloud and local tasks can examine the same metadata once the reviewed handler is installed. Private answer snapshots remain in Postgres; no raw trace export is added.

This milestone provisioned no domain, Mini App, tunnel or infrastructure. Phase 3 was then an owner decision; it subsequently became [HTTPS ingress](13-miniapp-https.md) and [persistent canvases](14-persistent-canvases.md). From v0.3.1 onward the owner requested patch-only version increments. The release closure below records exact-head review, CI and deployment. Real-phone review of ten conversations remains an acceptance follow-up, and no measured UX/cost gain is claimed yet.

## Independent review corrections

Astra’s first MR #32 review requested two changes. Full section bodies existed only in finish arguments, while the available observation reader exposes results; once the large tool group left bounded context, a follow-up could not recover those details. The corrected runtime stores the envelope as a retrievable result, projects a compact observation and retains a separate short answer reference. A regression omits a two-section tool group from context and retrieves both exact bodies across multiple observation pages, including owner rejection. Finish output is accepted only after successful result persistence.

The reviewer also found identical role titles ambiguous in lists. Saved employer/title identities now appear in both collection and answer-reference labels, with a duplicate-title regression. These fixes required exact-head independent re-review before merge; the dated closure records the approval.

## Release closure — 14 September 2026

[v0.3.1](https://github.com/akhilvuputuri/companion-agent/releases/tag/v0.3.1) shipped [PR #32](https://github.com/akhilvuputuri/companion-agent/pull/32) at `1d99f74e2837bd347321cab34b41f1f66156e2a9`. The [release workflow](https://github.com/akhilvuputuri/companion-agent/actions/runs/34709168236) completed successfully for that exact SHA; published release evidence records deployment and health verification. Astra approved corrected head `00a47ccc97f6d5791fb4823dd9e868386b3efd10`; the release record confirms its tree matched the merge. Validation included 118 tests, typecheck/build/format, diagnostic SQL validation and read-only rendering of all six production view types with metadata-only output. The reviewed diagnostics handler was installed. These checks do not close the real-phone or conversational-quality follow-up.
