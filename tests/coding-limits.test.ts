import { test } from "node:test";
import assert from "node:assert/strict";
import { codingSettings } from "../src/coding/schema.js";
import { settings } from "./helpers/coding-fixture.js";

// Boxes have no CodeBuild-era 45-minute cap, so attempts may run longer and do more.
test("coding limits allow up to four hours, 2,000 model calls and 5,000 tool calls", () => {
  const limits = (l: object) =>
    codingSettings.safeParse({
      ...settings,
      limits: { ...settings.limits, ...l },
    }).success;
  assert.equal(limits({ ms: 5_400_000, models: 800, tools: 2000 }), true);
  assert.equal(limits({ ms: 14_400_000, models: 2000, tools: 5000 }), true);
  assert.equal(limits({ ms: 14_400_001 }), false);
  assert.equal(limits({ models: 2001 }), false);
  assert.equal(limits({ tools: 5001 }), false);
});

test("checkpoints and publishing accept large changes: 1 MB files, 500 files, 10 MB in all", async () => {
  const { checkpoint } = await import("../src/coding/schema.js");
  const file = (n: number, size: number) => ({
    path: `docs/large-${n}.md`,
    content: "a".repeat(size),
  });
  assert.ok(
    checkpoint.safeParse({ files: [file(1, 1_000_000), file(2, 900_000)] })
      .success,
  );
  assert.equal(
    checkpoint.safeParse({ files: [file(1, 1_000_001)] }).success,
    false,
  );
  assert.ok(
    checkpoint.safeParse({
      files: Array.from({ length: 500 }, (_, n) => file(n, 10)),
    }).success,
  );
  assert.equal(
    checkpoint.safeParse({
      files: Array.from({ length: 501 }, (_, n) => file(n, 10)),
    }).success,
    false,
  );
  const { validateFiles } = await import("../src/coding/github.js");
  validateFiles(Array.from({ length: 4 }, (_, n) => file(n, 900_000)));
  assert.throws(
    () => validateFiles(Array.from({ length: 11 }, (_, n) => file(n, 999_000))),
    /exceeds supported size/,
  );
});
