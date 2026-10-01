# 55 — Behaviour settings in reviewed repo config

Work date(s): 2026-10-02. Written/revised: 2026-10-02.
Status: implemented and tested; not yet deployed. Production behaviour is unchanged by design.

## User-visible problem and preceding iteration

The owner asked how environment values and secrets are configured, and wanted them cleaned up. Non-secret settings, such as model names, should live in repo config, and secrets should live in a proper store.

Production reads one plain `.env` on the Lightsail host (see [the Lightsail runbook](../lightsail.md)). `compose.yaml` passes an explicit list of variables into the gateway, each with a Compose default. Two consequences:

- **Changing a model or a switch needs an operator.** It takes a host edit, or a Compose change plus an operator rollout. For example, `MEDIA_MODEL` and `TELEGRAM_TOPICS` are not passed in production, so setting them in `.env` has no effect. [Journal 32](32-repo-controlled-model.md) had already moved the main-model choice into reviewed config (`config/model-policy.json`). This entry extends that approach to the remaining behaviour settings.
- **Three kinds of configuration share one file:** behaviour settings, personal identifiers and secrets. The repository is public, so identifiers cannot simply move to Git.

## Evidence

- **Inventory, from code:**
  - `src/config.ts` accepts 47 variables; `compose.yaml` passes 44 of them.
  - 24 are behaviour settings, 10 are personal identifiers and 14 are secrets. `DATABASE_URL` counts as a secret because it holds the database password.
  - [Issue #143](https://github.com/akhilvuputuri/chief-agent/issues/143) lists them.
- **Live values not read.** This Mac has no operator SSH, and the agent did not handle the live `.env`.
- **Tested:** `tests/runtime-config.test.ts`:
  - the committed file is valid, complete and equal to the code defaults;
  - file values apply and an environment value wins;
  - overrides are listed by name, with numbers compared after parsing;
  - secrets, identifiers, unknown names, bad types and a wrong schema version are refused;
  - the log line keeps names only.

## Diagnosis and alternatives

- **File wins over the environment.** Rejected. Compose sets every name, so any production value that differs from the default would change behaviour on deploy, and those values were not visible.
- **Environment wins over the file.** Chosen. The gateway logs which names differ (`config.loaded`, `envSettings`). That shows exactly which values the file must take before Compose stops passing them, so the switch changes nothing.
- **Allow-list of names in the file.** The file accepts only behaviour names, so a secret or identifier cannot be committed through it by mistake.
- **Secrets.** The recommendation in #143 is AWS SSM Parameter Store, not GitHub secrets:
  - it matches the existing AWS and IAM pattern used for logs;
  - every read is logged in CloudTrail and values are versioned;
  - rotating a secret needs no SSH;
  - it avoids widening the restricted deploy entrypoint.

  This needs an operator rollout, so it is separate work.

## Implementation and review

- **`config/runtime.json`:** schema version 1, all 24 behaviour settings at their code defaults.
- **`src/config.ts`:**
  - `RUNTIME_SETTINGS` (allow-list) and `readRuntimeSettings()` (strict parse);
  - `readConfig(env, runtime)` merges the two, lets the environment win, and returns `overridden`.
- **`src/main.ts`:** logs `config.loaded` with `envSettings` at startup.
- **`src/ops-log.ts`:** the `envSettings` field keeps only names matching `^[A-Z][A-Z0-9_]{0,63}$`.
- **`Dockerfile`:** copies the file into the image.
- **Docs:** [configuration](../configuration.md).

Independent review: pending.

## Verification and outcome

Typecheck and the full suite pass. After deploy, `config.loaded` in CloudWatch lists the names production overrides. Expected outcome: no behaviour change, and a list of names to align.

## Follow-up and next iteration

- **Align and shrink Compose:** set `config/runtime.json` to production's values for the listed names, then remove the behaviour names from `compose.yaml` (operator rollout).
- **Secret store:** SSM parameters and a read-only IAM user. The owner enters the values with a no-echo script. The host renders `.env` at start.
- **Secrets inventory doc:** names only, covering where each one lives, who can read it, and how to rotate it.
