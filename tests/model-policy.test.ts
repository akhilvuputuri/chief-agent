import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  readModelPolicy,
  resolveAgentModel,
  resolveJudgeModel,
  resolveMainModel,
  resolvePriceCeilings,
} from "../src/model-policy.js";

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

test("reviewed policy price ceilings replace the environment's, and stay bounded", () => {
  const environment = { input: 2, output: 10 };
  assert.deepEqual(
    resolvePriceCeilings(environment, { schemaVersion: 1, main: null }),
    environment,
  );
  assert.deepEqual(
    resolvePriceCeilings(environment, {
      schemaVersion: 1,
      main: "anthropic/claude-opus-5.5",
      priceCeilings: { input: 4, output: 20 },
    }),
    { input: 4, output: 20 },
  );
  // The bundled policy names a main model whose listed price fits its own ceilings.
  const bundled = readModelPolicy();
  assert.equal(bundled.main, "anthropic/claude-opus-5.5");
  // The judge is another family than the main and learner models, so it does not grade its
  // own work; without one in the policy it falls back to the standard tier.
  assert.equal(resolveJudgeModel("main/model"), "openai/gpt-6.1-sol");
  assert.notEqual(
    resolveJudgeModel("main/model").split("/")[0],
    bundled.main!.split("/")[0],
  );
  assert.equal(
    resolveJudgeModel("main/model", { ...bundled, judge: undefined }),
    resolveAgentModel("standard", "main/model").model,
  );
  assert.deepEqual(bundled.priceCeilings, { input: 4, output: 20 });
  const directory = mkdtempSync(join(tmpdir(), "chief-model-policy-"));
  const file = join(directory, "model-policy.json");
  try {
    for (const priceCeilings of [
      { input: 0, output: 20 },
      { input: 4 },
      { input: 4, output: 20, cached: 1 },
      { input: 1000, output: 20 },
    ]) {
      writeFileSync(
        file,
        JSON.stringify({ schemaVersion: 1, main: null, priceCeilings }),
      );
      assert.throws(() => readModelPolicy(pathToFileURL(file)), {
        message: "Invalid bundled model policy",
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
