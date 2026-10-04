import { test } from "node:test";
import assert from "node:assert/strict";
import { codingDestination } from "../src/coding/delivery-routing.js";

test("only bounded worker milestones route to Coding; decisions, terminal results and malformed events stay in General", () => {
  for (const stage of ["planning", "implementing", "verifying", "reviewing"])
    assert.deepEqual(
      codingDestination({ key: "fixture", stage, summary: "Milestone" }),
      { kind: "topic", topic: "coding" },
    );
  for (const payload of [
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
    {
      key: "fixture",
      stage: "reviewing",
      summary: "Milestone",
      question: "Decision",
    },
    { key: "fixture", stage: "failed", summary: "Failure" },
    null,
  ])
    assert.deepEqual(codingDestination(payload), { kind: "general" });
});
