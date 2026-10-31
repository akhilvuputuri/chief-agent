// Refreshes tests/test-weights.json from a checks run:
//   gh run view <run id> --log | node scripts/update-test-weights.mjs
// The test log has no per-file lines, so each test's duration is credited to the file
// that declares its title; a `${...}` in a title matches anything. Titles built any other
// way, or used in two files, are skipped.
//
// One run's times also carry that run's runner speeds, which varied by up to 2x between
// shards (journal 138), so refresh only when shards have clearly drifted apart.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allTestFiles } from "./test-shard.mjs";

const TITLE = /\btest(?:\.\w+)?\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/gs;

export function testTitles(sources) {
  const owners = new Map();
  for (const [file, text] of Object.entries(sources))
    for (const match of text.matchAll(TITLE)) {
      const title = match[2].replace(/\\(["'`\\])/g, "$1");
      owners.set(title, [...(owners.get(title) ?? []), file]);
    }
  return owners;
}

/** The owning files of a logged title: an exact title, else a templated one that matches. */
function ownersOf(title, owners, templates) {
  return (
    owners.get(title) ?? templates.find(([pattern]) => pattern.test(title))?.[1]
  );
}

export function weightsFromLog(log, owners) {
  const templates = [...owners]
    .filter(([title]) => title.includes("${"))
    .map(([title, files]) => [
      new RegExp(
        `^${title
          .split(/\$\{[^}]*\}/)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
        "s",
      ),
      files,
    ]);
  const totals = {};
  const open = new Map();
  for (const line of log.split("\n")) {
    const row = /^(tests \d+\/\d+)\t[^\t]*\t\S+Z (.*)$/.exec(line);
    if (!row) continue;
    const [, shard, body] = row;
    const result = /^(?:not )?ok \d+ - (.*?)(?: # .*)?$/.exec(body);
    if (result) {
      open.set(shard, result[1]);
      continue;
    }
    const duration = /^ {2}duration_ms: ([\d.]+)/.exec(body);
    if (!duration || !open.has(shard)) continue;
    const files = ownersOf(open.get(shard), owners, templates);
    open.delete(shard);
    if (files?.length === 1)
      totals[files[0]] = (totals[files[0]] ?? 0) + Number(duration[1]) / 1000;
  }
  return Object.fromEntries(
    Object.entries(totals)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, seconds]) => [file, Math.round(seconds * 10) / 10]),
  );
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  const sources = Object.fromEntries(
    allTestFiles().map((file) => [file, readFileSync(file, "utf8")]),
  );
  const weights = weightsFromLog(readFileSync(0, "utf8"), testTitles(sources));
  // A cut-off log would otherwise silently drop files and under-weight the last one.
  const expected = Object.keys(sources).length;
  if (Object.keys(weights).length < expected * 0.95)
    throw new Error(
      `Only ${Object.keys(weights).length} of ${expected} test files have durations; is that log complete?`,
    );
  writeFileSync(
    "tests/test-weights.json",
    `${JSON.stringify(weights, null, 2)}\n`,
  );
}
