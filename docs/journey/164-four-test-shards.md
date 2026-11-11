# 164 — How many test shards does CI need now that tests are faster?

Work date: 11 November 2026. Written: 11 November 2026.
Status: measured in one CI run on the pull request. Not yet released.

## User-visible problem and preceding iteration

The owner saw three CI jobs waiting for runners. [Journal 158](158-reused-test-databases.md) had roughly halved the test steps, but CI still split the tests six ways, a number chosen when a shard took over two minutes ([journal 138](138-faster-ci-checks.md)).

## Evidence

**Measured, 11 November, 15:52 UTC, the jobs of the three runs then active:** 20 jobs were in progress across the account's repositories (11 in this one, 9 in Kite) and 3 of this repository's were queued. In the run before it, jobs created at 15:41:42 started between 15:42:29 and 15:51:06, a wait of up to 9 minutes.

**Measured, this repository:** a pull request run has 13 jobs, 6 of them test shards. On main's run 43048652242 the six `test:ts` steps took 75, 67, 46, 57, 54 and 87 s. The image job, the longest in a run, takes 164–171 s (journal 158's runs).

**Read from the three runs' job lists, not from GitHub's documentation:** the account runs 20 jobs at once. Two pull requests open together want 26.

## Diagnosis and alternatives

Most of the queue that day came from Kite's CI, which built the same binary in 36 jobs; that is fixed in Kite. This repository still wants more than half the limit for one run.

- **Four shards (chosen):** two jobs fewer per run. The re-recorded weights put about 332 s of recorded test time in each of four shards, against 222 s in each of six. At the ratio the six shards showed (46–87 s of wall time for 222 s), a shard's test step should take roughly 70–130 s, and its job stays under the image job's.
- **Three shards:** two runs would then fit under the limit exactly, but a test job would take about as long as the image job, with no margin.
- **A paid plan with more concurrent jobs:** the owner's decision.

## Implementation and review

- `.github/workflows/ci.yml`: four shards.
- `tests/test-weights.json`: re-recorded from run 43048652242, as journal 158 left to do.

## Verification and outcome

**Measured, the pull request's own run (43053167239, `7b9a479`), the first with four shards:**

- The four `test:ts` steps took 92, 99, 94 and 78 s, inside the 70–130 s expected. The test jobs took 96–117 s.
- The image job took 152 s, and the whole run 172 s, from 15:55:29 to 15:58:21 UTC. Journal 158's runs took about as long with six shards.
- The run had 11 jobs besides the skipped image publish, against 13 before.

This is one run. Runner speeds varied by up to two times between shards in earlier measurements ([journal 138](138-faster-ci-checks.md)).

**Review (Claude Opus 5.5), `7b9a479`: changes requested, on the records only.** The index row for this entry was in the wrong table, the status said tested before any four-shard run had finished, and three places stated the 20-job limit as a known fact. The reviewer confirmed the shard split (157 files, each in exactly one shard, none without a weight) and the figures above from the run itself.

## Follow-up and next iteration

- Reconsider three shards if the image job gets faster.
