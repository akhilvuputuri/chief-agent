import test from "node:test";
import assert from "node:assert/strict";
import { anthropicModel } from "../src/model.js";

const resolve = async (config: Parameters<typeof anthropicModel>[0]) =>
  (await anthropicModel(config)()).model;

test("Pi's catalogue supplies the Claude model's window, output limit and Anthropic protocol", async () => {
  const model = await resolve({
    model: "claude-opus-5-5",
    baseUrl: "https://coding.example.invalid/gateway",
  });
  assert.equal(model.api, "anthropic-messages");
  assert.equal(model.baseUrl, "https://coding.example.invalid/gateway");
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxTokens, 128_000);
  assert.equal(model.compat?.forceAdaptiveThinking, true);
  const allowance = await resolve({
    model: "claude-sonnet-5-5",
    maxTokens: 64_000,
  });
  assert.equal(allowance.maxTokens, 64_000);
  assert.equal(allowance.baseUrl, "https://api.anthropic.com");
});
