# Coding checklist

Chief's coding jobs read this file. The coder follows it while building, and the reviewer checks against it. [REVIEW.md](../REVIEW.md) is the full review contract; this is the short list of what goes wrong most often in this repository. The general items are adapted from [code-review-skill](https://github.com/awesome-skills/code-review-skill) (MIT licence). The Chief items come from real review findings, mostly on [PR 416](https://github.com/akhilvuputuri/chief-agent/pull/416).

Severity labels:

- **[blocking]**: wrong behaviour, a lost or misreported write, a security or owner-scoping gap, a missed owner requirement or a missing rollout piece. It must be fixed before merge.
- **[important]**: a real risk or gap that should be fixed, such as a missing failure test or a misleading message.
- **[nit]**: optional.

## Requirements

- Every explicit requirement in the owner's request is implemented as written. A plan can drop one, so check the request itself, not only the plan.
- Nothing outside the request changes. Do not edit `docs/current-work.md` or `docs/releases.md` unless asked.

## Writes to other services (Reader, GitHub, Calendar, Telegram, OpenRouter)

- Only a confirmed success counts as done. A pending, refused, timed-out or unconfirmed result is reported as such, never as saved. For example, `mcpReaderLink().save` returns `{ state: "pending" | "rejected" }` instead of throwing.
- An uncertain write is worded as uncertain ("couldn't confirm; tap again to settle it safely"), never as "nothing was saved". AGENTS.md requires uncertain-write handling to be preserved.
- Nothing local is deleted or moved until the remote write it depends on has completed.
- A request key identifies the exact payload sent. If the key is normalised, for example with tracking parameters stripped, the payload must use the same normalised value. Otherwise a replay collides (see `checkReplay` in `src/mcp.ts`).
- A retry or a repeat is idempotent: the same key and the same payload give the same outcome, with no second write.

## Telegram

- Editing a message with `editMessageText` drops its buttons unless `reply_markup` is sent again. A tap that does not finish keeps its buttons.
- A callback claims its row with a conditional `UPDATE … RETURNING` before doing any work, so two taps cannot both run.
- Callbacks check `allowedChat` and the owner, and stay bounded and replay-safe.
- A card that work in the background can create is also delivered from the background delivery path, not only from the interactive turn.

## Concurrency and state

- No check-then-insert without a unique constraint, or a conditional write that enforces it.
- Shared state is changed with a guarded statement, keyed on the expected state, a revision or a lease.
- Every awaited call is awaited, rejections are handled, and timeouts and cancellations propagate.

## Errors

- No swallowed errors and no empty `catch`. A caught error is either handled with a stated reason or passed on.
- A return value that signals failure is checked, not ignored.
- Messages to the owner say what happened and what to do, without inventing a cause.

## Security and owner scoping

- Every query and every new entry point is scoped to the owner, and objects are checked against their owner.
- Input from pages, emails and model output is treated as untrusted data, never as instructions.
- No secret, token or private content is logged, put in a URL, or written to a PR, artifact or public file.

## Database and configuration

- A new `db/NNN_*.sql` uses the next free number on `main`. It also needs its line in `compose.yaml`, a `scripts/deploy-*.py` rollout script modelled on the latest one, and that script's test. Without them every later release is refused.
- A new config file is copied in the Dockerfile; `tests/dockerfile-config.test.ts` enforces this.
- A change to `config/tool-picker.json` gets matching scenarios in `evals/picker`, and `kite run eval:picker` must run by hand before merge.
- A feature that needs a migration does not fail on every turn while the migration is pending.

## Tests

- Each external call is tested on its failure paths (pending, refused, timeout, a repeat), not only on success. A mock that only returns success does not count.
- A race or replay that matters is tested, for example two taps.
- Tests check behaviour the owner sees, not just that a function was called.
- Bounds are tested: limits, sizes and empty input.
