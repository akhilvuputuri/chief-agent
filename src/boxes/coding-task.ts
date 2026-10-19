/**
 * The `coding` profile's task program (docs/boxes.md, phase 4a). It speaks the box task
 * protocol on stdin and stdout and runs the unchanged Pi coding worker as a child, with
 * the attempt's identity in the worker's environment as on CodeBuild. The worker reports
 * to the host's `/coding/worker/*` routes itself; this program only reports its exit.
 */
import { createInterface } from "node:readline";
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
    origin: z.string().regex(/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/),
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

export function run(
  worker = ["--disable-sigusr1", "/opt/chief-worker/dist/coding/pi-worker.js"],
  workspace = process.cwd(),
) {
  let started = false;
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let input: { type?: string; payload?: unknown };
    try {
      input = JSON.parse(line);
    } catch {
      return;
    }
    // Steering into a coding attempt arrives with phase 4c; messages are ignored here.
    if (input.type !== "task" || started) return;
    started = true;
    const parsed = codingTaskPayload.safeParse(input.payload);
    if (!parsed.success) {
      out({ type: "result", payload: { error: "Invalid coding task" } });
      process.exit(0);
    }
    mkdirSync(`${workspace}/tmp`, { recursive: true, mode: 0o700 });
    out({ type: "progress", payload: { step: "worker started" } });
    const child = spawn(process.execPath, worker, {
      env: workerEnvironment(parsed.data, workspace),
      // The worker's own output never reaches the task protocol on stdout.
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", () => {
      out({ type: "result", payload: { error: "Worker could not start" } });
      process.exit(0);
    });
    child.on("exit", (code, signal) => {
      out({ type: "result", payload: { exitCode: code, signal } });
      process.exit(0);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) run();
