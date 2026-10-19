/**
 * The `coding` profile's task program (docs/boxes.md, phase 4a). It speaks the box task
 * protocol on stdin and stdout and runs the unchanged Pi coding worker as a child, with
 * the attempt's identity in the worker's environment as on CodeBuild. The worker reports
 * to the host's `/coding/worker/*` routes itself; this program only reports its exit.
 *
 * It holds the attempt token while repository commands run as the same user in the same
 * container, so before reading the task it requires `--disable-sigusr1` (no inspector to
 * attach) and makes itself non-dumpable (no reading its memory through /proc).
 */
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { z } from "zod";

const out = (value: object) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);

export const codingTaskPayload = z
  .object({
    jobId: z.string().uuid(),
    attemptId: z.string().uuid(),
    token: z.string().regex(/^[a-f0-9]{64}$/),
    origin: z.string().regex(/^https:\/\/[a-z0-9.-]+(:\d+)?$/),
  })
  .strict();

/** The worker's environment: nothing from the box beyond PATH, with work on the box disk. */
export function workerEnvironment(
  payload: z.infer<typeof codingTaskPayload>,
  workspace: string,
  path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
) {
  return {
    PATH: path,
    HOME: process.env.HOME ?? "/home/worker",
    // The worker clones, installs and tests under TMPDIR; the /tmp tmpfs is too small.
    TMPDIR: `${workspace}/tmp`,
    CODING_JOB_ID: payload.jobId,
    CODING_ATTEMPT_ID: payload.attemptId,
    CODING_JOB_TOKEN: payload.token,
    CODING_ORIGIN: payload.origin,
  };
}

/** The worker image's native guard: non-dumpable, and a subreaper for its children. */
const nativeLockdown = () =>
  (
    createRequire(import.meta.url)("/opt/pi-runtime/process-boundary.node") as {
      lockdown: () => boolean;
    }
  ).lockdown();

export function run(
  worker = ["--disable-sigusr1", "/opt/chief-worker/dist/coding/pi-worker.js"],
  workspace = process.cwd(),
  lockdown: () => boolean = nativeLockdown,
) {
  const finish = (payload: object) => {
    out({ type: "result", payload });
    process.exitCode = 0;
    process.stdin.destroy();
  };
  let locked = false;
  try {
    locked =
      process.execArgv.includes("--disable-sigusr1") && lockdown() === true;
  } catch {
    locked = false;
  }
  let started = false;
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let input: { type?: unknown; payload?: unknown } | null;
    try {
      input = JSON.parse(line);
    } catch {
      return;
    }
    // Steering into a coding attempt arrives with phase 4c; messages are ignored here.
    if (!input || typeof input !== "object" || input.type !== "task" || started)
      return;
    started = true;
    lines.close();
    if (!locked) return finish({ error: "Coding task boundary unavailable" });
    const parsed = codingTaskPayload.safeParse(input.payload);
    if (!parsed.success) return finish({ error: "Invalid coding task" });
    mkdirSync(`${workspace}/tmp`, { recursive: true, mode: 0o700 });
    out({ type: "progress", payload: { step: "worker started" } });
    const child = spawn(process.execPath, worker, {
      env: workerEnvironment(parsed.data, workspace),
      // The worker's own output never reaches the task protocol on stdout.
      stdio: ["ignore", "ignore", "ignore"],
    });
    let reported = false;
    child.on("error", () => {
      if (!reported) finish({ error: "Worker could not start" });
      reported = true;
    });
    child.on("exit", (code, signal) => {
      if (!reported) finish({ exitCode: code, signal });
      reported = true;
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) run();
