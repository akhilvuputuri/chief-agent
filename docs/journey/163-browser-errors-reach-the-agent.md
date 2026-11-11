# 163 — Why did the browser agent's clicks fail, and why couldn't it tell?

Work date: 2026-11-11. Written: 2026-11-11.
Status: released in `1cb516b`. Code change to the gateway only; the browser service and its images are unchanged.

## User-visible problem and preceding iteration

The owner asked whether the browser had been used. It had: the first real tasks after the rollout in [journal 148](148-public-browser-agent.md), all parcel tracking. Today's runs on SingPost had many failed clicks, and two of the five did not finish. The release records still said no real task had run.

## Evidence

**Measured on the host, 11 November 2026** (counts and element labels only; no page text or tracking numbers were read):

| Day (Singapore) | Browser runs | Browser steps | Failed steps | Sites                                     |
| --------------- | ------------ | ------------- | ------------ | ----------------------------------------- |
| 8 November      | 1            | 2             | 0            | Japan Post                                |
| 9 November      | 1            | 3             | 0            | Japan Post                                |
| 11 November     | 5            | 50            | 8            | Japan Post, SingPost, parcelsapp, 17track |

- Of today's five runs, three answered, one stopped at its budget and one was interrupted.
- 6 of 13 clicks failed, and one `eval` and one `scroll` failed. The `scroll` failed validation because the agent left out `direction`. Every other failure was recorded only as `TOOL_FAILED`, "The tool failed".
- The failed clicks were on SingPost buttons labelled "Track", "Details", "Accept All" and twice "Reject Non-Essential", each present in the snapshot taken just before. "Track" and "Details" then worked once a cookie banner had been dismissed.
- The agent clicked "Accept All" on that banner twice. The profile is thrown away when the run ends, so this has no lasting effect.

**Reproduction, not successful.** In the browser image on a laptop (arm64, no proxy, sandbox off), "Track", "Reject Non-Essential" and "Track" again all clicked successfully on the SingPost tracking page. That run had no tracking number filled in and saw a different banner, so it does not rule the banner out.

**Hypothesis, not proven:** the clicks failed because the banner covered the buttons or because the page re-rendered between snapshot and click. The real reason was never recorded.

## Options and decision

1. Guess the cause and add banner guidance to the agent's instructions. Rejected: it would act on a hypothesis and change the plugin's pinned content.
2. **Chosen:** let the browser's own reason reach the agent. The service already returns it, bounded to 500 characters, and its comment says the model decides what to try next from it. But the gateway threw a plain `Error`, which `toolError` turned into the generic `TOOL_FAILED`, so neither the agent nor the journal kept it.

## Implementation

- `src/tool-errors.ts`: `BrowserCommandError`, mapped to code `BROWSER_REFUSED`. Its message is the browser's reason, whitespace collapsed and cut to 300 characters, labelled as coming from the browser and the page, never instructions, with advice to take a new snapshot before acting again.
- `src/public-browser/client.ts`: a refused command throws `BrowserCommandError`. A lost reply stays a plain error, as before, so a click with an unknown outcome is still not repeated.
- The loop's handling is unchanged: `public_browser` is never retried, and failures are still counted per command, now under the new code.

## Validation

- **Tested:** a new real-loop test sends a refused click whose reason carries page markup and 600 extra characters. The agent receives code `BROWSER_REFUSED`, the reason, and the untrusted label, in under 520 characters. All 30 browser tests pass.
- **Not tested:** what agent-browser actually says for today's failures. The next failure on the host will show it.

## Limitations and deferred work

- The reason can contain page text, now visible to the agent in up to 300 characters. Snapshots already show the agent far more of the page, under the same label.
- No banner guidance was added. Decide that from the recorded reasons.
- The browser service and images do not change, so no refresh is needed for this change.

## Lessons

An error the tool layer swallows looks the same as no information. The service was built to explain its failures, and one generic mapping undid that.

## Release closure — 2026-11-12

[PR 447](https://github.com/akhilvuputuri/chief-agent/pull/447) was approved on `1cc7c36`, then on `1a7bcbe` after main was merged in to resolve a conflict in the journal index; hosted CI passed on both. It merged as `1cb516bf4a9d5c5d8114357f64afd679bff8a0ea`, and the automatic [release run](https://github.com/akhilvuputuri/chief-agent/actions/runs/43054717193) succeeded at 16:06 UTC on 11 November.

**Measured on the host:** `RELEASE` is `1cb516b`, `/healthz` answers, and the gateway's `dist/tool-errors.js` contains `BROWSER_REFUSED`. The browser service and proxy kept running unchanged.

**Not yet seen:** no browser call has run since the release (0 at 12 November), so no real reason has been recorded.
