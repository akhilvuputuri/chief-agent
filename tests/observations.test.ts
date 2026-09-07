import { test } from "node:test";
import assert from "node:assert/strict";
import { projectObservation } from "../src/observations.js";
test("work updates do not repeat unbounded receipts or source bodies", () => {
  const input = {
    result: {
      task: { id: "t", revision: 1 },
      steps: [],
      counts: { total: 0 },
      receipts: Array(1000).fill({ body: "x".repeat(10000) }),
    },
  };
  const result = projectObservation("work_step", input, "observation");
  assert.ok(JSON.stringify(result).length < 1000);
  assert.equal(result.observationId, "observation");
});
test("collection projections retain identities while omitting long descriptions", () => {
  const result = projectObservation(
    "job_list",
    {
      result: Array.from({ length: 22 }, (_, i) => ({
        id: String(i),
        title: "Role " + i,
        description: "x".repeat(10000),
      })),
    },
    "saved",
  );
  assert.equal(result.result.length, 22);
  assert.equal(result.result[21].id, "21");
  assert.equal(result.result[0].descriptionTruncated, true);
});
