# 136 — Where does a coding box's startup time go?

Work dates: 31 October 2026. Written: 31 October 2026.
Status: in review. Removes the launch wait and adds the timings; no box has reported stages yet.

## User-visible problem and preceding iteration

Every coding job waits for a fresh EC2 box before any work starts. [Journal 132](132-ci-built-gateway-image.md) removed the equivalent wait from releases. A baked machine image is the obvious next step, but nothing recorded which stages of a box's boot take the time.

## Evidence

**Measured, production `boxes` and `box_events` metadata, the 20 most recent coding boxes:**

- `launch_started_at` is 15 s after `created_at` on 19 of the 20. The other took 4 s.
- The first box event follows 80–114 s after launch, typically about 90 s.

**Measured, registry:** the coding worker image is 331 MB compressed, in 18 layers.

**Read from the code:** each box boots stock Amazon Linux, runs `dnf install -y docker`, pulls the whole image and copies the agent out of it.

**Not measured:** how the 90 s divides between those stages, and Kite's install time inside a job.

## Diagnosis and alternatives

- **The 15 s wait.** A new box launches on the next tick of a 15 s timer. Jobs are created by another 15 s timer, so a box usually waits nearly a full period. This fits the near-constant 15 s, but the timers' relative order was not observed directly.
- **A baked image** waits for the stage timings, so its gain is known before a pipeline is built.

## Implementation and review

- **Launch:** `BoxController.onRequested` runs a reconciler pass right after a box is requested. A pass asked for during another pass runs right after it.
- **Boot stages:** the boot script stamps six stages to `/var/lib/chief-box/boot-stages`, never failing the boot if a stamp fails.
  - The agent sends them once, with its first hello, and only then.
  - The host validates names and times, then logs `box.boot` with milliseconds since launch for each stage and for the hello. Read it with `kite run logs:cloudwatch -- event --event box.boot`.
  - The agent runs from a bare copy of `dist/boxes` with no `node_modules`, so the stage names live in a dependency-free module.
- **Check durations:** the Pi runtime reports `kite ci: 0 in 1.4s`, so job progress shows how long each check took, including Kite's install. Progress text still accepts the older format from workers on older images.

A new agent's first hello is refused by a gateway older than this change, so the gateway releases first, and a gateway rollback would strand only boxes mid-boot. The agent and Pi runtime changes need a rebuilt worker image and a digest pin. The launch wake-up takes effect with the gateway release.

## Verification and outcome

Pending: CI, then a real box's `box.boot` line and a job's `kite ci` duration.

Local tests could not run. On 31 October macOS's `syspolicyd` held newly placed binaries at first launch: a fresh `esbuild --version` was still blocked after 100 s, and an existing copy of the same version ran immediately. CI runs the tests on Linux. The cause of the hold is inferred from `syspolicyd` at about 100% CPU; it is not proven.

### Release closure — pending

## Follow-up and next iteration

- Decide on a baked machine image from the `box.boot` figures.
