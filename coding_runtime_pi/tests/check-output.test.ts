import test from "node:test";
import assert from "node:assert/strict";
import { checkOutput } from "../src/runtime.js";

test("a failing check keeps its failures even when they are far from the end", () => {
  const output = [
    "TAP version 13",
    "not ok 12 - study saves stay owner-scoped",
    "  error: 'Expected values to be strictly equal'",
    "  expected: 1",
    "  actual: 2",
    ...Array.from({ length: 4000 }, (_, i) => `ok ${i} - passing test`),
    "# fail 1",
  ].join("\n");
  const kept = checkOutput({ exitCode: 1, output });
  assert(kept.length <= 7800 + 20);
  assert.match(
    kept,
    /^\[Output truncated\]\n\[Failures\]\nnot ok 12 - study saves stay owner-scoped/,
  );
  assert.match(kept, /actual: 2/);
  assert.match(kept, /# fail 1$/);
});

test("a passing check, or a failure with nothing recognisable, keeps the tail", () => {
  const output = "x".repeat(9000) + "\nfinished";
  assert.equal(
    checkOutput({ exitCode: 0, output }),
    "[Output truncated]\n" + output.slice(-7800),
  );
  assert.equal(checkOutput({ exitCode: 2, output: "boom" }), "boom");
});

test("cuts never split a character", () => {
  const emoji = "\u{1F600}";
  const line = "not ok 1 - " + "a".repeat(388) + emoji + "rest";
  const tail = emoji + "b".repeat(7799);
  for (const output of [line, tail, line + "\n" + tail])
    for (const exitCode of [0, 1]) {
      const kept = checkOutput({ exitCode, output });
      assert.equal(Buffer.from(kept).toString(), kept);
    }
});
