import { test } from "node:test";
import assert from "node:assert/strict";
import { codingDestination } from "../src/coding/delivery-routing.js";

test("every coding job message, including decisions and results, routes to Coding", () => {
  for (const payload of [
    { key: "fixture", stage: "planning", summary: "Milestone" },
    { summary: "Paused" },
    {
      summary: "Draft PR ready",
      url: "https://github.com/example/repo/pull/1",
    },
    { summary: "Question", question: "Clarify scope" },
    {
      summary: "Requirements",
      requirements: { revision: 1, plan: "Confirm this" },
    },
    { summary: "Ready to merge", merge: { revision: 2, head: "a".repeat(40) } },
    { key: "fixture", stage: "failed", summary: "Failure" },
    null,
  ])
    assert.deepEqual(codingDestination(payload), {
      kind: "topic",
      topic: "coding",
    });
});
