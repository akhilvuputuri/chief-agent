# 144 — Can a prepared image shorten a coding box's boot?

Work date: 1 November 2026. Written: 1 November 2026.
Status: tested in CI only. The AWS stacks are not applied, so boxes still use stock Amazon Linux and nothing is measured.

## User-visible problem and preceding iteration

Every coding job waits for a new box to install Docker and pull the worker image. [Journal 137](137-box-startup-time.md) removed the launch wait and added boot-stage timings, and left the baked image to be decided from those timings. No box has launched since, so the owner decided from the comparison below rather than waiting.

## Evidence

**Measured, production `boxes` and `box_events` metadata, 1 November:**

- 20 coding boxes, on 3 days between 20 and 29 October.
- The first event follows launch by 80–114 s on the 19 boxes that reported one. How that divides between stages is still not measured.
- 10 of those 19 ended within 5 minutes; the others ran 12–53 minutes.
- No box has had a second epoch, so stop and start has never run for real.

**Measured, repository:** the coding worker image was re-pinned 6 times between 20 and 31 October.

**Reported, AWS price lists for Singapore, read 1 November:** gp3 $0.096 per GB-month, snapshots $0.05 per GB-month, `m7i.xlarge` $0.252 per hour, Fast Snapshot Restore $0.90 per hour per snapshot and zone, volume initialization $0.0029 per GB at up to 200 MiB/s. Image Builder has no charge of its own.

**Hypothesis:**

- A baked image reports in within 25–45 s, and a stopped spare within 20–40 s. No public benchmark matches this instance, volume and image.
- A baked image costs about $1 a month in storage and weekly builds.

## Diagnosis and alternatives

- **Stopped spare (rejected for now):** about $6 a month and probably the fastest first read, since its disk is already loaded. A box's owner, job and image are fixed when its row is created, so it needs a new unassigned state, its own lifetime rules and a separate admission path. It would also sit idle between patches, and must be replaced at every re-pin.
- **Baked image (chosen by the owner):** every box benefits, each is still brand new, and the job binding does not change. Disk data loads from the snapshot on first read, by an unmeasured amount.
- **Instance kept running, hibernation, Fast Snapshot Restore (rejected):** about $184 a month in compute, a saved memory image that nothing needs, and about $648 a month respectively.
- **Image Builder instead of a GitHub workflow:** a workflow would need an AWS role reachable from a public repository, and code to launch, snapshot, test and clean up. Image Builder needs none of that.

## Implementation and review

- **Boot script:** `command -v docker` and `docker image inspect` skip the work already done, so one script serves both images. Stage names are unchanged, so `box.boot` lines are directly comparable. The inspect is by digest, so only the exact pinned image counts.
- **`deploy/boxes/box-image.json`:** a separate stack. A build component reads the digest from `config/boxes.json` on `main` and refuses anything that is not digest-pinned. A test component runs on an instance launched from the new image. The AMI is tagged `chief:box-image`, published through an SSM parameter, and only the newest three are kept.
- **`deploy/boxes/boxes.json`:** the `CodingImage` parameter defaults to stock Amazon Linux and accepts only the stock or baked parameter. The controller may also launch this account's images carrying the tag. Echo boxes stay on stock.
- **Unchanged:** the agent and Node are still copied from the pinned image at boot, so they always match the pin. Boxes have no instance profile. The build role is attached only to build and test instances.

Volume initialization is left off until the first read has been measured.

## Verification and outcome

**Tested:** template lint on both stacks (one expected warning, as `CodingImage` is deliberately a string for `resolve:ssm:`), the component YAML and shell syntax, and the digest extraction against the real pin and unsafe values.

**Not tested:** any AWS call. The stacks, the first build, the weekly schedule and the retention policy have never run, and neither has a real box on this image.

Pending: the owner's [rollout](../../deploy/boxes/README.md#baked-coding-image), then `kite run logs:cloudwatch -- boot --since 24h` after a coding job, compared with a stock box.

## Follow-up and next iteration

- Compare `box.boot` stages on both images, and record what they show here.
- Turn on volume initialization if the first read is slow. A 12 GiB image would cost about 3.5 cents a box.
- Reconsider the stopped spare only if neither gets close enough.
