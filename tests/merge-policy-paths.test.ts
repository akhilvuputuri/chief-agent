import { test } from "node:test";
import assert from "node:assert/strict";
import { protectedMergePath } from "../src/coding/merge-policy.js";

test("the toolchain pin and installer are protected merge paths", () => {
  // tools/ decides which package-manager binary every build runs.
  for (const path of [
    "tools/lockstep.json",
    "tools/install-lockstep.mjs",
    "coding_runtime_pi/Dockerfile",
    "coding_runtime_pi/package.json",
    "coding_runtime_pi/src/runtime.ts",
    ".github/actions/setup-lockstep/action.yml",
  ])
    assert.equal(protectedMergePath(path), true, path);
  for (const path of ["docs/coding.md", "toolsets/notes.md", "src/news.ts"])
    assert.equal(protectedMergePath(path), false, path);
});
