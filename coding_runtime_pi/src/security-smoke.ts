import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { linuxProcessBoundary } from "./process-boundary.js";
import { localExecutor } from "./workspace.js";
const cleanup = linuxProcessBoundary("/opt/pi-runtime/process-boundary.node");
const root = await mkdtemp(join(tmpdir(), "pi-isolation-"));
const execute = localExecutor(root, join(root, "home"), cleanup);
const signal = new AbortController().signal;
const privateEnvironment = await execute(
  `test -z "$CODING_TEST_SECRET" && ! cat /proc/${process.pid}/environ >/dev/null 2>&1 && ! cat /proc/${process.pid}/mem >/dev/null 2>&1`,
  signal,
  1000,
);
assert.equal(privateEnvironment.exitCode, 0);
const daemon = await execute(
  `node -e 'const {spawn}=require("node:child_process");const fs=require("node:fs");const p=spawn("node",["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});fs.writeFileSync("daemon.pid",String(p.pid));p.unref();'`,
  signal,
  3000,
);
assert.equal(daemon.exitCode, 0);
const pid = Number(await readFile(join(root, "daemon.pid"), "utf8"));
assert.throws(() => process.kill(pid, 0));
console.log(
  "Synthetic process privacy and detached-descendant cleanup passed.",
);
