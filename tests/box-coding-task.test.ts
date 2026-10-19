import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const adapter = fileURLToPath(
  new URL("../src/boxes/coding-task.ts", import.meta.url),
);
const payload = {
  jobId: "7f1d2c3b-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
  attemptId: "0e1d2c3b-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
  token: "c".repeat(64),
  origin: "https://companion.example.com",
};

/** Runs the adapter with a fake worker; returns its protocol lines and the worker's env. */
async function runAdapter(input: object, workerExit = 3) {
  const dir = await mkdtemp(join(tmpdir(), "coding-task-"));
  try {
    const worker = join(dir, "worker.mjs");
    await writeFile(
      worker,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "env.json"))}, JSON.stringify(process.env));
process.stdout.write("worker noise that must not reach the protocol\\n");
process.exit(${workerExit});`,
    );
    const runner = join(dir, "run.mjs");
    await writeFile(
      runner,
      `import { run } from ${JSON.stringify(adapter)};
run([${JSON.stringify(worker)}], ${JSON.stringify(dir)});`,
    );
    const result = spawnSync(process.execPath, ["--import", "tsx", runner], {
      input: `${JSON.stringify({ type: "task", id: "t1", kind: "coding", payload: input })}\n`,
      env: { ...process.env, PRIVATE_HOST_SECRET: "never-forwarded" },
      timeout: 30_000,
    });
    const lines = result.stdout
      .toString()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const env = await readFile(join(dir, "env.json"), "utf8")
      .then((t) => JSON.parse(t))
      .catch(() => undefined);
    return { lines, env, dir };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the coding task runs the worker with only its attempt identity and reports its exit", async () => {
  const { lines, env, dir } = await runAdapter(payload);
  assert.deepEqual(lines, [
    { type: "progress", payload: { step: "worker started" } },
    { type: "result", payload: { exitCode: 3, signal: null } },
  ]);
  assert.equal(env.CODING_JOB_ID, payload.jobId);
  assert.equal(env.CODING_ATTEMPT_ID, payload.attemptId);
  assert.equal(env.CODING_JOB_TOKEN, payload.token);
  assert.equal(env.CODING_ORIGIN, payload.origin);
  assert.equal(env.TMPDIR, `${dir}/tmp`);
  assert.equal(env.PRIVATE_HOST_SECRET, undefined);
  assert.deepEqual(
    Object.keys(env)
      .filter((k) => !["PATH", "HOME", "TMPDIR"].includes(k))
      .filter((k) => !k.startsWith("CODING_"))
      // Set by the runtime itself, not passed in.
      .filter(
        (k) => !["PWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"].includes(k),
      ),
    [],
  );
});

test("an invalid coding task is refused without starting the worker", async () => {
  for (const bad of [
    { ...payload, token: "short" },
    { ...payload, origin: "http://companion.example.com" },
    { ...payload, extra: true },
  ]) {
    const { lines, env } = await runAdapter(bad);
    assert.deepEqual(lines, [
      { type: "result", payload: { error: "Invalid coding task" } },
    ]);
    assert.equal(env, undefined);
  }
});
