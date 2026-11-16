import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localExecutor, type Execution } from "../src/workspace.js";

/**
 * A stand-in for the Linux guard's old `cleanup` (journal 197): it kills every child of this
 * process and reaps it in native code, so Node never emits `exit` for a child it was waiting
 * for. Modelled here by killing each live child's process group and dropping its `exit`.
 */
function killEverything() {
  const calls: number[] = [];
  const cleanup = () => {
    let killed = 0;
    for (const handle of (
      process as unknown as { _getActiveHandles(): unknown[] }
    )._getActiveHandles()) {
      if (!(handle instanceof ChildProcess) || handle.exitCode !== null)
        continue;
      if (handle.signalCode !== null || handle.pid === undefined) continue;
      try {
        process.kill(-handle.pid, "SIGKILL");
      } catch {
        handle.kill("SIGKILL");
      }
      // waitpid(-1) took the exit status: Node's exit for this child never comes.
      const emit = handle.emit.bind(handle);
      handle.emit = ((event: string, ...args: unknown[]) =>
        event === "exit" ? false : emit(event, ...args)) as typeof handle.emit;
      killed++;
    }
    calls.push(killed);
  };
  return { cleanup, calls };
}

/** Fails the test instead of hanging it when a command's promise never settles. */
function settles<T>(promise: Promise<T>, what: string, ms = 10_000) {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} never settled`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const signal = () => new AbortController().signal;
const output = (e: Execution) => e.output.trim();

test("two commands at once each finish with their own result, in either order", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-concurrent-"));
  for (const [first, second] of [
    [0.2, 0.8],
    [0.8, 0.2],
  ] as const) {
    const guard = killEverything();
    const execute = localExecutor(root, join(root, "home"), guard.cleanup);
    const [a, b] = await settles(
      Promise.all([
        execute(`sleep ${first}; echo a; exit 3`, signal()),
        execute(`sleep ${second}; echo b; exit 4`, signal()),
      ]),
      "a command of the pair",
    );
    assert.deepEqual([output(a), a.exitCode], ["a", 3]);
    assert.deepEqual([output(b), b.exitCode], ["b", 4]);
    // The sweep ran once, when neither command was running, and found nothing of theirs.
    assert.deepEqual(guard.calls, [0]);
  }
});

test("three commands with a slow one, across separate executors", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-concurrent-"));
  const guard = killEverything();
  // The session's tools and the worker's own git use separate executors (pi-worker.ts).
  const tools = localExecutor(root, join(root, "tool-home"), guard.cleanup);
  const git = localExecutor(root, join(root, "git-home"), guard.cleanup);
  const results = await settles(
    Promise.all([
      tools("sleep 1.2; echo slow; exit 5", signal()),
      tools("echo fast", signal()),
      git("sleep 0.3; echo git", signal()),
    ]),
    "a command of the three",
  );
  assert.deepEqual(
    results.map((r) => [output(r), r.exitCode]),
    [
      ["slow", 5],
      ["fast", 0],
      ["git", 0],
    ],
  );
  assert.deepEqual(guard.calls, [0]);
});

test("a command stopped by its timeout or cancelled while a sibling runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-concurrent-"));
  const guard = killEverything();
  const execute = localExecutor(root, join(root, "home"), guard.cleanup);
  const cancel = new AbortController();
  setTimeout(() => cancel.abort(), 200);
  const [timed, cancelled, sibling] = await settles(
    Promise.all([
      execute("sleep 30", signal(), 200),
      execute("sleep 30", cancel.signal),
      execute("sleep 0.8; echo sibling", signal()),
    ]),
    "a command of the three",
  );
  assert.equal(timed.timedOut, true);
  assert.equal(timed.exitCode, -1);
  assert.equal(cancelled.exitCode, -1);
  assert.deepEqual([output(sibling), sibling.exitCode], ["sibling", 0]);
  assert.deepEqual(guard.calls, [0]);
});

test("the sweep runs after every command when they do not overlap", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-concurrent-"));
  const guard = killEverything();
  const execute = localExecutor(root, join(root, "home"), guard.cleanup);
  assert.equal(output(await execute("echo one", signal())), "one");
  assert.equal(output(await execute("echo two", signal())), "two");
  assert.deepEqual(guard.calls, [0, 0]);
});

test("a command that cannot start settles and is not counted as running", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-concurrent-"));
  const guard = killEverything();
  // A working directory that does not exist: spawn reports an error and no exit.
  const broken = localExecutor(
    join(root, "missing"),
    join(root, "home"),
    guard.cleanup,
  );
  await assert.rejects(
    settles(broken("echo never", signal()), "the failed spawn"),
    /could not start/,
  );
  const execute = localExecutor(root, join(root, "home"), guard.cleanup);
  assert.equal(output(await execute("echo after", signal())), "after");
  // Both settled with nothing running, so both swept.
  assert.deepEqual(guard.calls, [0, 0]);
});
