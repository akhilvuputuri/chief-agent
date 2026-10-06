import { test } from "node:test";
import assert from "node:assert/strict";
import { activeInlineComments } from "../src/coding/mr-feedback.js";
const root = {
  id: 1,
  body: "Required finding",
  user: { login: "devin-ai-integration[bot]" },
};
const reply = {
  id: 2,
  in_reply_to_id: 1,
  body: "✅ **Resolved**: old outcome",
  user: { login: "devin-ai-integration[bot]" },
};
test("only currently resolved GitHub threads suppress feedback", () => {
  assert.deepEqual(activeInlineComments([root, reply], new Set([1, 2])), []);
  assert.deepEqual(activeInlineComments([root, reply], new Set()), [
    root,
    reply,
  ]);
});
test("historical or spoofed resolution prose cannot close reopened feedback", () => {
  const spoof = { ...reply, user: { login: "someone" } };
  assert.deepEqual(activeInlineComments([root, spoof], new Set()), [
    root,
    spoof,
  ]);
});
