# 32 — Repo-controlled model releases

Work date: 23 September 2026. Status: released in v0.3.23; no model switch or future-model provider acceptance was attempted.

## Problem and preceding iteration

The main model was configurable through `AGENT_MODEL`, but production Compose injected it from a private server `.env` or its own 5.6 fallback. A cloud coding agent could change the TypeScript default and deploy successfully without changing the effective live model. The owner wanted other coding agents to propose a model change as a reviewed repository edit and let the shared release pipeline apply it, without repeated server access.

The [cloud development path](05-cloud-development.md) already deploys ordinary application changes and deliberately refuses Compose/database edits. This issue was a configuration ownership gap, not a need for a new deployment service.

## Evidence and diagnosis

- **Observed in source, 23 September:** `compose.yaml` passes `AGENT_MODEL: ${AGENT_MODEL:-openai/gpt-5.6-sol}` to the gateway, and `src/main.ts` previously passed that value to `OpenRouter`. The `src/config.ts` and adapter defaults therefore did not control production while Compose supplied a value.
- **Observed in source:** the restricted release entrypoint accepts ordinary app archives but refuses Compose/database changes, builds an image, waits for idle work, recreates the gateway and checks startup health. It has no general server `.env` editor.
- **User requirement:** future model changes should be versioned, reviewed and released by agents through GitHub; no manual server edit should be needed. This foundation release leaves the live model unchanged until another reviewed policy pin selects one.

## Choice and alternatives

We added a small non-secret `config/model-policy.json` to the image. `main: null` preserves the old environment-derived behavior, avoiding an accidental switch during rollout. A non-null model ID overrides that environment value at gateway startup. A later agent changes one reviewed file; existing CI/release logic then installs the rebuilt image. Invalid or missing policy fails startup rather than silently falling back to an unintended model. Provider price ceilings, medium reasoning and OpenRouter credentials remain separately configured and unchanged.

Editing the private server `.env` would switch a model but keep cloud agents dependent on an operator. Editing Compose would require an operator rollout and block ordinary releases. Adding a Telegram `/model` mutation would introduce a separate authorization and rollback path. None is needed for a reviewed deployment-time choice.

## Implementation and verification

- Bundled policy parser and resolver: `src/model-policy.ts`, invoked by `src/main.ts`; Dockerfile copies the policy into the gateway image.
- Tests cover a policy pin winning over an injected environment value, `null` preserving the old value, and rejection of missing/malformed policies. The checked-in file's schema is read during tests.
- [Deployment runbook](../deployment.md#changing-the-production-model-through-a-release) explains the PR, release, post-release model trace and revert path. Cloud instructions and troubleshooting now point to the same source of truth.
- **Tested locally, 23 September:** full `npm run check` passed after rebasing over concurrent Calendar and watchlist changes (350 application tests, 10 script tests), as did `npm run format:check`, `git diff --check`, and a compiled-path policy read. Docker was unavailable in the local checkout.

### Release closure — 23 September 2026

[PR #82](https://github.com/akhilvuputuri/chief-agent/pull/82) passed two exact-head CI runs and Devin Review. An independent GPT-6 Astra reviewer approved final head `29af674cd4a171a80abb9e9d3fa5974faeaf6cbb` against main `7648fca`, after a documentation finding about Calendar pre-send errors was fixed and re-reviewed. The PR merged as `798439fe1e762278113e5ce49f0b0ddf0d0b3c6a`.

The first release attempt was superseded when a concurrent documentation PR advanced main; the guard refused to deploy the stale SHA. The next current-main [release workflow](https://github.com/akhilvuputuri/chief-agent/actions/runs/35870399160) deployed `b22b09d0abca93bc6551468d0ad50ca68551f102` (which contains PR #82), reported `healthy: true`, and produced a successful exact-commit receipt. A subsequent bounded [production diagnostics run](https://github.com/akhilvuputuri/chief-agent/actions/runs/35871182944) reported the same server `RELEASE`. The immutable [v0.3.23](https://github.com/akhilvuputuri/chief-agent/releases/tag/v0.3.23) tag resolves to that verified SHA. These checks prove installation and startup health, not semantic quality or availability of a future pinned model.

## Limits and next step

Startup health proves the file is present and valid, not that a newly selected OpenRouter model is available to this account under the price/parameter filters. Verify a bounded owner-initiated request and its model/provider trace after every non-null pin. With `main: null`, the effective production model still depends on the private server environment. The separate media model is not mapped through production Compose; this change only selects the main runtime model.

A future agent can now change the policy value to a verified model ID in its own PR. Do not describe that future switch as completed by this foundation release.
