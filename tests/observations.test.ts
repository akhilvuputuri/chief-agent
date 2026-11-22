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

test("large source bodies preserve source identifiers and retrieval pointers", () => {
  const projected = projectObservation(
    "web_read",
    {
      result: {
        content: "x".repeat(50000),
        sourceId: "source",
        sourceUrl: "https://example.com",
        untrusted: true,
      },
    },
    "observation",
  );
  assert.equal(projected.result.sourceId, "source");
  assert.equal(projected.result.sourceUrl, "https://example.com");
  assert.equal(projected.observationId, "observation");
  assert.equal(projected.result.untrusted, true);
  assert.ok(JSON.stringify(projected).length < 12000);
});

test("email reads keep their own projection limits; other tools keep the defaults", () => {
  const text = "y".repeat(20000);
  const email = projectObservation(
    "gmail_read",
    { result: { warning: "Untrusted email content", id: "abc", text } },
    "observation",
  );
  assert.equal(email.result.text, text);
  assert.equal(email.result.truncated, undefined);
  const page = {
    warning: "Untrusted email content",
    results: Array.from({ length: 50 }, (_, i) => ({
      id: String(i),
      snippet: "z".repeat(900),
    })),
  };
  assert.equal(
    projectObservation("gmail_search", { result: page }).result.results.length,
    50,
  );
  // The same payloads from any other operation are cut as before.
  const other = projectObservation("memory_read", { result: { text } });
  assert.equal(other.result.text.length, 8000);
  assert.equal(other.result.truncated, true);
  const listing = projectObservation("feed_read", { result: page });
  assert.ok(listing.result.excerpt);
  assert.ok(JSON.stringify(listing).length < 12000);
});
