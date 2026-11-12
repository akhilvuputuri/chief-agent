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
  resolveJudgeSecondModel,
  resolveMainModel,
  resolveAnthropicModel,
  resolvePriceCeilings,
} from "../src/model-policy.js";
import { AnthropicDirect } from "../src/anthropic.js";

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
  // The judge was another family so it would not grade its own work. On 11 November 2026 the
  // owner chose Opus 5.5, the main and learner model, for its judgement (journal 164). Without
  // one in the policy it uses the standard tier.
  assert.equal(resolveJudgeModel("main/model"), "anthropic/claude-opus-5.5");
  // The cross-check of a nightly sample is another family than the judge, or it checks
  // nothing the judge's own repeats do not; without one in the policy there is none.
  assert.equal(resolveJudgeSecondModel(), "openai/gpt-6.1-sol");
  assert.notEqual(
    resolveJudgeSecondModel()!.split("/")[0],
    resolveJudgeModel("main/model").split("/")[0],
  );
  assert.equal(
    resolveJudgeSecondModel({ ...bundled, judgeSecond: undefined }),
    undefined,
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

test("the reviewed Anthropic map lists native IDs and first-party prices, and nothing is derived", () => {
  const bundled = readModelPolicy();
  assert.deepEqual(
    resolveAnthropicModel("anthropic/claude-opus-5.5", bundled),
    {
      nativeModel: "claude-opus-5-5",
      prices: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      fallback: true,
    },
  );
  assert.deepEqual(
    resolveAnthropicModel("anthropic/claude-sonnet-5.5", bundled),
    {
      nativeModel: "claude-sonnet-5-5",
      prices: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
      fallback: true,
    },
  );
  assert.deepEqual(
    resolveAnthropicModel("anthropic/claude-haiku-5.5", bundled),
    {
      nativeModel: "claude-haiku-5-5",
      prices: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
      fallback: true,
    },
  );
  // Every Claude model the policy uses is mapped, so it can go direct.
  for (const slug of [
    bundled.main!,
    bundled.judge!,
    ...Object.values(bundled.agents!.tiers),
  ])
    assert(resolveAnthropicModel(slug, bundled), slug);
  assert.equal(
    resolveAnthropicModel("google/gemini-3.8-flash", bundled),
    undefined,
  );
  assert.equal(resolveAnthropicModel("anthropic/toString", bundled), undefined);
  assert.equal(
    resolveAnthropicModel("anthropic/claude-opus-5.5", {
      schemaVersion: 1,
      main: null,
    }),
    undefined,
  );
  // Every mapped model is one the direct adapter supports, so a key never fails startup,
  // and its list price fits the reviewed ceilings, so it would actually route direct.
  for (const [slug, entry] of Object.entries(
    bundled.providers!.anthropic!.models,
  )) {
    const { id, ...prices } = entry;
    assert.doesNotThrow(
      () =>
        new AnthropicDirect("test", { model: slug, nativeModel: id, prices }),
      slug,
    );
    assert.ok(prices.input <= bundled.priceCeilings!.input, slug);
    assert.ok(prices.output <= bundled.priceCeilings!.output, slug);
  }
  const directory = mkdtempSync(join(tmpdir(), "chief-model-policy-"));
  const file = join(directory, "model-policy.json");
  const entry = {
    id: "claude-opus-5-5",
    input: 4,
    output: 20,
    cacheRead: 0.2,
    cacheWrite: 5,
  };
  try {
    for (const providers of [
      { anthropic: { models: { "anthropic/claude-opus-5.5": entry } } },
      {
        anthropic: {
          fallback: true,
          models: { "google/gemini-3.8-flash": entry },
        },
      },
      {
        anthropic: {
          fallback: true,
          models: { "anthropic/claude-opus-5.5": { ...entry, id: "Opus" } },
        },
      },
      {
        anthropic: {
          fallback: true,
          models: { "anthropic/claude-opus-5.5": { ...entry, cacheWrite: 0 } },
        },
      },
      {
        anthropic: {
          fallback: true,
          models: { "anthropic/claude-opus-5.5": { ...entry, batch: 2 } },
        },
      },
      { anthropic: { fallback: "yes", models: {} } },
      { openai: { fallback: true, models: {} } },
    ]) {
      writeFileSync(
        file,
        JSON.stringify({ schemaVersion: 1, main: null, providers }),
      );
      assert.throws(
        () => readModelPolicy(pathToFileURL(file)),
        {
          message: "Invalid bundled model policy",
        },
        JSON.stringify(providers),
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
