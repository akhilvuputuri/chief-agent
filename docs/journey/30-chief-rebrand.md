# Chief product and repository identity

## Requirement and design — 22 September 2026

Rename the general personal assistant to Chief and its existing GitHub repository to chief-agent. This is an identity change, not a fresh installation. Preserve historical engineering accounts and all user state.

Inspection found explicit repository-name checks in cloud diagnostics, the release-evidence helper and cloud preflight. Merely renaming GitHub would disable diagnostics and make release evidence unverifiable. The change updates canonical links and accepts historical receipts, with stable repository-ID validation to prevent a newly created old-name repository from satisfying those checks. Existing operational names, plugin formats and session/idempotency identifiers remain stable; see [compatibility](../rebranding.md).

## Validation and limits

Tests cover both repository names, old receipt URLs after rename, and rejection of different repository IDs alongside existing publisher/workflow/actor restrictions. Mini App titles, open buttons, core assistant identity and future preparation Sheet titles use Chief. Existing Sheets, bot username, Google consent name and stored data are not migrated.

Candidate v0.3.21; independent review, repository rename, deployment and external metadata verification are pending. This release does not increase the context ceiling or implement issue #77.
