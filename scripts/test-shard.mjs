// Runs the TypeScript tests, or one CI shard of them (TEST_SHARD=i/n).
//
// A serial run loads every file into one process (TEST_ISOLATION=shared), which takes about
// a third less time than a process per file: each process otherwise compiles the test
// database engine and loads the application again (journal 159). A file that fails there,
// or never reports, runs again in a process of its own, and that run decides the result,
// so a pass means what it meant before. CI runs files in parallel, one process each
// (TEST_ISOLATION=process), and is the reference.
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
import { tmpdir } from "node:os";
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

const run = (args) =>
  new Promise((done) => {
    const child = spawn("tsx", args, { stdio: "inherit" });
    child.on("error", (error) => {
      console.error(error);
      done(1);
    });
    child.on("exit", (code, signal) => done(signal ? 1 : (code ?? 1)));
  });

const perFile = (files, concurrency) =>
  run(["--test", `--test-concurrency=${concurrency}`, ...files]);

async function shared(files) {
  const dir = mkdtempSync(join(tmpdir(), "chief-test-run-"));
  const report = join(dir, "ran");
  try {
    const code = await run([
      "--test",
      "--experimental-test-isolation=none",
      // Naming a second reporter drops the default one, so it is named too.
      `--test-reporter=${process.stdout.isTTY ? "spec" : "tap"}`,
      "--test-reporter-destination=stdout",
      `--test-reporter=${fileURLToPath(new URL("test-ran-files.mjs", import.meta.url))}`,
      `--test-reporter-destination=${report}`,
      ...files,
    ]);
    let written = "";
    try {
      written = readFileSync(report, "utf8");
    } catch {
      // No report at all: every file is undecided.
    }
    const again = undecidedFiles(files, written);
    if (!again.length) return code;
    console.log(
      `\n${again.length} test file(s) failed or did not report in the shared process. ` +
        "Running them one process each, which decides the result:\n" +
        again.map((file) => `  ${file}`).join("\n"),
    );
    const decided = await perFile(again, "1");
    if (decided === 0)
      console.log(
        "\nThey pass on their own, so the run passes. A file that fails only in the " +
          "shared process depends on, or disturbs, another file's state.",
      );
    return decided;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  let files = allTestFiles();
  if (process.env.TEST_SHARD) {
    const { index, count } = parseShard(process.env.TEST_SHARD);
    const weights = JSON.parse(readFileSync("tests/test-weights.json", "utf8"));
    files = assignShards(files, weights, count)[index - 1];
  }
  // Serial unless asked: coding boxes run this too, and only CI has measured parallel files
  // for the SIGSEGV in journal 123 (journal 141).
  const concurrency = process.env.TEST_CONCURRENCY ?? "1";
  process.exit(
    isolationMode(process.env) === "shared"
      ? await shared(files)
      : await perFile(files, concurrency),
  );
}
