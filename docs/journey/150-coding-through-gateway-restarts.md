# 150 — Can a coding job survive a gateway restart?

Work date: 2026-11-01. Written: 2026-11-01.
Status: tested on synthetic jobs. Not released: the host part waits for the running job, and the worker part needs a new image.

## User-visible problem and preceding iteration

Job `34493cd9` finished implementation and review rounds, then stopped twice in six minutes. The first stop said the coding box stopped before a result. The next two said "Symlink paths are unsupported". The job was replaced, and its files were lost. Its findings survived only because they were retyped into the new request.

## Evidence

- **Measured:** `deploy-mail-vectors.py` restarted the gateway from 17:18:46 to 17:18:52 UTC on 1 November. The last session upload landed at 17:18:46.876 and the worker exited with code 1 at 17:18:53. Caddy logged connection resets from the box's address range during that window.
- **Measured:** the retry's coder ran `ln -sfn /opt/chief-worker/node_modules node_modules` on a box with no `node_modules`. Git added the link, because `.gitignore` says `node_modules/`, and the snapshot refused it. A resume repeated this 30 seconds in, because the session remembered the link.
- **Inferred:** that the worker's exit came from a failed request. Its error text was discarded by design.
- **Code:** the deploy scripts check `runtime_runs` and pending input, not coding jobs. I had told the owner releases refuse to run during a coding job. That was wrong.

## Diagnosis and alternatives

Each part assumed the others stay up: one failed request ended the worker, one failed heartbeat cancelled the run, and a retry started without dependencies.

Blocking releases during coding jobs was rejected. Jobs run for hours and other agents release often, so the releases would stall. Tolerating the restart is cheaper, and a warning stays. Enabling Pi's own agent retry was also rejected for now: the runtime deliberately ends a turn on a model error, and changing that affects every failure, not only restarts.

## Implementation and review

- `src/coding/pi-worker.ts`: `NativePiWorkerClient` retries for 3 minutes on an unreachable host; heartbeats cancel only on a refusal; exit codes name the failure.
- `coding_runtime_pi/src/terminal-http-recovery.ts`: `gatewayOutageFetch` resends a model request the gateway could not answer, under a new identity. The host buffers each response, so a cut call normally shows up here, before any response. The 3-minute wait starts at the first failure, because a call may already have run for minutes.
- `coding_runtime_pi/src/workspace.ts`: snapshots reset `node_modules` links to the base, which drops ones the coder staged or committed and keeps ones the repository tracks. Any other symlink still ends the job. Host checks delete added links first, so they run against the repository's own dependencies.
- `src/coding/api.ts`: authentication answers 401 only when the host checked and said no. A lost connection or a database shutting down answers 503, there and on routes other than model calls, and is logged. After authentication, other database errors stay refusals, so a real bug keeps its reason.
- `src/coding/controller.ts`: `recoverModels` records calls a restart cut off as `gateway_restart`, and `autoRetryOnce` treats that pause as transient. This widens the exception in AGENTS.md, which the owner approved on 2 November.
- `scripts/cloud-release.py`: warns when a coding job is running. About 25 other deploy scripts do not warn.

Limitations:

- A call the host is still running when its connection breaks (a proxy blip, not a restart) gets "already in flight" on resend, and the run pauses. The first call is still paid for. This fails closed.
- Each resend counts against the worker's local model budget, about 20 per 3-minute outage against a limit of 1,500. A send that hangs for over 30 seconds restarts the wait, so a host that accepts and then hangs is bounded by that budget and the time allocation, not by 3 minutes.
- A coder that retargets a link the base tracks has the link restored in the artifact, while its checks ran against the changed link.
- A pause past the 3-minute wait relies on the job-level retry, once.
- A retried attempt still starts on a new box, so it loses uncommitted tool state and installed dependencies.
- If the host answers a resent call with a provider failure, the in-run provider retry does not apply, because its receipt names the new identity. The run pauses, which is safe.

## Verification and outcome

- **Tested:** `tests/coding-worker-outage.test.ts`, `coding_runtime_pi/tests/terminal-http-transport.test.ts`, `coding_runtime_pi/tests/terminal-http-recovery.test.ts` and `coding_runtime_pi/tests/workspace-base.test.ts`, with local servers and real git. The recovery test used to assert that a lost connection pauses the run. It now asserts the resend under a new identity, with the tool applied once.
- **Not tested:** a real gateway restart during a real job.
