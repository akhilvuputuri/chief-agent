import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { linuxProcessBoundary } from "./process-boundary.js";
import { localExecutor, type Execution } from "./workspace.js";
const cleanup = linuxProcessBoundary("/opt/pi-runtime/process-boundary.node");
const root = await mkdtemp(join(tmpdir(), "pi-isolation-"));
const execute = localExecutor(root, join(root, "home"));
const signal = new AbortController().signal;
const privateEnvironment = await execute(
  `test -z "$CODING_TEST_SECRET" && ! cat /proc/${process.pid}/environ >/dev/null 2>&1 && ! cat /proc/${process.pid}/mem >/dev/null 2>&1`,
  signal,
  1000,
);
assert.equal(privateEnvironment.exitCode, 0);
/** Starts a detached daemon in its own session and records its pid in `file`. */
const daemonCommand = (file: string) =>
  `node -e 'const {spawn}=require("node:child_process");const fs=require("node:fs");const p=spawn("node",["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});fs.writeFileSync("${file}",String(p.pid));p.unref();'`;
const daemon = await execute(daemonCommand("daemon.pid"), signal, 3000);
assert.equal(daemon.exitCode, 0);
const pid = Number(await readFile(join(root, "daemon.pid"), "utf8"));
assert.throws(() => process.kill(pid, 0));

// Commands at once through the real guard (journal 197). Pi runs the tool calls of one message
// together, and the worker's own git runs through executors of its own.
const settles = <T>(promise: Promise<T>, what: string) => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} never settled`)),
        30_000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};
const result = (e: Execution) => [e.output.trim(), e.exitCode];
const git = localExecutor(root, join(root, "git-home"));
for (const [first, second] of [
  [0.2, 1],
  [1, 0.2],
]) {
  const pair = await settles(
    Promise.all([
      execute(`sleep ${first}; echo a; exit 3`, signal),
      git(`sleep ${second}; echo b; exit 4`, signal),
    ]),
    "A command of two at once",
  );
  assert.deepEqual(pair.map(result), [
    ["a", 3],
    ["b", 4],
  ]);
}
const three = await settles(
  Promise.all([
    execute("sleep 2; echo slow; exit 5", signal),
    execute("echo fast", signal),
    execute("sleep 0.3; echo middle", signal),
  ]),
  "A command of three at once",
);
assert.deepEqual(three.map(result), [
  ["slow", 5],
  ["fast", 0],
  ["middle", 0],
]);
// A daemon left by one command while another runs is gone once no command runs. The running
// command's own adopted process (its parent shell exited) is not swept while it runs.
const [left, sibling] = await settles(
  Promise.all([
    execute(daemonCommand("left.pid"), signal, 3000),
    execute(
      "sh -c '(sleep 1; echo adopted > adopted.txt) &'; sleep 2.5; cat adopted.txt",
      signal,
    ),
  ]),
  "The daemon and its sibling",
);
assert.equal(left.exitCode, 0);
assert.deepEqual(result(sibling), ["adopted", 0]);
const leftPid = Number(await readFile(join(root, "left.pid"), "utf8"));
assert.throws(() => process.kill(leftPid, 0));
// A command stopped by its timeout, and one cancelled, while a sibling runs.
const cancel = new AbortController();
setTimeout(() => cancel.abort(), 300);
const [timed, cancelled, survivor] = await settles(
  Promise.all([
    execute("sleep 30", signal, 300),
    execute("sleep 30", cancel.signal),
    execute("sleep 1; echo sibling", signal),
  ]),
  "A stopped command or its sibling",
);
assert.equal(timed.timedOut, true);
assert.equal(cancelled.exitCode, -1);
assert.deepEqual(result(survivor), ["sibling", 0]);
// The worker's own child (rg and git run this way) shares its session: the sweep after the
// last command never kills it nor takes its exit status.
const own = spawn("sh", ["-c", "sleep 1; exit 7"], { stdio: "ignore" });
const ownExit = new Promise<number | null>((accept) =>
  own.on("exit", (code) => accept(code)),
);
assert.deepEqual(result(await execute("echo quick", signal)), ["quick", 0]);
assert.equal(await settles(ownExit, "The worker's own child"), 7);
console.log(
  "Synthetic process privacy, detached-descendant cleanup and concurrent commands passed.",
);
