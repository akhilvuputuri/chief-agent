// Runs the TypeScript tests, or one CI shard of them (TEST_SHARD=i/n), or only the test files
// named on the command line: `kite test tests/links.test.ts` (journal 197).
//
// A serial run loads every file into one process (TEST_ISOLATION=shared), which takes about
// a third less time than a process per file: each process otherwise compiles the test
// database engine and loads the application again (journal 159). The shared run's passes
// are used only if its process exits cleanly: a file that fails there or never reports
// runs again in a process of its own, and a failure the shared run cannot attribute, or a
// crash, sends every file through a process of its own (see rerunPlan). CI runs files in
// parallel, one process each (TEST_ISOLATION=process), and is the reference.
//
// In the shared process node imports every file before running any test, and a hook at
// the top of one file runs around every file's tests.
//
// A serial run of many files uses several such processes at once (TEST_WORKERS, by default
// one per CPU up to four). Each takes the next group of files from a queue, so no recorded
// timing decides how the work is split (journal 201). TEST_WORKERS=1 is the single shared
// process.
//
// Node's own
// --test-shard splits by file count, which left shards from 83 s to 182 s (journal 138), so
// shards are balanced using each file's recorded time in tests/test-weights.json.
// Refresh it with scripts/update-test-weights.mjs; a stale or missing entry only makes
// the balance a little worse.
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Each file also starts its own process in CI, where shards are used.
const STARTUP_SECONDS = 1;

export function assignShards(files, weights, count) {
  const known = files.map((f) => weights[f]).filter((w) => w !== undefined);
  const sorted = [...known].sort((a, b) => a - b);
  const fallback = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const seconds = (file) => (weights[file] ?? fallback) + STARTUP_SECONDS;
  const shards = Array.from({ length: count }, () => ({ total: 0, files: [] }));
  const heaviestFirst = [...files].sort(
    (a, b) => seconds(b) - seconds(a) || a.localeCompare(b),
  );
  for (const file of heaviestFirst) {
    const lightest = shards.reduce((a, b) => (b.total < a.total ? b : a));
    lightest.files.push(file);
    lightest.total += seconds(file);
  }
  return shards.map((shard) => shard.files.sort());
}

export function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || index < 1 || index > count)
    throw new Error(`Invalid TEST_SHARD: ${value}`);
  return { index, count };
}

export function allTestFiles(dir = "tests") {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts"))
    .sort()
    .map((f) => `${dir}/${f}`);
}

/**
 * The test files named on the command line, as `all` spells them. A name that is not one of
 * the files a full run would run is an error, so a mistyped name cannot pass by running
 * nothing.
 */
export function namedTestFiles(names, all, cwd = process.cwd()) {
  const files = [
    ...new Set(names.map((name) => relative(cwd, resolve(cwd, name)))),
  ];
  const unknown = files.filter((file) => !all.includes(file));
  if (unknown.length)
    throw new Error(
      `Not a TypeScript test file in tests/: ${unknown.join(", ")}. ` +
        "Name files such as tests/links.test.ts. A script test runs with " +
        "`node --test scripts/NAME.test.mjs`.",
    );
  return files.sort();
}

/** The files one run covers: the named ones, one shard of `all`, or all of them. */
export function selectFiles(names, env, all, readWeights) {
  if (names.length) {
    if (env.TEST_SHARD)
      throw new Error("TEST_SHARD does not apply to named test files.");
    return namedTestFiles(names, all);
  }
  if (!env.TEST_SHARD) return all;
  const { index, count } = parseShard(env.TEST_SHARD);
  return assignShards(all, readWeights(), count)[index - 1];
}

/** "shared" for a serial run unless told otherwise; parallel files need their own processes. */
export function isolationMode(env) {
  const concurrency = env.TEST_CONCURRENCY ?? "1";
  const mode =
    env.TEST_ISOLATION ?? (concurrency === "1" ? "shared" : "process");
  if (mode !== "shared" && mode !== "process")
    throw new Error(`Invalid TEST_ISOLATION: ${mode}`);
  if (mode === "shared" && concurrency !== "1")
    throw new Error("TEST_ISOLATION=shared runs one file at a time");
  return mode;
}

/**
 * The files a shared-process run leaves undecided: those with a failed test, and those
 * that never reported one, because the process died or exited before reaching them.
 * `report` is what scripts/test-ran-files.mjs wrote.
 */
export function undecidedFiles(files, report, cwd = process.cwd()) {
  const ran = new Set();
  const failed = new Set();
  for (const line of report.split("\n")) {
    const [kind, ...rest] = line.split(" ");
    const file = relative(cwd, resolve(cwd, rest.join(" ")));
    if (kind === "ran") ran.add(file);
    if (kind === "failed") failed.add(file);
  }
  return files.filter((file) => failed.has(file) || !ran.has(file));
}

/**
 * What must still run, one process per file, after a shared-process run. `first` decides
 * the result if it fails; `thenIfPassed` runs only when `first` passed.
 *
 * A shared run is believed only when it ran to its end and exited cleanly. A run cut
 * short can stop a file halfway after it has reported a test, whether by a crash or by
 * another file's leftover timer calling process.exit(0). And node can fail a run without
 * naming a file (a timer that throws after its test ended, a failing global hook). So
 * after a run that did not complete every file runs again, and a failed run that its
 * named failures do not explain is not passed until every other file has run on its own
 * too.
 */
export function rerunPlan({ files, undecided, code, crashed, complete }) {
  if (crashed || !complete) return { first: files, thenIfPassed: [] };
  if (code === 0) return { first: undecided, thenIfPassed: [] };
  if (!undecided.length) return { first: files, thenIfPassed: [] };
  return {
    first: undecided,
    thenIfPassed: files.filter((file) => !undecided.includes(file)),
  };
}

/** How long a finished process's output is waited for; a child it left can hold the pipe. */
const DRAIN_MS = 2000;

/**
 * Runs tsx. With `sink`, an array, the process's output is collected there instead of
 * going to the terminal, so several runs at once do not mix their reports.
 */
const run = (args, sink) =>
  new Promise((done) => {
    const child = spawn("tsx", args, {
      stdio: sink ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    const ended = [child.stdout, child.stderr].filter(Boolean).map(
      (stream) =>
        new Promise((end) => {
          stream.on("data", (data) => sink.push(data));
          stream.on("end", end);
        }),
    );
    child.on("error", (error) => {
      console.error(error);
      done({ code: 1, crashed: true });
    });
    child.on("exit", async (code, signal) => {
      await Promise.race([
        Promise.all(ended),
        new Promise((timeout) => setTimeout(timeout, DRAIN_MS).unref()),
      ]);
      // A child the tests left running must not keep this run waiting on its pipe.
      child.stdout?.destroy();
      child.stderr?.destroy();
      done({ code: signal ? 1 : (code ?? 1), crashed: Boolean(signal) });
    });
  });

const perFile = async (files, concurrency, sink) =>
  (await run(["--test", `--test-concurrency=${concurrency}`, ...files], sink))
    .code;

const list = (files) => files.map((file) => `  ${file}`).join("\n");

/** A run of fewer files than this stays in one shared process. */
const FEWEST_FILES_FOR_WORKERS = 24;

/**
 * Deals files into `count` groups. Dealing them round, not in runs, spreads files with
 * similar names, which are often similar in weight, over the groups.
 */
export function fileGroups(files, count) {
  const groups = Array.from(
    { length: Math.max(1, Math.min(count, files.length)) },
    () => [],
  );
  files.forEach((file, i) => groups[i % groups.length].push(file));
  return groups;
}

/** How many shared processes a serial run uses at once: TEST_WORKERS, or the CPUs up to four. */
export function workerCount(env, cpus = availableParallelism()) {
  const value = env.TEST_WORKERS;
  if (value === undefined) return Math.max(1, Math.min(4, cpus));
  if (!/^[1-9]\d?$/.test(value))
    throw new Error(`Invalid TEST_WORKERS: ${value}`);
  return Number(value);
}

/**
 * One shared-process run of `files`, then the reruns it calls for. With `sink` every line
 * goes there instead of to the terminal.
 */
async function shared(files, sink) {
  const say = (text) =>
    sink ? sink.push(Buffer.from(`${text}\n`)) : console.log(text);
  const dir = mkdtempSync(join(tmpdir(), "chief-test-run-"));
  const report = join(dir, "ran");
  try {
    const { code, crashed } = await run(
      [
        "--test",
        "--experimental-test-isolation=none",
        // Naming a second reporter drops the default one, so it is named too.
        `--test-reporter=${process.stdout.isTTY ? "spec" : "tap"}`,
        "--test-reporter-destination=stdout",
        `--test-reporter=${fileURLToPath(new URL("test-ran-files.mjs", import.meta.url))}`,
        `--test-reporter-destination=${report}`,
        ...files,
      ],
      sink,
    );
    let written = "";
    try {
      written = readFileSync(report, "utf8");
    } catch {
      // No report at all: every file is undecided.
    }
    const undecided = undecidedFiles(files, written);
    const complete = written.split("\n").includes("complete");
    const { first, thenIfPassed } = rerunPlan({
      files,
      undecided,
      code,
      crashed,
      complete,
    });
    if (!first.length) return code;
    say(
      (crashed || !complete
        ? "\nThe shared process stopped before finishing, so its results are not used. "
        : code !== 0 && !undecided.length
          ? "\nThe shared process failed without naming a test file. "
          : `\n${first.length} test file(s) failed or did not report in the shared process. `) +
        `Running ${first.length === files.length ? "every file" : "them"} one process each, which decides the result:\n` +
        list(first),
    );
    const decided = await perFile(first, "1", sink);
    if (decided !== 0) return decided;
    if (!thenIfPassed.length) {
      // Only a failed shared run says anything about files disturbing each other.
      if (complete && !crashed && code !== 0)
        say(
          "\nThey pass on their own. A file that fails only in the shared process " +
            "depends on, or disturbs, another file's state.",
        );
      return 0;
    }
    say(
      "\nThey pass on their own, which leaves the shared run's failure unexplained. " +
        `Running the other ${thenIfPassed.length} file(s) one process each before deciding.`,
    );
    return perFile(thenIfPassed, "1", sink);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A serial run on several shared processes at once. The files are dealt into two groups a
 * worker, and each worker takes the next group from the queue, so a slow group delays only
 * itself. A process costs about 7 s of CPU to start, so more, smaller groups are slower:
 * 6 groups took 197 s and 40 groups 304 s on three CPUs (journal 201). A group's whole
 * report is printed when the group ends.
 */
export async function sharedGroups(
  files,
  workers,
  runGroup = shared,
  // Resolves once the text has left this process: a write to a pipe can still be pending
  // when the run ends, and exiting then would drop it.
  write = (text) => new Promise((sent) => process.stdout.write(text, sent)),
) {
  const queue = fileGroups(files, workers * 2);
  const total = queue.length;
  let failed = 0;
  await write(
    `# ${total} groups of test files on ${Math.min(workers, total)} processes at once.\n`,
  );
  await Promise.all(
    Array.from({ length: Math.min(workers, total) }, async () => {
      for (let group; (group = queue.shift());) {
        const sink = [];
        try {
          if ((await runGroup(group, sink)) !== 0) failed += 1;
        } catch (error) {
          // The group's run could not be made or cleaned up: it fails, and the others go on.
          failed += 1;
          sink.push(Buffer.from(`${error?.stack ?? error}\n`));
        }
        await write(Buffer.concat(sink));
      }
    }),
  );
  await write(
    failed
      ? `\n# ${failed} of ${total} groups of test files failed: see the failures above.\n`
      : `\n# All ${total} groups of test files passed.\n`,
  );
  return failed ? 1 : 0;
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  const names = process.argv.slice(2);
  let files;
  try {
    files = selectFiles(names, process.env, allTestFiles(), () =>
      JSON.parse(readFileSync("tests/test-weights.json", "utf8")),
    );
  } catch (error) {
    if (!names.length) throw error;
    console.error(error.message);
    process.exit(2);
  }
  // With a process per file, one file runs at a time unless asked: only CI has measured
  // several at once for the SIGSEGV in journal 123 (journal 141). Shared workers also run
  // test processes side by side; a group that crashes runs its own files again one process
  // each, and no crash was seen in 23 such runs on a CI machine (journal 201).
  const concurrency = process.env.TEST_CONCURRENCY ?? "1";
  if (isolationMode(process.env) !== "shared")
    process.exit(await perFile(files, concurrency));
  let workers;
  try {
    workers = workerCount(process.env);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  process.exit(
    workers > 1 && files.length >= FEWEST_FILES_FOR_WORKERS
      ? await sharedGroups(files, workers)
      : await shared(files),
  );
}
