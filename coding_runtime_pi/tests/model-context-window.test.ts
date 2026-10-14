import test from "node:test";
import assert from "node:assert/strict";
import { compatibleModel } from "../src/model.js";

const resolve = async (config: Parameters<typeof compatibleModel>[0]) =>
  (await compatibleModel(config)(async () => {})).model.contextWindow;

test("host fallback window applies only to models Pi's catalog does not know", async () => {
  const baseUrl = "https://coding.example.invalid/v1";
  const unknown = {
    provider: "openrouter",
    model: "synthetic/uncatalogued",
    baseUrl,
  };
  assert.equal(await resolve(unknown), 32000);
  assert.equal(
    await resolve({ ...unknown, fallbackContextWindow: 1_048_576 }),
    1_048_576,
  );
  const known = {
    provider: "openrouter",
    model: "openai/gpt-6.1-sol",
    baseUrl,
  };
  const catalogued = await resolve(known);
  assert.ok(catalogued > 32000);
  assert.equal(
    await resolve({ ...known, fallbackContextWindow: 5000 }),
    catalogued,
  );
  assert.equal(
    await resolve({
      ...unknown,
      contextWindow: 64000,
      fallbackContextWindow: 1_048_576,
    }),
    64000,
  );
});
