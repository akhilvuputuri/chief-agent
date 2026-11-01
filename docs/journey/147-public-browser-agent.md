# 147 — Can Chief use an open browser without exposing the owner's data?

Work dates: 1–2 November 2026. Written: 1 November 2026.
Status: tested, not deployed. The confinement probe passes in the real image on arm64 and in CI on x86-64. The production host has not run it.

## User-visible problem and preceding iteration

Chief has a sandboxed browser that it barely uses. It is limited to invoice links and a Reddit fallback, and the owner asked for a general browser using `agent-browser`, "to do anything".

The obvious version would put an unrestricted browser on Chief itself. Chief reads email and memory and treats web pages as untrusted, so a page could direct it to open a URL containing private data.

## Evidence

**Measured (production, read-only, 1 November):**

- 0 invoice collections and 0 browser sessions. Of 22 link lookups since 8 October, 20 used plain HTTP, 1 was `owner_verified` and 1 used the browser, and that one came back blocked. `web_search` has 148 calls and `web_read` 74.
- A browser call that throws is not marked as a browser read, so failed attempts would not show in those counts. The browser and proxy containers have no logs to check against.
- Host: 2 CPUs and about 850 MB available.

**Tested (Docker Desktop, arm64, production's container limits):**

- `agent-browser` launched Chromium with `--no-sandbox`. Its docs and `cli/src/native/cdp/chrome.rs` confirm it adds the flag in containers.
- Launched by us with the sandbox on and attached with `--cdp`, the renderer had a seccomp filter and its own PID namespace.
- Loopback, the metadata address and internal names returned the proxy's refusal. The decoy service logged 0 requests. The container had no direct route.
- `pids_limit: 192`, the invoice browser's value, crashed Node and Chromium at 189 processes. At 512 the same run finished at 206.
- Memory peaked at 505 MB of 640 MB across BBC, Reuters, two Reddit pages and Wikipedia in one tab. No concurrent load, and on arm64.
- Reddit answered with a login page and a JavaScript challenge, and Reuters returned an empty page. BBC and Wikipedia worked.

**Not measured:** any of this on the production host, real tasks, success rates or cost.

## Options and decision

| Option                                                                  | Result                                                                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Open browser on Chief                                                   | Rejected: it would join private data with untrusted pages and open egress                             |
| Widen the invoice service                                               | Rejected: anonymous arbitrary scripts would share a container and control key with logged-in sessions |
| Build the actions on our Playwright service                             | Rejected: more code for what `agent-browser` already provides                                         |
| Isolated agent, own container, `agent-browser` attached to our Chromium | Chosen                                                                                                |

The agent holds one tool and cannot read anything private, so a hijacked page has little to reach. Logged-in browsing is left for later, because it removes that property.

## Implementation

See [public browser](../public-browser.md) for the design, and [src/public-browser/](../../src/public-browser/), [Dockerfile.browser](../../Dockerfile.browser) and [scripts/public-browser-probe.mjs](../../scripts/public-browser-probe.mjs).

Version 0.39.1 is pinned rather than the latest 0.41.0: it was 19 days old on the work date, and the five newer releases were all 10 days old or less.

**The first probe was wrong in two ways.** Chromium rewrites its children's process titles into one string, so splitting arguments on NUL missed the renderer. That also made the first `--no-sandbox` check too weak to mean anything. The key check also counted Docker's init process, which legitimately holds the container's environment. Both now match on the whole line and look only at browser processes.

**The real binary found what unit tests could not.** Passing `--` before `fill` text looked correct and passed the unit test, but `agent-browser` typed it literally, so every fill would have started with `-- `. Without it, text matching a known flag such as `--session` was consumed as an option and nothing was typed. `fill` now refuses text starting with `-`. The service's signed RPC was also driven end to end: bad signatures and replayed nonces were refused, another run got "busy", and closing left no process or file.

**Limits met.** The catalogue is now 11,979 of its 12,000 characters, so this agent's description was cut and the next agent will need room made. Screenshots were dropped from the first plan because tool results carry only text.

## Validation

- `tests/public-browser.test.ts`: command surface, argv safety, Chromium flags, environment, session lifetime, fail-closed cleanup, host authorization and registry refusal.
- `scripts/test-deploy-public-browser.py`: the Compose diff is exactly the reviewed additions and cannot widen access.
- The probe, in the real image with a decoy service, on arm64 and in CI on x86-64: all checks pass, 0 decoy requests. Peak memory was 221 MiB in CI on `50dd21c`, for this smaller run.
- The throwaway proof in `scripts/refresh-public-browser.py` is tested with mocks only; it has not run against real Docker.

## Review

Independent review (Claude Opus 5.5) requested changes on `a851605`. It found no path from a page to owner data, other tools, other runs or the control key. Findings fixed:

- **No update path.** Chromium would have stayed frozen after rollout, so `scripts/refresh-public-browser.py` now rebuilds, proves and swaps it.
- **No x86 proof before a merge that freezes releases.** CI now builds the image and runs the probe with a decoy on x86-64.
- **A stale idle check.** The rollout checked for running work, then spent minutes on the probe before stopping the gateway. It checks again immediately before.
- **Half of each page was invisible.** `read` returned 16,000 characters, but the model's projection cuts text at 8,000, so paging by 16,000 skipped text. It now pages by 8,000.
- **Read-operation assumptions.** A page could get a click or `eval` retried by throwing an error containing "503". Failures could lock out `snapshot` for the run. Three blocked sites could refuse every further browser call.
- **Forged sources.** A page could move between the text and its URL, and a script could rewrite a real site's page before `read`. The URL is now read on both sides of the text, and a session that ran `eval` gets no `sourceId`. The review proposed one `eval` returning both, which it also rates safe; either works, because a page cannot redefine `location.href`.
- **Every agent's finish waited on the browser.** Release now applies only to this agent and is not awaited.
- **Survivors.** The daemon runs in its own session, so killing Chromium's group missed it. It is now killed from its pid file, and cleanup waits to see processes gone.
- **Schema.** The `fill` rule was a lookahead `pattern` that a provider might reject, so it is now a host-side check.
- **Overclaims.** The docs named WebSocket and debugging-port checks the probe did not run. The next review replaced them, as below.

The delta review requested changes on `50dd21c`. It confirmed those fixes and could not file a wrong URL. It also found:

- **The probe tested less than the docs said.** Every target was plain HTTP, answered by the proxy's HTTP handler, so its HTTPS destination policy never ran. By the reviewer's reasoning, not a run, the debugging-port checks would have passed with the proxy bypassed, because CORS and DevTools' Origin check refuse them anyway. The probe now tries HTTPS to metadata, loopback and private addresses, and navigates to the real debugging port expecting exactly the proxy's refusal.
- **A false reason.** The address was described as coming from Chromium over CDP, but agent-browser evaluates `location.href` in the page. It is safe for a different reason, and the docs now say so.
- **The refresh could break a live task.** A task starting during its probe would fail the probe's clean-exit checks and then lose its session in the rollback. New images are now proved in throwaway containers before anything live changes.
- **Smaller fixes.** Paging stored the whole page per request, the rollback could recreate a gateway it had never stopped, and CI did not check that the decoy was alive.

A second delta review requested changes on `82decac`: the new HTTPS checks mostly could not fail. `chrome-error:` also appears for unrelated failures, a hung navigation read the previous target's error page, and nothing listened at the private targets, so a broken policy looked the same. The probe now starts each target from a real page, and CI adds a decoy on a dotted name resolving to a private address, listening on 443.

**Tested (arm64):** with the real proxy, all 32 checks pass and the decoy logs 0 connections. With a proxy that has no destination policy, the probe exits 1, five plain HTTP checks fail, and the decoy logs 12 connections, 10 of them on 443. The HTTPS "did not load" checks still passed in that run, because the decoy closes the connection without TLS. So the decoy's log is what catches a broken HTTPS policy, and only CI has it; the rollout and refresh run the probe without one, on code CI has already checked. Two targets that relied on public DNS (`localtest.me`, `10.0.0.1.nip.io`) passed with no policy too, so they were removed: they added a third-party dependency to every release and detected nothing.

## Limitations and deferred work

- The brief is not checked for private data. The description and instructions ask for it to stay out, and that is all.
- The instruction not to post, buy or sign up is guidance, not enforcement. With no account or card, the harm is limited, not zero.
- One session at a time, sized from a laptop measurement.
- The refresh is manual: nothing runs it on a schedule.
- No model has received this tool's schema, so the first real task after rollout is also that test.
- A browser process that escapes Chromium's sandbox could reach `gateway:3000` directly, because the gateway shares the network. The invoice browser's network has the same shape.
- Logged-in browsing and screenshots are deferred.

## Lessons

Run the third-party tool in the real sandbox before designing around it. Its documented flags did not show that it turns off the sandbox on its own.

A probe that passes needs testing too: the weak `--no-sandbox` check would have passed whatever the browser did. It was found only because another check on the same matching failed.

## Sources

- [agent-browser](https://github.com/vercel-labs/agent-browser): Chromium launch and `--cdp`.
- [Journal 91](91-boxed-subagents.md): the planned on-demand `crawl` box, if this outgrows the host.
