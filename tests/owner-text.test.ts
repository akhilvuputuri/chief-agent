import test from "node:test";
import assert from "node:assert/strict";
import { tidyOwnerText } from "../src/owner-text.js";

const job = "1a6cf84e-4a86-47f6-b60a-c07c8238e9ef";
const sha = "0123456789abcdef0123456789abcdef01234567";

test("Chief's own operation and field names become plain words, and long IDs shrink", () => {
  assert.equal(
    tidyOwnerText(
      `I called \`coding_reply\`; the owner_merge job ${job} is at head_sha ${sha}.`,
    ),
    "I called coding reply; the owner merge job 1a6cf84e is at head sha 0123456.",
  );
  // A 64-character review hash shrinks too.
  assert.equal(tidyOwnerText(`review ${"ab".repeat(32)}`), "review abababa");
});

test("code, links and slash-command IDs stay exactly as written", () => {
  for (const text of [
    `Use /continue ${job} to resume.`,
    `See https://github.com/o/r/commit/${sha}`,
    `[the PR](https://example.com/${job})`,
    "```\ncoding_reply(x)\n```",
    // Arbitrary identifiers are not Chief's names and stay untouched.
    "Rename `user_id` in my_file.py.",
    "and/or a 2/3 split",
  ])
    assert.equal(tidyOwnerText(text), text);
  assert.equal(
    tidyOwnerText(`Use /continue ${job} or check job ${job}.`),
    `Use /continue ${job} or check job 1a6cf84e.`,
  );
});
