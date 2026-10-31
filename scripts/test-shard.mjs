// Runs the TypeScript tests, or one CI shard of them (TEST_SHARD=i/n). Node's own
// --test-shard splits by file count, which left shards from 83 s to 182 s (journal 138), so
// shards are balanced using each file's recorded time in tests/test-weights.json.
// Refresh it with scripts/update-test-weights.mjs; a stale or missing entry only makes
// the balance a little worse.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Each file also starts its own process.
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
  const child = spawn("tsx", ["--test", "--test-concurrency=1", ...files], {
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}
