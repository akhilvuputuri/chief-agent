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
    "Try a different approach",
    // From the owner's real follow-ups (journal 133): repeats after a failure.
    "Add haircut again",
    "Try to add again",
    "try again, that's too long",
    "redo it, too formal",
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
    "Another idea: add a reminder for mum",
    "what time is it again?",
    "how does this work again",
    "thanks again",
    "Thank you again!",
    "never again",
    "see you again",
    "Happy birthday again!",
    "I'm sick again",
    "here we go again",
    "Try again tomorrow morning",
    "Thanks, try again later if it fails",
    "redo the calendar for next week too",
    "do that again for mum too!",
  ])
    assert.equal(redirectOf(text, "book a table", "Done."), null, text);
});

test("corrections use the learner's definition", () => {
  assert.equal(redirectOf("that's wrong, it's on Friday"), "correction");
  assert.equal(redirectOf("No, I meant the other account"), "correction");
  // Acknowledgements never are, and a plain "no" answers a question.
  // A correction with a time or an extension in it is still one.
  for (const text of [
    "That's wrong, try again for Friday",
    "No, that's wrong. Redo it and also include prices",
    "you missed the meeting tomorrow, try again",
    // A retry that does not open the message is the learner's correction; a redirect either way.
    "too long, try again",
  ])
    assert.equal(redirectOf(text, "x", "Done."), "correction", text);
  assert.equal(redirectOf("No worries, thanks"), null);
  assert.equal(
    redirectOf("no", "remind me", "Want me to remember that?"),
    null,
  );
  assert.equal(redirectOf("no", "remind me", "Reminder set."), "correction");
  // Shared with the learner as is, which counts "redo" anywhere as a correction.
  assert.equal(
    redirectOf("thanks, but redo the summary", "x", "Done."),
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
  for (const [now, before] of [
    [
      "weather forecast for Hyderabad on 5 March",
      "weather forecast for Hyderabad on 4 March",
    ],
    [
      "book a table for 2 at Olive Bistro tonight please",
      "book a table for 4 at Olive Bistro tonight please",
    ],
    [
      "set a reminder to call mum at 6 pm",
      "set a reminder to call mum at 7 pm",
    ],
  ])
    assert.equal(isRephrase(now!, before!), false, now);
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
