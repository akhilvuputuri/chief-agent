import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { linuxProcessBoundary } from "./process-boundary.js";
import { Workspace, localExecutor, type Execution } from "./workspace.js";
const cleanup = linuxProcessBoundary("/opt/pi-runtime/process-boundary.node");
// The guard is a synchronous native call: if it froze, no timer here could fire. A child in the
// worker's own session, which the guard never touches, ends the smoke instead (journal 200). The
// CI job runs the smoke under an init process, so this process is not PID 1 and can be killed.
const watchdog = spawn(
  "sh",
  [
    "-c",
    `sleep 600; echo "Security smoke froze for 600 s; killing it" >&2; kill -KILL ${process.pid}`,
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);
watchdog.unref();
// The guard lists the worker's children here; it must be able to (journal 199).
await readFile(`/proc/${process.pid}/task/${process.pid}/children`, "utf8");
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

// Commands at once through the real guard (journal 199). Pi runs the tool calls of one message
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
// A repository model-run code configured: a partial clone missing its AGENTS.md blob, whose
// `core.sshCommand` starts a daemon outside every process group. Reading the base file must not
// run it; if anything did run, nothing may survive once no command runs (journal 199).
const repo = join(root, "configured");
await mkdir(repo);
const repoGit = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], {
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    encoding: "utf8",
  }).trim();
repoGit("init", "-q");
repoGit("config", "user.name", "Synthetic");
repoGit("config", "user.email", "synthetic@example.invalid");
await writeFile(join(repo, "AGENTS.md"), "Base rules.\n");
repoGit("add", "AGENTS.md");
repoGit("commit", "-qm", "base");
const base = repoGit("rev-parse", "HEAD");
const blob = repoGit("rev-parse", "HEAD:AGENTS.md");
const configured = join(root, "configured.pid");
repoGit("config", "core.repositoryformatversion", "1");
repoGit("config", "extensions.partialClone", "origin");
repoGit("config", "remote.origin.url", "ssh://synthetic.invalid/repo.git");
repoGit("config", "remote.origin.promisor", "true");
repoGit(
  "config",
  "core.sshCommand",
  `cd '${root}' && ${daemonCommand("configured.pid")}; false`,
);
await rm(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
const reviewed = await new Workspace(repo).initialize();
const reader = localExecutor(repo, join(root, "review-home"));
assert.equal(await reviewed.hasCommit(reader, signal, base), true);
assert.equal(
  await reviewed.committedFile(reader, signal, base, "AGENTS.md"),
  undefined,
);
const ran = await access(configured).then(
  () => true,
  () => false,
);
if (ran)
  assert.throws(() =>
    process.kill(Number(readFileSync(configured, "utf8")), 0),
  );
assert.equal(ran, false, "The repository's configured program ran");

// Command descendants still running, possibly large, when the command's shell exits (journal
// 200). A coding box lost the result of `kite run check 2>&1 | grep -iE "error" | head; git status
// --short` to "Command descendant cleanup failed". head exits after ten lines, the writers upstream
// die of EPIPE, and a test process they started keeps running, re-parented to this subreaper (seen
// on macOS in four of four runs). `finish` SIGKILLs it and the sweep must reap it. SIGKILL is
// certain but not instant: the kernel frees the address space before the process can be reaped,
// so the sweep waits for each reap instead of a fixed window. Each case below runs through the
// real guard and names itself if it fails.
await writeFile(
  join(root, "big.js"),
  // In chunks of at most 1 GiB, under any Buffer size limit.
  "const b = [];\n" +
    "for (let left = Number(process.argv[2]); left > 0; left -= 1024)\n" +
    "  b.push(Buffer.alloc(Math.min(left, 1024) * 1048576, 1));\n" +
    'require("node:fs").writeFileSync(process.argv[3], "1");\n' +
    "setInterval(() => b[0][0]++, 1000);\n",
);
/** Milliseconds from SIGKILL until Node sees the exit of a child holding `mib` MiB, measured here. */
async function killToExit(mib: number) {
  const ready = join(root, `measure-${mib}.ready`);
  await rm(ready, { force: true });
  const child = spawn("node", [join(root, "big.js"), String(mib), ready], {
    stdio: "ignore",
  });
  const exited = new Promise<void>((accept) =>
    child.on("exit", () => accept()),
  );
  while (
    !(await access(ready).then(
      () => true,
      () => false,
    ))
  )
    await new Promise((accept) => setTimeout(accept, 20));
  const start = process.hrtime.bigint();
  child.kill("SIGKILL");
  await exited;
  return Number(process.hrtime.bigint() - start) / 1e6;
}
const measured: Record<string, number[]> = {};
for (const mib of [256, 1024, 2048, 6144]) {
  measured[`${mib} MiB`] = [];
  for (let i = 0; i < 3; i++)
    measured[`${mib} MiB`]!.push(Math.round(await killToExit(mib)));
}
console.log(`SIGKILL to exit, ms: ${JSON.stringify(measured)}`);
/** Asserts each pid recorded in `files` (one pid per file, under root) is gone. */
const gone = (...files: string[]) => {
  for (const file of files) {
    const recorded = Number(readFileSync(join(root, file), "utf8"));
    assert.throws(
      () => process.kill(recorded, 0),
      `process ${recorded} (${file}) still exists`,
    );
  }
};
const waitFor = (file: string) => `while [ ! -e ${file} ]; do sleep 0.05; done`;
/** The guard's own message travels as the executor error's cause (journal 200). */
const explain = (error: unknown): string =>
  error instanceof Error
    ? error.message +
      (error.cause === undefined ? "" : ` (cause: ${explain(error.cause)})`)
    : String(error);
const failed: string[] = [];
/** Runs one leftover case through the real guard; a failure is recorded under its name. */
async function leftover(name: string, command: string, ...pids: string[]) {
  try {
    const started = process.hrtime.bigint();
    const run = await settles(execute(command, signal), name);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.deepEqual(result(run), ["done", 0], "the command's own result");
    gone(...pids);
    console.log(`Leftover case passed: ${name} (${Math.round(ms)} ms)`);
  } catch (error) {
    console.log(`Leftover case FAILED: ${name}: ${explain(error)}`);
    failed.push(name);
  }
}
// 6 GiB took 170 to 472 ms to be reaped on the CI runners seen, against the old window of about
// 100 x 1 ms (about 110 ms), so this size fails against the old guard on each of them.
for (const mib of [1024, 2048, 6144]) {
  // In the command's process group, orphaned before its shell exits: killed by `finish`, reaped
  // by the sweep.
  await leftover(
    `${mib} MiB process left in the command's group`,
    `sh -c 'node big.js ${mib} grouped-${mib}.ready & echo $! > grouped-${mib}.pid'; ${waitFor(`grouped-${mib}.ready`)}; echo done`,
    `grouped-${mib}.pid`,
  );
  // A detached daemon of the same size in a session of its own: killed and reaped by the sweep.
  await leftover(
    `${mib} MiB detached daemon in its own session`,
    `setsid sh -c 'echo $$ > detached-${mib}.pid; exec node big.js ${mib} detached-${mib}.ready' & ${waitFor(`detached-${mib}.ready`)}; echo done`,
    `detached-${mib}.pid`,
  );
}
// A chain of daemons, each in a session of its own and a child of the one before: each
// generation becomes the worker's child only after its parent has died.
await writeFile(
  join(root, "chain.sh"),
  [
    'n="$1"',
    'echo $$ > "chain-$n.pid"',
    'if [ "$n" -gt 0 ]; then setsid sh ./chain.sh $((n - 1)) & else echo 1 > chain.ready; fi',
    "exec sleep 600",
    "",
  ].join("\n"),
);
const depth = 30;
await leftover(
  `chain of ${depth + 1} daemons, each in its own session`,
  `setsid sh ./chain.sh ${depth} & ${waitFor("chain.ready")}; echo done`,
  ...Array.from({ length: depth + 1 }, (_, n) => `chain-${n}.pid`),
);
// A traced leftover whose tracer is a generation later and never waits for it. The kernel shows
// a traced zombie only to its tracer, so the worker can reap the killed tracee only once the
// tracer, adopted when its parent dies, has been killed as well. A sweep that blocked on the
// tracee would freeze here (the watchdog above then fails the smoke).
await writeFile(
  join(root, "tracer.py"),
  [
    "import ctypes, os, time",
    "libc = ctypes.CDLL(None, use_errno=True)",
    "libc.ptrace.argtypes = [ctypes.c_long, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p]",
    "libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]",
    "ready_r, ready_w = os.pipe()",
    "tracee = os.fork()",
    "if tracee == 0:",
    "    # Any process may trace this one (Yama's ptrace_scope 1 otherwise allows only ancestors).",
    "    libc.prctl(0x59616D61, ctypes.c_ulong(-1).value, 0, 0, 0)",
    "    os.write(ready_w, b'1')",
    "    while True: time.sleep(60)",
    "os.read(ready_r, 1)",
    "open('traced-tracee.pid', 'w').write(str(tracee))",
    "holder = os.fork()",
    "if holder == 0:",
    "    tracer = os.fork()",
    "    if tracer == 0:",
    "        if libc.ptrace(16, tracee, None, None) == 0:",
    "            os.waitpid(tracee, 0)",
    "            status = 'attached'",
    "        else:",
    "            status = 'refused: errno %d' % ctypes.get_errno()",
    "        open('traced-tracer.pid', 'w').write(str(os.getpid()))",
    "        open('traced.status', 'w').write(status)",
    "        while True: time.sleep(60)",
    "    while True: time.sleep(60)",
    "open('traced-holder.pid', 'w').write(str(holder))",
    "while not os.path.exists('traced.status'): time.sleep(0.05)",
    "",
  ].join("\n"),
);
await leftover(
  "traced process whose tracer is a later generation and never waits",
  `setsid python3 tracer.py & ${waitFor("traced.status")}; sleep 0.2; echo done`,
  "traced-tracee.pid",
  "traced-holder.pid",
  "traced-tracer.pid",
);
const traced = readFileSync(join(root, "traced.status"), "utf8");
console.log(`Tracer case ptrace attach: ${traced}`);
// Without the attach the case above passes without ever making a traced zombie.
assert.equal(
  traced.trim(),
  "attached",
  "The tracer could not attach, so the traced-process case tested nothing",
);
assert.deepEqual(failed, [], "Leftover cases failed");
watchdog.kill();
console.log(
  "Synthetic process privacy, detached-descendant cleanup, concurrent commands, repository-configured programs and large, multi-generation or traced leftovers passed.",
);
