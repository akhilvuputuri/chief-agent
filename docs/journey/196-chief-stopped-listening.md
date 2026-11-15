# 196 — Why could Chief stop hearing Telegram without saying so?

Work date: 2026-11-15 (UTC). Written: 2026-11-15.
Status: tested on fakes; not released. Branch `telegram-polling-deaf`. Which failure started the 12–15 November outage, and how long the gateway was not polling, were not measured.

## User-visible problem and preceding iteration

The owner messaged Chief over several days and got no reply. Chief recorded no incoming Telegram message between 12 November 14:44 and 15 November 15:55:42 UTC, while the gateway looked healthy, sent its daily feed and logged nothing but heartbeats. At 15:55:42 four messages arrived in one batch and were answered within 35 seconds. Telegram keeps an undelivered update for 24 hours, so whatever the owner sent more than a day before polling resumed was lost, and Chief never said that it had not been listening.

Intake has used `@grammyjs/runner` long polling since the owned runtime replaced Hermes (`f1664bb5`). [Journal 125](125-db-drops-and-shutdown.md) read the runner's loop for shutdown and [journal 86](86-news-reader-saves.md) found a button press holding a runner slot for about 90 seconds; neither looked at what the runner does when `getUpdates` fails.

## Evidence

- **Measured on production, 15 November 2026 (the orchestrator's read-only investigation; times UTC):**
  - No `telegram.input_received` from 12 November 14:44 to 15 November 15:55:42; four messages then arrived in one batch and were answered within 35 seconds. Receiving has worked since.
  - Throughout, the gateway was healthy, its daily outgoing feed was sent and its logs held heartbeats and no error line. The gateway process had been up since 13 November 12:31.
  - During the investigation: one active long-poll connection to Telegram, a valid token, no webhook, one gateway, the owner on the allow-list. Of about sixty short calls from the gateway container to `api.telegram.org`, two failed with a network error a minute apart; twelve in a row succeeded a few minutes later.
  - Not measured: when polling stopped or resumed, which error started it, how many `getUpdates` calls failed, and when the four late messages were sent. Nothing about polling was logged, and the send time of a message was not stored.
- **Read in the code (`origin/main` at `ae551f33`; `@grammyjs/runner` 2.0.3, grammY 1.46.0):**
  - `src/main.ts` started polling with `run(bot, { runner: { silent: true, fetch: { allowed_updates } }, sink: { concurrency: 8 } })`, so the runner's defaults applied to everything else.
  - `createUpdateFetcher` (`out/runner.js`): `retryInterval` defaults to `"exponential"`: after a failed `getUpdates` it waits 100 ms and doubles the wait after every consecutive failure, so each wait is about as long as all the failing so far. `maxRetryTime` defaults to 15 hours, after which the fetch throws. A 401 or 409 throws at once. With `silent: true` none of this is printed. A single success resets the wait.
  - `createRunner`: a throw from the fetch is rethrown from the loop's promise (`task`), which the library does not await and Chief did not watch.
  - `src/process-guard.ts`, imported first by `main.ts`, turns an unhandled rejection into one `process.unhandled_rejection` log line and `process.exit(1)`; Compose restarts the gateway (`restart: unless-stopped`). So in our process an ended loop is a logged crash and a restart, not a live process that stays deaf (see Diagnosis).
  - grammY's client times out any call after `timeoutSeconds`, 500 s by default, for `getUpdates` too, whose long poll is 30 s.
  - The sink (`createConcurrentSink`, `DecayingDeque`) has no task timeout here. The message handler in `src/telegram.ts` awaits the whole turn and its delivery, so eight updates still being handled stop `getUpdates` until one finishes, with no error and no log.
  - `/healthz` returned a constant `{status:"ok"}`. `gateway.heartbeat` logged uptime and memory only. Nothing watched that updates were being fetched. The Compose healthcheck only fetches `/healthz`, nothing restarts an unhealthy container, and `scripts/cloud-release.py` requires `/healthz` 200 and Compose `healthy` within about a minute or rolls the release back.

## Diagnosis and alternatives

**Confirmed in code:** after a run of failed `getUpdates` calls the runner sleeps for about as long as it has already been failing, and it does so silently. With 100 ms doubling, the sleep in progress twenty minutes into an outage began at about 13.7 minutes and ends at about 27.3 minutes, so polling resumes by about 27 minutes after the failures began, up to about 7 minutes after Telegram is back; after a two-hour outage it resumes by about 3.6 hours after the failures began. (Corrected 16 November 2026: the earlier wording here, that a twenty-minute outage is followed by a sleep of up to about twenty-seven minutes and a two-hour outage by up to about three and a half hours, was wrong when written.) The longest single sleep before the 15-hour limit is about 7.3 hours, and the series sleeps about 14.6 hours in all before it throws. Telegram becoming reachable again does not end a sleep. For a single always-on personal bot these defaults are wrong: one bot makes one `getUpdates` call at a time, so retrying every few seconds costs Telegram nothing, while every minute of backoff is a minute in which the owner is not heard. Giving up after 15 hours, or on a 409, assumes a supervisor that restarts the bot; ours would only restart through a crash.

**Not measured:** which failure started this outage and how long the gateway was not polling. What the evidence allows:

- Fifty-one hours without a recorded message is not fifty-one hours without polling. A poll that returns nothing is not recorded, and only messages from the last 24 hours could still arrive.
- A loop that ended by a throw (401, 409, 15 hours of failures) would have crashed the process with an error line and a restart. The investigated logs showed no error, so within that window the loop probably did not end that way (inferred). Whether the start at 13 November 12:31 was a release or a crash restart was not checked; the host log around that time (`process.unhandled_rejection`) would say. This contradicts the brief's reading that polling stops for the life of the process: with `process-guard` it stops for the life of the process only because the process ends.
- Inside one process, two paths leave the gateway deaf and silent: the backoff sleeps above (up to about 14.6 hours per failure series), and a full sink (eight updates still being handled). The two failed calls out of sixty suggest intermittent network trouble from the container, which fits the first (hypothesis). Nothing recorded rules out the second; the heartbeat did not carry the handler count.
- A hung connection alone cannot explain it: grammY abandons the call after 500 s and the runner retries. Each hang still costs up to about eight minutes and counts as a failure for the backoff.

**Additions of ours, not fixes for this outage.** The cause in code of the 15 November outage, as far as the code shows it, is the doubling waits with silent mode; the steady `retryInterval`, `maxRetryTime: Infinity` and the logging address that. Two further changes below are additions:

- The 60-second limit on each `getUpdates` call corrects a grammY default (500 s) meant for uploads, which does not fit a 30-second long poll: a dead connection would otherwise go unnoticed for about eight minutes.
- The in-process restart of an ended loop keeps in-flight turns and the update offset alive, where the previous behaviour was a logged exit (`process-guard`) and a container restart.

Neither was observed in, or explains, the 15 November outage.

**Alternatives considered.** Wrapping the runner in our own retry loop, or replacing it with grammY's built-in `bot.start()`, would add code around a library that does the right thing once configured. Raising the sink's concurrency or adding a sink timeout would hide whatever holds a handler; that is a separate cause and needs its own evidence first.

**Health.** A gateway that has not completed a poll for minutes is not healthy for its purpose, but `/healthz` is read by the Compose healthcheck and the release script, and nothing restarts an unhealthy container. Failing `/healthz` on a stale poll would restart nothing and would make releases impossible during a Telegram-side outage, including a release that fixes the problem. So `/healthz` stays 200 and reports intake under `telegram`; it fails (503) only when Telegram rejects the bot token (401), a fault on our side that no wait or restart fixes and that a release should not hide. The owner is told about an outage through the existing owner notice (`notifyOwner`, a Telegram `sendMessage`). That depends on Telegram, but in this incident sending kept working while receiving did not, so it would have reached the owner. No channel outside Telegram exists today (agentwatch's alerts are also delivered on Telegram; CloudWatch is read on demand), and adding one was out of scope; for a rejected token or a full Telegram outage the heartbeat and `/healthz` fields are the record.

## Implementation and review

[src/telegram-polling.ts](../../src/telegram-polling.ts) (`startPolling`), called from [src/main.ts](../../src/main.ts) in place of `run(...)`:

- **Runner options.** `retryInterval: 5000` (a number gives a constant wait), `maxRetryTime: Infinity` (never gives up), `silent: true` kept (the library prints whole error objects; failures are logged here without their text), `fetch: { allowed_updates, timeout: 30 }`, `sink: { concurrency: 8 }` unchanged.
- **Ended loop.** The runner's `task()` promise is watched. When it ends while Chief is not stopping (a 401, a 409, any throw, or an unexpected normal end) the gateway logs `telegram.polling_stopped`, waits the same 5 s and restarts the loop with `stop()` then `start()` on the same handle. That keeps the fetcher, so its update offset survives, and keeps the sink with its running handlers. A 409 (another poller) and a 401 (wrong token) are retried at the same steady pace; the state says which. The rejection is now handled, so it no longer reaches `process-guard`.
- **getUpdates outcomes.** A grammY API transformer sees every `getUpdates`: success, a Telegram error response (`error_code`) or a thrown network error. It also gives each call its own 60 s ceiling (30 s long poll plus 30 s), because grammY's 500 s timeout is sized for uploads and a dead long poll otherwise deafens Chief for eight minutes. Logged: `telegram.poll_failed` on the first failure and at most every 10 minutes while the outage lasts, `telegram.poll_recovered` with how long (`outageS`, to the start of the first answered call) and how many attempts, `telegram.poll_stale` once when no call has been answered for 10 minutes, `telegram.polling_restarted`. Fields are the fixed `kind`, `httpStatus`, counts and `errorFields` (class names, a system error code, code locations). grammY's `HttpError` keeps the network error on `.error`, which `errorFields` does not read, so its class and code are added. Never logged: the token, the URL, Telegram's description or anything from an update.
- **Heartbeat and health.** `gateway.heartbeat` adds `state`, `lastPollAgeS`, `pollFailures` and `handlersRunning` ([src/server.ts](../../src/server.ts) reports the same under `telegram` in `/healthz`, as above). `handlersRunning` at 8 with a rising `lastPollAgeS` would identify the full-sink path.
- **Owner lines.** After 10 minutes without an answered poll, one line: "I have not received any Telegram messages for 10 minutes because Telegram could not be reached. I keep trying every 5 seconds and will tell you when messages come through again." (the reason names another program using the token, a rejected token, or messages still being handled when that is the cause). On the first answered poll after it, one line saying for about how long and since when Chief was not receiving, that messages from that time are arriving now, and that anything sent more than 24 hours earlier was not kept by Telegram and should be sent again. Each is sent once per outage.
- **Send time.** The message handler stores `sentAt` (Telegram's `message.date`) beside `receivedAt` in the input metadata, and `telegram.input_received` carries `delayS`, the seconds between them. No message text is logged.

Not reviewed independently yet.

## Verification and outcome

- [tests/telegram-polling.test.ts](../../tests/telegram-polling.test.ts), with grammY's `Bot`, a fake Bot API behind `bot.api.config.use` and node's mock timers:
  - `getUpdates` failing for one minute and for three hours: the first call after the network returns comes within 5 s in both. With `retryInterval: "exponential"` restored (checked by hand) the one-minute case had not recovered a minute later.
  - Failure lines: at most one per 10 minutes of outage; recovery line with the outage length and attempt count.
  - Owner lines: none for a one-minute outage; exactly two (outage, recovery) for a three-hour one; none for a later 30 s blip.
  - A 409 for 20 minutes: loop ended and restarted about every 5 s (at least 200 calls), `conflict` state, the owner told another program is using the token, at most four stop lines.
  - A 401: polling keeps retrying, state `unauthorized`, `/healthz` 503. A network outage: `/healthz` 200 with `telegram.state: "stale"`.
  - Heartbeat fields through starting, polling, failing, stale and back.
  - A loop ended by a 409 restarts with the same offset (calls 0, 3, 3, 4), so updates 1–3 are each handled once.
  - Through the real `telegram()` handler on PGlite: a loop restart after which Telegram sends update 1 again is still handled once (`inbound_updates`), two turns for two messages, and `sentAt` is stored.
  - No logged line contains the token, `api.telegram.org`, Telegram's error text or message content.
- Root `kite run check` and `kite run format:check`: see the release record when merged; both passed on this branch before commit.
- Not verified: behaviour against the real Telegram API, a real network outage, or the production host.

## Follow-up and next iteration

- Release, then read `telegram.state` and `lastPollAgeS` in the first heartbeats.
- Check the host log around 13 November 12:31 UTC for `process.unhandled_rejection`, to tell a crash restart from a release.
- The outage clock lives in the process: a restart during an outage starts it again, and the late-delivery line is not sent for time before the restart. `delayS` on the first messages after a restart still shows it.
- If `handlersRunning` is seen at 8 with a stale poll, the cause is a handler holding its slot for a whole turn; the fix then is to finish turns outside the runner's slots, as journal 86 did for Reader saves, not a larger concurrency.
- An owner alert that does not depend on Telegram, if a full Telegram outage or a revoked token ever needs one.
