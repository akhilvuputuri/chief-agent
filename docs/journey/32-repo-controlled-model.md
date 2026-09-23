# 32 — Repo-controlled model releases

Work date: 23 September 2026. Status: implemented candidate; independent review, merge, release and live acceptance pending.

## Problem and preceding iteration

The main model was configurable through `AGENT_MODEL`, but production Compose injected it from a private server `.env` or its own 5.6 fallback. A cloud coding agent could change the TypeScript default and deploy successfully without changing the effective live model. The owner wanted other coding agents to propose a model change as a reviewed repository edit and let the shared release pipeline apply it, without repeated server access.

The [cloud development path](05-cloud-development.md) already deploys ordinary application changes and deliberately refuses Compose/database edits. This issue was a configuration ownership gap, not a need for a new deployment service.

## Evidence and diagnosis

- **Observed in source, 23 September:** `compose.yaml` passes `AGENT_MODEL: ${AGENT_MODEL:-openai/gpt-5.6-sol}` to the gateway, and `src/main.ts` previously passed that value to `OpenRouter`. The `src/config.ts` and adapter defaults therefore did not control production while Compose supplied a value.
- **Observed in source:** the restricted release entrypoint accepts ordinary app archives but refuses Compose/database changes, builds an image, waits for idle work, recreates the gateway and checks startup health. It has no general server `.env` editor.
- **User requirement:** future model changes should be versioned, reviewed and released by agents through GitHub; no manual server edit should be needed. This candidate leaves the live model unchanged until another reviewed policy pin selects one.

## Choice and alternatives

We added a small non-secret `config/model-policy.json` to the image. `main: null` preserves the old environment-derived behavior, avoiding an accidental switch during rollout. A non-null model ID overrides that environment value at gateway startup. A later agent changes one reviewed file; existing CI/release logic then installs the rebuilt image. Invalid or missing policy fails startup rather than silently falling back to an unintended model. Provider price ceilings, medium reasoning and OpenRouter credentials remain separately configured and unchanged.

Editing the private server `.env` would switch a model but keep cloud agents dependent on an operator. Editing Compose would require an operator rollout and block ordinary releases. Adding a Telegram `/model` mutation would introduce a separate authorization and rollback path. None is needed for a reviewed deployment-time choice.

## Implementation and verification

- Bundled policy parser and resolver: `src/model-policy.ts`, invoked by `src/main.ts`; Dockerfile copies the policy into the gateway image.
- Tests cover a policy pin winning over an injected environment value, `null` preserving the old value, and rejection of missing/malformed policies. The checked-in file's schema is read during tests.
- [Deployment runbook](../deployment.md#changing-the-production-model-through-a-release) explains the PR, release, post-release model trace and revert path. Cloud instructions and troubleshooting now point to the same source of truth.
- **Tested locally, 23 September:** TypeScript typecheck and focused policy tests passed. Full checks, independent review and production smoke remain to be recorded after the candidate is finalized.

## Limits and next step

Startup health proves the file is present and valid, not that a newly selected OpenRouter model is available to this account under the price/parameter filters. Verify a bounded owner-initiated request and its model/provider trace after every non-null pin. With `main: null`, the effective production model still depends on the private server environment. The separate media model is not mapped through production Compose; this change only selects the main runtime model.

After review, merge and verify the exact release. A future agent can then change the policy value to a verified model ID in its own PR. Do not describe that future switch as completed by this foundation release.
