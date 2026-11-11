# Public browser agent

Chief can delegate to `browser`, an agent with a real, anonymous Chromium for public websites that `web_read` cannot handle: pages that need JavaScript, clicks, search forms, filters or several steps. It runs [`agent-browser`](https://github.com/vercel-labs/agent-browser) v0.39.1, pinned by SHA-256 in `tools/agent-browser.json`. The history and test results are in [journal 148](journey/148-public-browser-agent.md).

It is off unless `PUBLIC_BROWSER=on` and its services are installed ([rollout](#rollout)). Logged-in browsing is separate work and does not exist here. Invoice browsing keeps its own stricter service ([gathering](gathering.md#browser-boundary)).

## Why it can be open

The browser can go anywhere public and run any script a task needs, because it has nothing to lose. A malicious page can tell the model to do anything. So what the model can reach decides the damage, and this agent reaches nothing private:

- **One tool.** `core/browser` holds only `public_browser` and the report tool. It has no `source_read`, `observation_read`, memory, email or skills. `PluginRegistry` refuses any other agent, tool or skill alongside `public_browser` at startup, so a registry edit cannot combine them.
- **Empty context.** Like every agent, it gets no history or memories. A brief that names a stored source or result passes only the ID, which it cannot open.
- **Never on Chief's own run.** `PublicBrowser.act` checks the run's `agent.child_started` record, so direct mode cannot reach it either. `delegated` also withholds the tool from Chief.
- **Nothing kept.** Each run gets a new Chromium with a new profile. No logins, cookies or files survive it.

**What this does not cover.** Whatever Chief writes in the brief reaches the model, and a page could get it sent somewhere. The catalogue description and the agent's instructions say to keep private details out, but no check enforces that. Every browser result is marked untrusted for the agent, but its report is still text the coordinator reads, so a page could steer what Chief does next. A hijacked agent also acts from this host's public address, which sites can see.

## Confinement

| Boundary         | How                                                                                                                | Proved by                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network          | Container only on the internal `public-browser-control` network, with its own proxy                                | No direct route; decoy service got no request                                                                                                                                                                  |
| Destinations     | Public HTTPS only, port 443, resolved and pinned by the same proxy code as invoices                                | In CI, a decoy on a private address listening on 443 gets no connection through a dotted name. Everywhere, HTTPS to metadata, loopback and private addresses does not load, and `publicAddress` has unit tests |
| Chromium sandbox | Launched by the service with the sandbox on; `agent-browser` only attaches                                         | No `--no-sandbox`; renderer has a seccomp filter and its own PID namespace                                                                                                                                     |
| Loopback         | `--proxy-bypass-list=<-loopback>` sends even loopback through the proxy, so a page cannot reach the debugging port | Navigating to the real debugging port returns only the proxy's refusal                                                                                                                                         |
| Container        | Read-only root, `cap_drop: ALL`, `no-new-privileges`, the reviewed seccomp profile, 640 MB, 1 CPU, 512 PIDs        | Compose test and rollout checks                                                                                                                                                                                |
| Control          | HMAC-signed requests with replay protection, on a key separate from invoices                                       | Same scheme as the invoice service                                                                                                                                                                             |
| Environment      | Browser processes get a fixed environment without the control key                                                  | Probe reads `/proc/<pid>/environ`                                                                                                                                                                              |

`agent-browser` adds `--no-sandbox` itself when it launches Chromium in a container, which is why the service launches Chromium and passes `--cdp`. Do not switch to its launcher.

The model reaches a typed command list (`src/public-browser/commands.ts`): `open`, `snapshot`, `read`, `click`, `fill`, `press`, `scroll`, `back`, `wait`, `eval` and `close`. Its cookie, state, auth, upload, download, plugin and `read` commands are not reachable. Its own `read` fetches outside the browser, so it would bypass the proxy; ours evaluates `innerText` in the page. Values are argv entries, never shell text. Scripts go through `eval -b`, and `fill` refuses text starting with `-`, because `agent-browser` reads a known flag there as an option and types a `--` separator literally. `eval` can set such a value.

`scripts/public-browser-probe.mjs` checks this from inside the real image through the real engine. CI runs it on x86-64 with a decoy service whose log must stay empty, which is the check that can fail if the proxy's policy breaks. The rollout and the refresh run it on the host, without the decoy, and refuse if it fails. Those host runs check Chromium, the sandbox and the plain HTTP refusals. They would not catch a broken HTTPS policy, which only the decoy's log does: tested against a proxy with no policy, the probe failed and the decoy logged 12 connections, while the HTTPS "did not load" checks still passed.

## How a session works

- **One at a time.** The host has about 850 MB free, so a second run gets a "busy" error and the agent reports it.
- **Lifetime.** One session per child run. It ends when the agent finishes (`releaseAgent`), after 3 idle minutes, or after 10 minutes in all.
- **Cleanup fails closed.** Closing kills Chromium's process group and `agent-browser`'s daemon, which runs in its own session, waits until they are gone and deletes the session directory. If any of that fails, the service exits and the restart policy gives a clean process.
- **Limits.** 180 seconds, 12 model calls and 40 tool calls per run, the most the plugin schema allows.
- **Evidence.** `read` stores the page as an owner `research_source` and returns 8,000 characters at a time, with `nextOffset`. The address is `location.href`, which a page cannot redefine, read before and after the text, and the read is refused if it changed or is not HTTPS. After any `eval` in the session, `read` returns text with no `sourceId`, because a script could have rewritten the page. A hostile site can still say what it likes about itself, and `fill` on an editable element or a reflected search term can change page text, as a URL can with `web_read`. A checked quote proves the page showed it, not that it is true.
- **Classification.** `public_browser` is a read operation, because it acts only anonymously and an unknown outcome must not stop the owner's writes. The loop's read assumptions do not all hold, so it is excepted from three: it is never retried, because its error text is page-controlled and the call may be a click; a success clears earlier refusals, because pages change; and repeat-failure counting is per command.

> **Update, 11 November 2026 ([journal 163](journey/163-browser-errors-reach-the-agent.md)):** a refused command reaches the agent as `BROWSER_REFUSED`, with the browser's reason cut to 300 characters and marked as coming from the browser and the page. Before this, the gateway turned it into the generic `TOOL_FAILED`, so the agent never saw why a click failed.

The agent's instructions also stop it at login walls, CAPTCHAs and payment steps, and from posting, sending, booking or buying. That is guidance, not a host check.

## What it will not do

- **Blocked sites stay blocked.** There is no anti-detection. In the test, Reddit answered with a login page and a JavaScript challenge, and Reuters returned an empty page. This host's address may also be treated differently from a home connection.
- **HTTP and other ports fail**, because the proxy allows only port 443.
- **Long pages.** `snapshot` is cut at 8,000 characters, so elements past that have no usable ref. `eval` can reach them but gives up the `sourceId`.
- **No screenshots.** Tool results carry text only, so the agent cannot see images.

## Rollout

The Compose change needs the reviewed operator procedure: the ordinary release refuses it, and every later release from any session stays refused until it runs. So merge only when the rollout can run straight after.

1. Set `BASE` in `scripts/deploy-public-browser.py` to the live `RELEASE`, with a delta review, just before merging.
2. After merging, upload a `git archive` of the merged SHA and run the script on the host as root.
3. The script checks that Compose differs only by the reviewed additions, builds the images, writes `PUBLIC_BROWSER_KEY` and the flag, starts the two services, runs the probe, checks again that nothing is running, recreates the gateway and writes `RELEASE`. The gateway reads the flag only when recreated, so the agent stays off until the probe has passed. A failure restores the previous state with the agent off, or says the rollback needs inspection. It does not touch the invoice browser or its proxy.

4. Make one real browser task afterwards. No model has received this tool's schema yet, so this is the first proof a provider accepts it.

## Keeping it current

This browser's job is to run hostile scripts, so Chromium's security fixes matter, and the ordinary release updates only the gateway. Run `scripts/refresh-public-browser.py` on the host as root:

- **Monthly**, and promptly after a Chromium security advisory.
- **After merging any change** to `src/public-browser/`, `src/browser/proxy.ts`, `src/browser/policy.ts`, `src/security.ts`, `Dockerfile.browser`, `tools/agent-browser.json`, `scripts/public-browser-probe.mjs` or production dependencies. Until then the gateway and the running service can disagree, and the only symptom is "Invalid browser command".

It rebuilds both images under candidate tags with a fresh base and no layer cache, and proves them in throwaway containers that share nothing with the live browser. Only then does it check for idle work, tag the running images `:rollback` and swap, restoring the previous images if the swap fails. A failed proof or a busy host leaves the running browser untouched. It holds the release lock throughout, so a release during its builds is refused as busy; retry it afterwards. Run it under `tmux`, though it removes what a killed run left behind. It prints the Chromium version. To see how old the running image is, run `docker image inspect --format '{{.Created}}' chief-public-browser`.

### On a schedule

`chief-public-browser-refresh.timer` runs `scripts/scheduled-refresh-public-browser.py` daily between 21:00 and 21:30 UTC, the middle of a window with no work in the 30 days measured ([journal 149](journey/149-scheduled-browser-refresh.md)). Nothing happens until the image the browser is running is 28 days old, so a manual refresh also resets the clock, and there is no schedule state to drift.

| Situation                                    | What the run does                                                                | Owner told?               |
| -------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------- |
| `PUBLIC_BROWSER` is not `on`                 | Nothing, whatever the age                                                        | No                        |
| Image under 28 days old                      | Nothing                                                                          | No                        |
| Busy: running work, queued input or the lock | Tries again the next day. Checked before building, so this usually costs nothing | From day 35, as a failure |
| Flag on but the browser not running          | Refuses, because a refresh would start a service someone may have stopped        | Yes                       |
| Under 8 GB free                              | Prunes, then refuses if still short                                              | Yes                       |
| Build, proof or swap fails                   | Tries again the next day. The swap failure restores the previous images          | Yes                       |
| Script killed or past its 30-minute limit    | systemd's `OnFailure` still fires                                                | Yes, as "killed"          |

**Notice.** Any non-zero exit starts `chief-public-browser-refresh-notify.service`, which sends the reason to the first ID in `TELEGRAM_ALLOWED_USER_IDS` directly through Telegram's API, so it works with the gateway down. A failed send is retried every 10 minutes, up to 6 attempts in all. The same reason is sent once a week however often it retries, and a different reason at once. `/var/lib/chief/public-browser-refresh.json` holds the last failure and notice only until the next clean run, so `journalctl -u chief-public-browser-refresh` is the record of every run. If the timer itself stops, a reboot interrupts the run or the notice, or Telegram stays unreachable, nothing tells the owner; the image age above is the check.

**Prune.** After any attempted refresh, and under the release lock, it runs `docker image prune -f` and `docker builder prune -af`. The first removes untagged images only: tagged ones such as `:rollback`, the old invoice-browser tags and the kept debug image stay, so it does not reclaim most of what `docker system df` calls reclaimable. Digest-pinned images, which show a repository but no tag, are also not in Docker's dangling list. The second removes all build cache, because every refresh is `--no-cache`. The cost is a slower next operator build. An ordinary release also prunes untagged images, which is why the refresh must tag what it keeps.

**After a security advisory**, run this on the host. It ignores the age, keeps every other check, prunes and prints the disk used before the refresh, after it and after the prune:

```bash
sudo python3 /opt/hermes-companion/scripts/scheduled-refresh-public-browser.py --now
```

**Installing it**, as root on the host, from a release that includes these files:

```bash
cd /opt/hermes-companion/deploy/lightsail && install -m 644 chief-public-browser-refresh.service chief-public-browser-refresh-notify.service chief-public-browser-refresh.timer /etc/systemd/system/ && systemctl daemon-reload
```

```bash
python3 /opt/hermes-companion/scripts/scheduled-refresh-public-browser.py --test-notice
```

```bash
systemctl enable --now chief-public-browser-refresh.timer
```

**Rolling back a swap that passed its proof but behaves badly**, as root, when idle. `:rollback` exists only after a refresh that includes this change. The restored image is usually already 28 days old, so the next tick would refresh again; if the fresh build is the problem, first run `systemctl disable --now chief-public-browser-refresh.timer`, and enable it again once a new build is safe:

```bash
docker tag chief-public-browser:rollback chief-public-browser && docker tag chief-public-browser-proxy:rollback chief-public-browser-proxy
```

```bash
docker compose --project-directory /opt/hermes-companion -p hermes-companion --profile public-browser up -d --no-deps --no-build --force-recreate --wait public-browser-proxy public-browser
```

The schedule covers age only. A merge that changes what these images hold still needs a manual refresh, as above.

**To turn it off:** set `PUBLIC_BROWSER=off` in `.env`, recreate the gateway and stop the two services.
