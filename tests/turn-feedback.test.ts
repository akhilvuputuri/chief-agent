import { test } from "node:test";
import assert from "node:assert/strict";
import { isRephrase, redirectOf } from "../src/turn-feedback.js";

test("asking for another attempt or approach is a retry", () => {
  for (const text of [
    "try again",
    "Hmm, try again please, that wasn't it",
    "do something else",
    "Give me something different",
    "suggest somewhere else for dinner",
    "a different approach please",
    "another one",
    "again",
    "retry",
    "regenerate",
    "try once more",
    "redo it",
    "no. start over",
  ])
    assert.equal(redirectOf(text, "book a table", "Done."), "retry", text);
});

test("new requests that mention another or again are not retries", () => {
  for (const text of [
    "add another one for Tuesday",
    "Another idea: add a reminder for mum before her birthday next month",
    "Is there a different way to pay this bill?",
    "what other options do I have for flights to NYC?",
    "I want to build it from scratch",
    "thanks! do it again next week",
    "perfect, do that again for Friday",
    "again the same problem with my laptop, it won't charge at all",
  ])
    assert.equal(redirectOf(text, "book a table", "Done."), null, text);
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
  // Shared with the learner as is, which counts any "redo" as a correction.
  assert.equal(
    redirectOf("redo the calendar for next week too", "x", "Done."),
    "correction",
  );
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
  assert.equal(
    isRephrase(
      "weather forecast Hyderabad morning and evening",
      "weather forecast Hyderabad morning and evening",
    ),
    true,
  );
  // A follow-up on the same subject shares too little.
  assert.equal(
    redirectOf(
      "and hotels near Shinjuku station?",
      "cheap flights Singapore to Tokyo next month?",
    ),
    null,
  );
  // One word swapped, or only the dates changed: a new request.
  assert.equal(
    isRephrase(
      "weather in Hyderabad tomorrow morning and evening",
      "weather in Hyderabad today morning and evening",
    ),
    false,
  );
  assert.equal(
    isRephrase(
      "show my emails from Amazon about orders",
      "show my emails from Amazon about returns",
    ),
    false,
  );
  assert.equal(
    isRephrase(
      "meetings on 12 March and 14 March with Priya",
      "meetings on 3 April and 5 April with Priya",
    ),
    false,
  );
  // Too short to judge.
  assert.equal(isRephrase("weather tokyo", "weather in tokyo"), false);
});

test("only the owner's own words count", () => {
  // Attached context after the owner's words is ignored.
  assert.equal(
    redirectOf("thanks!\n\n[Quoted: try again later]", "x", "y"),
    null,
  );
  // A forward or an uncaptioned photo says nothing about the answer.
  assert.equal(redirectOf("[Forwarded message] try again"), undefined);
  assert.equal(
    redirectOf(
      "The user sent this image without a caption.\n\n[Attached image: a.jpg.]",
    ),
    undefined,
  );
  assert.equal(redirectOf("   "), undefined);
  // A caption is the owner's words.
  assert.equal(
    redirectOf("try again\n\n[Attached image: a.jpg.]", "x", "y"),
    "retry",
  );
});
