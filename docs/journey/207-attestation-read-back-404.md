# 207 — Why did a passing main commit skip its release?

Work date: 22 November 2026. Written: 22 November 2026.
Status: released 22 November 2026 in `7edaa60`; see Release closure below. As first written: tested (the step control flow, on a hosted runner); not yet released. The real action recovering from a failed first attempt has not been seen, because it only happens when the public transparency log misbehaves on a main build.

## User-visible problem and preceding iteration

[Journal 132](132-ci-built-gateway-image.md) moved the gateway image build into the `checks` workflow's `publish gateway image` job, which signs a build-provenance attestation for the image. `release` runs only when the whole of `checks` succeeded, and verifies that attestation before it sends the digest to the host.

**Reported, 22 November 2026:** two merges to main passed every test and were not released. In both, `publish gateway image` failed in its attestation step with `InternalError: error fetching tlog entry - (404) Not Found`, so `release` was skipped and production stayed on the previous commit until someone ran `gh run rerun <id> --failed`. Both reruns succeeded.

## Evidence

**Measured, from GitHub Actions on 22 November:**

- **The two runs.** `checks` run 45007814059 (`bb3c399e`) and run 45023086024 (`3340f3f4`), first attempt each. The image had been built and pushed, and every other job passed. The attestation step's inner `actions/attest` call failed after 11,837 ms and 11,855 ms. In the rerun of the first, the same call took 4,726 ms.
- **How often.** Of the last 100 `checks` runs for pushes to main (2 to 22 November), these are the only two in which the attestation step failed. Eleven of the 100 ran on 22 November (UTC).
- **The log's status page**, read at 13:10 UTC on 22 November, listed no incident for 16 to 22 November and gave the Rekor log 99.952% uptime.

**Tested by reading the source** of the pinned action (`actions/attest-build-provenance@e8998f94` runs `actions/attest@ce27ba3b`, version 2.4.0, `dist/index.js`):

- The message `error fetching tlog entry` is raised in one place. The signing client writes the entry to the transparency log (Rekor). If the log answers `409`, "an equivalent entry already exists", the client reads that entry back by the address in the answer, and this message is what a failed read-back produces.
- The write has a 10-second timeout and three retries. A retry happens when the request itself fails (a timeout, a reset connection) or the answer is `408`, `429` or `5xx`. A `404` is not retried, so one `404` on the read-back fails the action. (Corrected 22 November 2026: as first written this listed only a timeout and the three statuses; the review found that any failed request is retried.)
- Each attempt signs with a new key and certificate. An equivalent entry can therefore only be the client's own earlier write in the same attempt.
- The latest release, `actions/attest` v4.2.2, has the same code. Upgrading the action would not remove the failure.

**Reported upstream:** [actions/attest-build-provenance issue 679](https://github.com/actions/attest-build-provenance/issues/679) (August 2025) is the same message from several repositories on one day. A GitHub maintainer attributed it to an outage of the Rekor log. GitHub's issue search also shows other repositories reporting the message on 14, 18 and 22 November 2026 (titles only; not read).

## Diagnosis and alternatives

- **Mechanism (from the source).** The log accepted the entry and then answered `404` when asked for it. That is a write that cannot yet be read, on the log's side, and the client treats that one `404` as final.
- **Hypothesis, consistent with the timing.** The first write was not answered within 10 seconds although the log had stored it; the retry was told the entry exists; the read-back got `404`. The 11.8 seconds both failures took fit one 10-second timeout plus a retry. The action's log does not print its HTTP attempts, so this sequence was not observed.
- **Is it a known race?** Upstream has the same error on record and attributes it to trouble at the log. I found no upstream description of it as a read-after-write race; that part comes from the source above.

**The fix is a retry, which is a symptom fix** in the terms of AGENTS.md. The cause sits in the public log and in the signing client inside the pinned action, neither of which this repository can change. The owner asked for the retry on 22 November 2026, after the two skipped releases above.

Alternatives:

1. **Run the same pinned action again when it fails.** Chosen.
2. **Upgrade the action.** The latest release has the same code path.
3. **A third-party retry wrapper action.** It would add another party's code to the job that holds the signing identity.
4. **Let the job pass without an attestation.** The release's verification would then fail instead, and it would mean a main image with no provenance. Not acceptable.
5. **Have `release` rerun a failed publish job.** More machinery, with the same effect as retrying in place.

## Implementation and review

`.github/workflows/ci.yml`, job `publish gateway image`:

- The attestation step runs up to three times: the first attempt, a second after 20 seconds, a third after another 60 seconds.
- Each is the same action at the same pinned commit with the same inputs. The first two carry `continue-on-error`; a later attempt runs only when the one before it failed.
- The third attempt has no `continue-on-error`, so the job fails when all three fail, and the release is skipped as before.
- Each wait step prints a warning annotation, so a run that needed a retry shows it.

Unchanged: the release workflow's `gh attestation verify` (signer `ci.yml`, `refs/heads/main`, source digest equal to the commit), the digest it sends, and the host's checks in `scripts/cloud-release.py` (pull by digest, revision label and `RELEASE_SHA` equal to the commit). A release still deploys nothing without a verified attestation.

**Independent review (Claude Opus 5.5), 22 November 2026:** approved the exact head `1060f39e` with two low findings.

- The sentence about which failures the client retries was too narrow. Corrected above.
- The three attempts repeat the same `uses` and `with` block, kept the same only by a comment. Accepted: a copy that signed differently would be caught by the release's check.

Devin Review reported one flag on the same head. It was not posted on the PR and its page asked for acceptance of terms before showing it, so it was not read.

Two effects of signing again:

- A failed attempt can leave its entry in the public log, unused. Rerunning the job did the same.
- If an attempt failed after storing its attestation, a later attempt adds a second one for the same digest. `gh attestation verify` reports the attestations that match its policy and needs one; this case has not been exercised here.

## Verification and outcome

**Tested, 22 November:** a temporary workflow on a throwaway branch (run 45026190587, branch since deleted) ran the same step structure on a hosted runner, with `run` steps standing in for the action:

| Case                      | Steps that ran                 | Job    |
| ------------------------- | ------------------------------ | ------ |
| First attempt succeeds    | attempt 1                      | passed |
| First fails, second works | attempt 1, wait, attempt 2     | passed |
| First two fail            | all three attempts, both waits | passed |
| All three fail            | all three attempts, both waits | failed |

In the failing case the step after the attestation was skipped. In the passing cases it ran.

**Not tested:** the real action failing and a later attempt succeeding. Whether a second attempt 20 seconds later succeeds as a rerun minutes later did is expected, not measured.

**Cost:** none when the first attempt succeeds. Three failures add 80 seconds of waiting and two more attempts before the job fails.

### Release closure — 2026-11-22

- **Merged:** [PR 530](https://github.com/akhilvuputuri/chief-agent/pull/530), approved head `1060f39e`, squashed to `7edaa607` after hosted checks passed on that head.
- **Main's checks** (run 45026992240, first attempt): `publish gateway image` passed. The first attestation attempt succeeded, and both waits and both later attempts were skipped.
- **Release** (run 45027391952): succeeded, including its attestation check. `kite run release:status` reports `7edaa607` deployed with startup health passed at release time.
- **Still not seen:** a first attempt failing and a later one succeeding.

> **Update, 22 November 2026: the retry was needed on the next main build, and worked (measured).** `checks` run 45027700119 for `1c71e667` (PR 531, the docs change above), first attempt of the run: the first attestation attempt failed at 13:29:28 UTC with the same `error fetching tlog entry - (404) Not Found`; the wait printed its warning; the second attempt created and uploaded the attestation by 13:30:04; the third was skipped and the job passed. Release run 45028072607 then verified that attestation and deployed `1c71e667`, with startup health passed, and nobody reran anything. That is one recovery, on the second attempt after 20 seconds. It is also the third such failure on 22 November, in 13 main builds that day, against none in the 89 main builds from 2 to 21 November counted above.

## Follow-up and next iteration

- Look for the warning annotation on `publish gateway image` runs to count how often a retry was needed and whether the second attempt was enough.
- Reporting the unretried `404` to the action's maintainers is deferred; it is the owner's decision.
