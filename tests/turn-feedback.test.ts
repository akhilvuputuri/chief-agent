import { test } from "node:test";
import assert from "node:assert/strict";
import { isRephrase, redirectOf } from "../src/turn-feedback.js";

test("asking for another attempt or approach is a retry", () => {
  for (const text of [
    "try again",
    "Try again please, that wasn't it",
    "do something else",
    "Give me something different",
    "suggest somewhere else for dinner",
    "is there another way?",
    "a different approach please",
    "redo it",
    "start over",
  ])
    assert.equal(redirectOf(text, "book a table", "Done."), "retry", text);
});

test("corrections use the learner's definition", () => {
  assert.equal(redirectOf("that's wrong, it's on Friday"), "correction");
  assert.equal(redirectOf("No, I meant the other account"), "correction");
  // Acknowledgements never are, and a plain "no" answers a question.
  assert.equal(redirectOf("No worries, thanks"), null);
  assert.equal(
    redirectOf("no", "remind me", "Want me to remember that?"),
    null,
  );
  assert.equal(redirectOf("no", "remind me", "Reminder set."), "correction");
});

test("asking the same thing in other words is a rephrase", () => {
  assert.equal(
    redirectOf(
      "find cheap flights from Singapore to Tokyo next month",
      "cheap flights Singapore to Tokyo next month?",
      "Here are three options.",
    ),
    "rephrase",
  );
  // A follow-up on the same subject shares too little.
  assert.equal(
    redirectOf(
      "and hotels near Shinjuku station?",
      "cheap flights Singapore to Tokyo next month?",
    ),
    null,
  );
  // Too short to judge.
  assert.equal(isRephrase("weather tokyo", "weather in tokyo"), false);
});

test("only the owner's own words count", () => {
  // Attached context after the owner's words is ignored; a message that is only an attachment has none.
  assert.equal(
    redirectOf("thanks!\n\n[Quoted: try again later]", "x", "y"),
    null,
  );
  assert.equal(redirectOf("[Forwarded message] try again"), null);
  assert.equal(redirectOf("   "), null);
});
