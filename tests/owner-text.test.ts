import test from "node:test";
import assert from "node:assert/strict";
import { tidyOwnerText } from "../src/owner-text.js";

const job = "1a6cf84e-4a86-47f6-b60a-c07c8238e9ef";
const sha = "0123456789abcdef0123456789abcdef01234567";

test("Chief's own operation and field names become plain words, and long IDs in prose shrink", () => {
  assert.equal(
    tidyOwnerText(
      `I called \`coding_reply\`; the owner_merge job ${job} is at head_sha ${sha}.`,
    ),
    "I called coding reply; the owner merge job 1a6cf84e is at head sha 0123456.",
  );
  // A 64-character review hash shrinks too.
  assert.equal(tidyOwnerText(`review ${"ab".repeat(32)}`), "review abababa");
});

test("code, links, paths, numbers and command IDs are delivered exactly", () => {
  for (const text of [
    `Use /continue ${job} to resume.`,
    `Run \`/continue ${job}\`, or /continue \`${job}\`, or (/continue ${job}).`,
    `The full SHA is \`${sha}\`.`,
    "Call `coding_reply(x)` now, then read `finish_turn.records`.",
    "`foo coding_reply` stays a code span.",
    "Edit src/coding_reply.ts and tests/work_status.test.ts; then coding_reply(x).",
    "Rename `run_id` in my_file.py, and run_id elsewhere.",
    `See https://github.com/o/r/commit/${sha}`,
    `Open chief.example.com/miniapp/?canvas=${job}`,
    `[the page](https://example.com/Foo_(bar)/${job})`,
    "```\ncoding_reply(x)\n```",
    `A 40-digit number: ${"1".repeat(40)}`,
    "and/or a 2/3 split",
  ])
    assert.equal(tidyOwnerText(text), text);
  assert.equal(
    tidyOwnerText(`Use /continue ${job} or check job ${job}.`),
    `Use /continue ${job} or check job 1a6cf84e.`,
  );
});

test("pathological input stays fast", () => {
  const started = Date.now();
  tidyOwnerText("[".repeat(100000));
  tidyOwnerText("```".repeat(30000));
  assert.ok(Date.now() - started < 2000);
});
