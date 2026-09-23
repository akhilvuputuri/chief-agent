import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { readModelPolicy, resolveMainModel } from "../src/model-policy.js";

test("a tracked model overrides an injected production environment value", () => {
  assert.equal(
    resolveMainModel("openai/gpt-5.6-sol", {
      schemaVersion: 1,
      main: "openai/gpt-6-sol",
    }),
    "openai/gpt-6-sol",
  );
});

test("the initial null policy preserves the existing environment model", () => {
  assert.equal(
    resolveMainModel("openai/gpt-5.6-sol", { schemaVersion: 1, main: null }),
    "openai/gpt-5.6-sol",
  );
  assert.equal(readModelPolicy().schemaVersion, 1);
});

test("a missing or invalid bundled policy fails closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "chief-model-policy-"));
  const file = join(directory, "model-policy.json");
  try {
    assert.throws(() => readModelPolicy(pathToFileURL(file)), {
      message: "Invalid bundled model policy",
    });
    for (const invalid of [
      { schemaVersion: 1, main: "not-a-model-id" },
      { schemaVersion: 1, main: "openai/gpt-6-sol", extra: "ignored" },
      { schemaVersion: 2, main: null },
    ]) {
      writeFileSync(file, JSON.stringify(invalid));
      assert.throws(() => readModelPolicy(pathToFileURL(file)), {
        message: "Invalid bundled model policy",
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
