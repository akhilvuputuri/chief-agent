# 149 — How does a browser that runs hostile scripts stay patched without anyone remembering?

Work date: 2 November 2026. Written: 2 November 2026.
Status: tested with mocks, not installed. Installing it and the first measured run need the owner's approval. See [Pending](#pending).

## User-visible problem and preceding iteration

[Journal 148](148-public-browser-agent.md) made an anonymous browser whose job is to run hostile scripts, so Chromium's security fixes matter. The ordinary release updates only the gateway. `scripts/refresh-public-browser.py` rebuilds, proves and swaps the images, and it passed once on the host, but only when someone runs it. Nothing tells the owner when it is overdue or broken.

## Evidence

**Measured (production, read-only, 2 November):**

- **Disk across the real refresh.** `chief.host/1` lines read 56.6% at 03:43:33 UTC and 62.2% at 03:53:39, on a 58 GB disk, so at most about 3.2 GB. It is an upper bound, because release `5fd0e74` landed in the same window. The refresh ran from 03:44:56 and had finished by 03:50:03, so about 5 minutes.
- **What the images add.** `docker system df -v` gives 1.496 GB and 80 MB unique for the two images, which share 246 MB of base. A build with a new base would share less.
- **Build cache.** 4.73 GB across 68 records were created on 2 November, by the rollout and the refresh together, so the refresh's own share is not separable. Total cache is 7.47 GB, all of it reclaimable.
- **The release already prunes.** `prune()` in `cloud-release.py` runs `docker image prune -f` and `docker builder prune -f --filter until=168h`. After release `ba476ed` at about 04:00, disk fell from 62.2% to 59.9%, and no earlier public browser image remained. `hermes-companion-gateway:rollback` survived that prune.
- **Quiet hours.** Over 30 days, `runtime_runs` shows no activity from 20:00 to 00:59 UTC, and `conversation_inputs` no input from 18:00 to 00:59. Of the last 200 releases, 6 started between 20:00 and 00:59.
- **What a dangling prune cannot reach.** Docker lists 4 dangling images, all held by 5 exited debug containers from 28 October. Digest-pinned images (4 coding, 3 older agentwatch) and tagged ones (old invoice-browser tags, `chief-kite-debug:browser`) are not dangling. So most of the 12.47 GB that Docker calls reclaimable would survive this prune.

**Tested (offline):** `scripts/test-scheduled-refresh-public-browser.py` and additions to `scripts/test-deploy-public-browser.py`, with Docker, Postgres and Telegram mocked. `systemd-analyze verify` passes on the three units on Ubuntu 24.04, in a container with stub files for the script and Docker's unit.

**Not measured:** one refresh on its own, including its cache. Any of this running under systemd, a real Telegram notice, and whether `docker builder prune -af` leaves the images intact on this containerd store. The first `--now` run covers these.

## Diagnosis and alternatives

**There was no rollback image to keep.** The brief asked to keep `:rollback`, but only the gateway and the invoice browser have one. The refresh restored the previous images from their IDs if the swap failed, then left them untagged, and the next release's prune deleted them. So once a refresh finished, a bad Chromium build had no way back but another build. The refresh now tags both images `:rollback` just before the swap. This costs about 1.6 GB of disk held permanently, replaced at each refresh.

| Decision    | Choice                                                 | Rejected                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cadence     | Daily timer that acts when the image is 28 days old    | `OnCalendar=monthly`, because a refused run would wait a month, and a manual refresh would not reset the clock                                                                                                             |
| Refused run | Exit clean and try the next day; a failure from day 35 | `Restart=` within the hour, because it holds the release lock longer and leaves the quiet window. Waiting for idle while holding the lock, because releases would fail meanwhile                                           |
| Busy check  | Also before building                                   | Only at the swap, which wastes a 5-minute build on two CPUs                                                                                                                                                                |
| Notice      | `OnFailure` unit, directly to Telegram                 | Through the gateway, which is one of the things that may be down. Host-health logs, which the owner does not read                                                                                                          |
| Prune       | Dangling images and all build cache, under the lock    | `docker image prune -a`, which would delete digest-pinned coding images and the old tags without review. The release's `until=168h`, which would keep each refresh's cache for a week though `--no-cache` can never use it |
| Time        | 21:00 UTC plus up to 30 minutes, with no `Persistent=` | Catching up after downtime, which could start a build during the day when the next night is soon enough                                                                                                                    |

**A stuck run cannot stay hidden.** A `running` row that never ends would refuse every day. Counting days from the image's build date turns that into a failure on day 35.

**It must not undo a deliberate stop.** The refresh's `up --force-recreate` starts stopped services. A scheduled run could otherwise turn a stopped browser back on, so it skips when the flag is off and refuses, with a notice, when the flag is on but the service is down.

**The one remaining interruption.** While the refresh holds the lock, a release fails with `[Errno 11]` and must be rerun, as already happened during the rollout. The chosen hours make this rare, at 6 of 200 recent releases, each with about a 5-minute window once a month.

## Implementation and review

- [`scripts/scheduled-refresh-public-browser.py`](../../scripts/scheduled-refresh-public-browser.py): the decision, prune and notice.
- [`scripts/refresh-public-browser.py`](../../scripts/refresh-public-browser.py): `Busy` separates a refusal from a failure, and the `:rollback` tags.
- `deploy/lightsail/chief-public-browser-refresh{.service,.timer}` and `-notify.service`, also added to `install-host.sh` for a rebuilt host.
- [Public browser: on a schedule](../public-browser.md#on-a-schedule) holds the behaviour, install and rollback steps.

**Review.** Independent review (Claude Opus 5.5) requested changes on `8f8e0ff`. It found no path for the bot token to leak, and Busy could not hide a real failure. Found and fixed:

- **Damaged state stopped everything.** A state file holding valid JSON that was not an object crashed both the run and its notice, every day and silently. That is the very failure this design exists to prevent. Damaged state now reads as empty.
- **Daily figures defeated the weekly limit.** Reasons included the day count and free GB, so they differed each day, and a stuck `running` row would have messaged the owner daily for ever. Reasons no longer hold figures.
- **Stale reasons.** A failed state write or a run that never started could repeat yesterday's reason, or have it withheld. Failures now carry a time, and one over 6 hours old reads as an unfinished run.
- **Age came from the tag.** A swap killed halfway left a new tag on an old browser, which would then read as not due for 28 days. Age now comes from the running container, and a stopped browser is reported even when not due.
- **Smaller fixes.** A mistyped flag started a real run. The flag parser was stricter than Compose. A failed notice got one attempt, and now retries.

Accepted, as low risk: after a swap killed halfway, the next refresh tags the never-run image `:rollback`, not the one that was running. A tick landing during a release's copy of `scripts/` can fail, and its notice retries once the script is back; 6 of 200 recent releases started in these hours. Alternating failures past day 35 can send a notice daily, since only the last reason is remembered.

The delta review approved `3d7ec13`; its remaining items were low severity. The only later change corrects these docs.

## Verification and outcome

Offline tests pass. Nothing is installed, and no behaviour on the host has changed, apart from `:rollback` tags on the next manual refresh.

## Pending

Each step needs the owner's approval:

1. Install the units and send the test notice ([steps](../public-browser.md#on-a-schedule)).
2. Run one `--now` refresh in the unit's environment, which gives the real disk figures, and proves the build, prune and images under systemd:

   ```bash
   sudo systemd-run --wait --pipe --collect -p Environment=HOME=/root -p UMask=0077 python3 /opt/hermes-companion/scripts/scheduled-refresh-public-browser.py --now
   ```

3. Start both kept images without a network, because `docker image inspect` would not show that the prune left their blobs intact:

   ```bash
   sudo docker run --rm --network=none --read-only --cap-drop=ALL --entrypoint chromium chief-public-browser:rollback --version
   ```

   ```bash
   sudo docker run --rm --network=none --read-only --cap-drop=ALL --entrypoint node chief-public-browser-proxy:rollback --version
   ```

4. Record the figures and this entry's release closure.

## Follow-up and next iteration

- About 12 GB of old tagged and digest-pinned images, and 5 exited debug containers, need a separate reviewed cleanup. Disk is at 60%, so it is not urgent.
- The invoice browser was last built on 8 October and has no refresh. It handles invoice logins, so whether it needs the same treatment is worth its own decision.
- A merge that changes what these images hold still needs a manual refresh. The timer goes only by age.
- If the timer stops or Telegram is unreachable, nothing tells the owner. The host-health line could report the image's age if that ever matters.
