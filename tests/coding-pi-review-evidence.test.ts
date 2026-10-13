import { test } from "node:test";
import assert from "node:assert/strict";
import { piReviewInstructions } from "../src/coding/pi-worker.js";

test("Pi reviewer is directed to the exact changed-path inventory and complete diff", () => {
  const prompt = piReviewInstructions({
    candidateHash: "a".repeat(64),
    baseSha: "b".repeat(40),
    fileCount: 3,
    plan: "Fix addition only",
    context: "Preserve all unrelated behavior",
    checks: [{ command: "npm run check", exitCode: 0, output: "passed" }],
  });
  assert.match(prompt, /candidate_inventory/);
  assert.match(prompt, /candidate_diff/);
});
