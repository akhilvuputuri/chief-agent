# 137 — Where does a coding box's startup time go?

Work dates: 31 October 2026. Written: 31 October 2026.
Status: released. The launch wake-up and the boot-stage reporting are live. No box has launched since, so the timings are not yet measured.

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
  - The host validates names and times, then logs `box.boot` with milliseconds since launch for each stage and for the hello. Read it with `kite run logs:cloudwatch -- boot`.
  - The agent runs from a bare copy of `dist/boxes` with no `node_modules`, so the stage names live in a dependency-free module.
- **Check durations:** the Pi runtime reports `kite ci: 0 in 1.4s`, so job progress shows how long each check took, including Kite's install. Progress text still accepts the older format from workers on older images.

A new agent's first hello is refused by a gateway older than this change, so the gateway releases first, and a gateway rollback would strand only boxes mid-boot. The agent and Pi runtime changes need a rebuilt worker image and a digest pin. The launch wake-up takes effect with the gateway release.

## Verification and outcome

- **CI:** all 12 checks passed on `c01e5ff`, including the first run of these tests.
- **Gateway release:** `304d691` released on 31 October (release run 41190356901).
- **Worker image:** `pi-coding-worker-image` run 41212849572 built `sha256:a5bdecece9afc80a2044370191649dcb5c8c56ce2d460fbe2971300bb46ce782` from `304d691`. Anonymous registry checks: the manifest hash matches, it is linux/amd64 and 331 MB, and it runs as `worker`. Its layers contain Kite 0.1.3, `dist/boxes/boot-stages.js`, an agent that reads `CHIEF_BOX_BOOT_STAGES`, and a Pi runtime that times checks.

Pending: a real box's `box.boot` line, a job's `kite ci` duration, and whether boxes now skip the 15 s wait.

Local tests could not run. On 31 October macOS's `syspolicyd` held newly placed binaries at first launch: a fresh `esbuild --version` was still blocked after 100 s, and an existing copy of the same version ran immediately. CI runs the tests on Linux. The cause of the hold is inferred from `syspolicyd` at about 100% CPU; it is not proven.

### Release closure — 31 October 2026

- **Gateway:** `304d691` (PR 376), release run 41190356901.
- **Worker image:** `557aa3f` (PR 380) pins `sha256:a5bdecec…`. Read-only host check: release `557aa3f`, pin `a5bdecec`, gateway and agentwatch healthy.
- **Not yet observed:** the last coding box was on 29 October, so no box has shown the shorter launch wait, a `box.boot` line or a `kite ci` duration. Read them with `kite run logs:cloudwatch -- boot --since 24h` after the next coding job.

## Follow-up and next iteration

- Decide on a baked machine image from the `box.boot` figures.
