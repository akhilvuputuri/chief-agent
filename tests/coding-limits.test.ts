import { test } from "node:test";
import assert from "node:assert/strict";
import { codingSettings } from "../src/coding/schema.js";
import { settings } from "./helpers/coding-fixture.js";

// Boxes have no CodeBuild-era 45-minute cap, so attempts may run longer and do more.
test("coding limits allow up to two hours, 1,000 model calls and 2,500 tool calls", () => {
  const limits = (l: object) =>
    codingSettings.safeParse({
      ...settings,
      limits: { ...settings.limits, ...l },
    }).success;
  assert.equal(limits({ ms: 5_400_000, models: 800, tools: 2000 }), true);
  assert.equal(limits({ ms: 7_200_000, models: 1000, tools: 2500 }), true);
  assert.equal(limits({ ms: 7_200_001 }), false);
  assert.equal(limits({ models: 1001 }), false);
  assert.equal(limits({ tools: 2501 }), false);
});
