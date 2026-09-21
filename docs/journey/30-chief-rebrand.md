# Chief product and repository identity

## Requirement and design — 22 September 2026

Rename the general personal assistant to Chief and its existing GitHub repository to chief-agent. This is an identity change, not a fresh installation. Preserve historical engineering accounts and all user state.

Inspection found explicit repository-name checks in cloud diagnostics, the release-evidence helper and cloud preflight. Merely renaming GitHub would disable diagnostics and make release evidence unverifiable. The change updates canonical links and accepts historical receipts, with stable repository-ID validation to prevent a newly created old-name repository from satisfying those checks. Existing operational names, plugin formats and session/idempotency identifiers remain stable; see [compatibility](../rebranding.md).

## Validation and limits

Tests cover both repository names, old receipt URLs after rename, and rejection of different repository IDs alongside existing publisher/workflow/actor restrictions. Mini App titles, open buttons, core assistant identity and future preparation Sheet titles use Chief. Existing Sheets, bot username, Google consent name and stored data are not migrated.

Released v0.3.21; review, rename and deployment evidence is recorded below. This release does not increase the context ceiling or implement issue #77.

## Rename and external verification — 22 September 2026

PR #76 merged at `4c91eeb79b13245ce9a799b33d9d32ef73409c03` after GPT-6 Astra independently approved `9800d7e17b785b2c2fe68f970436b47a17407402`. Local checks passed 342 application tests and 10 script tests; both PR checks passed. The existing private repository was renamed in place and retains ID `1358822022`. The isolated working checkout and existing local source checkout now use the canonical remote.

Telegram's API returned the new Chief display name and description with the original bot username. The three existing HTTPS information pages returned HTTP 200 with Chief branding after a separate static-file copy. No consent settings, routes, credentials or scopes changed. The renamed repository's [diagnostics run](https://github.com/akhilvuputuri/chief-agent/actions/runs/35630251495) succeeded; this confirms the post-rename diagnostics path, not deployment of the new app. The release helper also successfully verified the previous release using its historical URL after the rename.

Devin discovered chief-agent, but retained an obsolete companion-agent review enrollment. The enrollment was replaced with chief-agent, with Auto review (readiness and subsequent pushes) visibly saved. During verification the old entry showed on-creation-only review, contrary to the earlier handover claim; this was corrected. The existing /companion custom command was preserved, with its description and prompt updated to Chief and the canonical repository. Automatic review on a new post-rename PR remains a separate check.

## Verified application release

[Release run 35630726510](https://github.com/akhilvuputuri/chief-agent/actions/runs/35630726510) completed successfully for exact commit `4c91eeb79b13245ce9a799b33d9d32ef73409c03`, with startup health verified. The authenticated release helper returned success, and a separate HTTPS fetch returned HTTP 200 with `<title>Chief</title>` from the live Mini App. [v0.3.21](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.21) identifies this application milestone. No database/Compose migration or user-task replay occurred. Live conversation semantics were not re-evaluated for a naming change.
