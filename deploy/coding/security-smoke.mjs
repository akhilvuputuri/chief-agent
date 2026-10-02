import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

assert.equal(process.getuid(), 1000);
assert(process.execArgv.includes("--disable-sigusr1"));
assert.equal(
  createRequire(import.meta.url)("./secure-process.node").lockdown(),
  true,
);
const parent = process.pid;
execFileSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
  import {readFileSync} from 'node:fs';
  let denied=false;
  try {readFileSync('/proc/${parent}/environ');} catch(e) {denied=e.code==='EACCES'||e.code==='EPERM';}
  if(!denied) process.exit(1);
  process.kill(${parent},'SIGUSR1');
`,
  ],
  { env: { PATH: process.env.PATH }, stdio: "pipe" },
);
await new Promise((resolve) => setTimeout(resolve, 100));
let inspector = false;
try {
  const r = await fetch("http://127.0.0.1:9229/json/list", {
    signal: AbortSignal.timeout(1000),
  });
  inspector = r.ok;
} catch {}
assert.equal(inspector, false);
console.log("Worker process capability is protected from same-UID commands.");
