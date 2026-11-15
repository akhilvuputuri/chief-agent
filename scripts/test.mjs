// `kite test` builds, then runs every TypeScript test and the other suites.
// `kite test tests/links.test.ts ...` builds, then runs only those TypeScript test files.
//
// As one chained script, names given to `kite test` went to the last command in the chain,
// so the whole TypeScript suite ran first and the run then failed (journal 197).
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The kite commands, in order, for a run of every test or of the named files only. */
export function testSteps(files) {
  return files.length
    ? [
        ["run", "build"],
        ["run", "test:ts", "--", ...files],
      ]
    : [
        ["run", "build"],
        ["run", "test:ts"],
        ["run", "test:other"],
      ];
}

if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  for (const args of testSteps(process.argv.slice(2))) {
    const { status, error } = spawnSync("kite", args, { stdio: "inherit" });
    if (error) console.error(error);
    if (status !== 0) process.exit(status ?? 1);
  }
}
