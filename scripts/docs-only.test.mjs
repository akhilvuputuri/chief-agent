import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDocsOnly } from "./docs-only.mjs";

const script = fileURLToPath(new URL("./docs-only.mjs", import.meta.url));

test("documentation alone counts as docs-only", () => {
  assert.equal(isDocsOnly(["docs/releases.md"]), true);
  assert.equal(isDocsOnly(["docs/journey/data/x.csv", "README.md", ""]), true);
  assert.equal(isDocsOnly(["HANDOVER.md", "CONTRIBUTING.md"]), true);
});

test("anything else runs every job", () => {
  for (const path of [
    "src/main.ts",
    "tests/core.test.ts",
    ".github/workflows/ci.yml",
    "scripts/docs-only.mjs",
    "package-lock.json",
    "AGENTS.md",
    "CLAUDE.md",
    "REVIEW.md",
    "plugins/core/agents/daily.md",
    "coding_runtime/README.md",
    "evals/README.md",
    "docsy/a.md",
    "docs/../src/main.ts",
    " docs/evil.ts",
    " README.md",
  ])
    assert.equal(isDocsOnly(["docs/a.md", path]), false, path);
});

test("an empty change list runs every job", () => {
  assert.equal(isDocsOnly([]), false);
  assert.equal(isDocsOnly(["", "  "]), false);
});

test("the command prints the decision for changed paths on stdin", () => {
  const run = (input) =>
    spawnSync(process.execPath, [script], { input, encoding: "utf8" }).stdout;
  assert.equal(run("docs/a.md\nREADME.md\n"), "true\n");
  assert.equal(run("docs/a.md\nsrc/main.ts\n"), "false\n");
  assert.equal(run(""), "false\n");
});

test("the required gate only accepts skipped jobs on a docs-only pull request", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const gate = /echo "\$RESULTS \(docs only.*?\n {10}done\n/s.exec(
    workflow,
  )?.[0];
  assert.ok(gate, "gate script not found in ci.yml");
  const passes = (
    RESULTS,
    DOCS_ONLY,
    CHANGES = "success",
    STATIC = "success",
  ) =>
    spawnSync("bash", ["-e", "-c", gate], {
      env: { ...process.env, RESULTS, DOCS_ONLY, CHANGES, STATIC },
    }).status === 0;
  assert.equal(passes("success success success", "false"), true);
  assert.equal(passes("success success skipped skipped", "true"), true);
  // A skipped job followed by a passing one must not slip through on a code change.
  assert.equal(passes("success skipped success", "false"), false);
  assert.equal(passes("skipped success", ""), false);
  assert.equal(passes("success failure skipped", "true"), false);
  assert.equal(passes("success cancelled skipped", "true"), false);
  assert.equal(passes("failure success skipped", "", "failure"), false);
  assert.equal(
    passes("success skipped skipped", "true", "success", "skipped"),
    false,
  );
});
