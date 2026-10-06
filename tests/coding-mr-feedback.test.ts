import { test } from "node:test";
import assert from "node:assert/strict";
import { activeInlineComments } from "../src/coding/mr-feedback.js";
const root = {
  id: 1,
  body: "Required finding",
  updated_at: "2026-10-07T00:00:00Z",
  user: { login: "devin-ai-integration[bot]" },
};
const resolved = {
  id: 2,
  in_reply_to_id: 1,
  body: "✅ **Resolved**: fixed",
  created_at: "2026-10-07T00:01:00Z",
  user: { login: "devin-ai-integration[bot]" },
};
test("peer-resolved findings and resolution notices do not requeue coding", () => {
  assert.deepEqual(activeInlineComments([root, resolved], new Set()), []);
  assert.deepEqual(
    activeInlineComments([root, { id: 3, body: "human" }], new Set([1])),
    [{ id: 3, body: "human" }],
  );
});
test("spoofed resolution, edited findings and missing timestamps cannot suppress required feedback", () => {
  assert.equal(
    activeInlineComments(
      [root, { ...resolved, user: { login: "someone" } }],
      new Set(),
    ).length,
    2,
  );
  assert.equal(
    activeInlineComments(
      [{ ...root, updated_at: "2026-10-07T00:02:00Z" }, resolved],
      new Set(),
    ).length,
    2,
  );
  assert.equal(
    activeInlineComments(
      [root, { ...resolved, created_at: undefined }],
      new Set(),
    ).length,
    2,
  );
});
