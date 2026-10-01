# Configuration and secrets

Issue [#143](https://github.com/akhilvuputuri/chief-agent/issues/143) separates three kinds of configuration that used to share the production `.env`:

| Kind                 | Where it lives                                                        | Examples                                                                                             |
| -------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Behaviour settings   | `config/runtime.json`, reviewed in PRs and shipped by normal releases | models, budgets, price caps, feature switches, voice providers and models                            |
| Personal identifiers | Private environment (the repository is public)                        | allowed Telegram IDs, owner IDs, email addresses, spreadsheet IDs, Mini App origin                   |
| Secrets              | Private environment today; a secret store is planned (#143)           | bot token, API keys, Google client secret and refresh tokens, `LIBRARY_IDENTITY_KEY`, `DATABASE_URL` |

Other reviewed policy files already in the repo:

- `config/model-policy.json`: main and agent models. A pinned main model wins over `AGENT_MODEL`.
- `config/tool-picker.json`: the Jev domain picker.
- `config/decisions.json`: the shadow decisions.

## `config/runtime.json`

```json
{ "schemaVersion": 1, "settings": { "MEDIA_MODEL": "", "VOICE_REPLIES": "false", … } }
```

- **Only behaviour settings are accepted.** `settings` takes only the names in `RUNTIME_SETTINGS` (`src/config.ts`). Any other name is rejected when the file is read, so a secret or identifier cannot be committed through this file. Examples: `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`, `GMAIL_EMAIL`, or a typo.
- **Same validation as the environment.** Values go through the same schema as environment values, so an invalid value fails startup. The release health check then restores the previous image. A test checks the committed file.
- **The committed file mirrors the code defaults** and lists every setting, so it is the full record.

### Precedence during the move

An environment value still wins over the file.

- **Passed by Compose (20 names):** production's Compose file passes these with Compose defaults, so the file cannot change them in production until Compose stops passing them. That step is part of the operator rollout in #143.
- **Not passed (`MEDIA_MODEL`, `TOOL_PICKER`, `TELEGRAM_TOPICS`, `PORT`):** the file is already authoritative in production. Editing them in a PR changes production on the next release, with no operator step.

To make the switch safe:

- At startup the gateway logs `config.loaded` with `envSettings`: the names, never the values, of settings whose environment value differs from the file.
- Before Compose stops passing these names, update `config/runtime.json` to production's current values for exactly those names. Then the switch changes nothing.
- When `envSettings` is empty after the switch, the file is authoritative.

To change a behaviour setting today, edit `config/runtime.json` in a PR. It takes effect in production on the next release for the four names above. For the others, it takes effect once Compose stops passing them; until then the production `.env` value wins.

Locally, a `.env` line that sets a behaviour name, even to an empty value, overrides the file. Delete such lines rather than leaving them empty. `config.loaded` lists them.

```sh
AWS_PROFILE=chief-logs npm run logs:cloudwatch -- event --event config.loaded --since 2h
```

## Next steps (#143)

1. **Done in this PR:** `config/runtime.json` and the override log.
2. **Align and shrink Compose:** align the file with production's overridden values, then remove the behaviour names from `compose.yaml`. This is a reviewed operator rollout.
3. **Secret store:** secrets and identifiers move to AWS SSM Parameter Store under `/chief/prod/`. The host renders `.env` from it at start, using a read-only IAM user. The old `.env` stays as a fallback for one verified release.
