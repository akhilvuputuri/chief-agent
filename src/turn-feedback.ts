// Implicit feedback on a turn (issue #323): whether the owner's next message redirects the
// answer before it. The owner does not rate answers; when one is not what they wanted they
// say "try again" or "do something else", correct it, or ask the same thing in other words.
// Text patterns only, no model call. The result leaves the process as a fixed label, never
// the words that matched.

import { isCorrection, ownerWords } from "./learning.js";

export type Redirect = "retry" | "correction" | "rephrase";

// A retry opens the message, after at most a short lead-in ("hmm, try again").
const LEAD_IN = String.raw`^\s*(?:(?:no|nope|nah|hmm+|ok(?:ay)?|meh|ugh|well|please|pls)[\s,.!]+){0,2}`;
// Requests for another attempt, whatever follows them.
const RETRY = new RegExp(
  LEAD_IN +
    String.raw`(?:try (?:it |that )?(?:again|once more)|retry|regenerate|redo(?: it| that| this)?|start over|one more time|do (?:it|that|this) (?:again|differently)|(?:do|try|give me|show me|suggest) (?:something|someone|somewhere) (?:else|different))\b`,
  "i",
);
// Shorter requests that are retries only as a whole short message: "again", "another one",
// "something different". As the start of a longer one they usually ask for something new.
const SHORT_RETRY = new RegExp(
  LEAD_IN +
    String.raw`(?:again|(?:something|someone|somewhere) (?:else|different)|(?:a |an )?(?:different|another|other) (?:way|approach|answer|option|one|idea|suggestion)s?)\b`,
  "i",
);
const SHORT_WORDS = 8;
const UNCAPTIONED = /^The user sent this \w+ without a caption\.$/;
// "Do it again next week", "redo the calendar for Friday too": a repeat or an extension, not
// a rejection of the answer.
const EXTENSION =
  /\b(next|tomorrow|tonight|weekly|daily|every|too|also|as well|for (mon|tues|wednes|thurs|fri|satur|sun)day|on (mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;

// Function words that say nothing about what was asked.
const STOP = new Set(
  (
    "a an the to of in on at for by from with into about as and or but so if than then " +
    "is are was were be been am do does did has have had can could will would should " +
    "i me my we our you your it its they them their this that these those " +
    "please pls what whats how who when where which why any some just"
  ).split(" "),
);
// Words whose change makes a new request out of the same sentence: "today" → "tomorrow".
const SHIFT =
  /^(\d+\w*|today|tonight|tomorrow|yesterday|morning|afternoon|evening|night|week|weekend|month|year|next|last|this|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|(mon|tues|wednes|thurs|fri|satur|sun)day|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)$/;

const contentWords = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );

/**
 * Whether `text` asks for what `previous` asked, in other words: at least four content
 * words each and at least 70% of their union shared. A follow-up that swaps one word for
 * another ("orders" for "returns"), or changes only dates, times and numbers, is a new
 * request on the same subject, not a rephrase.
 */
export function isRephrase(text: string, previous: string) {
  const now = contentWords(text);
  const before = contentWords(previous);
  if (now.size < 4 || before.size < 4) return false;
  const added = [...now].filter((w) => !before.has(w));
  const dropped = [...before].filter((w) => !now.has(w));
  if (added.length === 1 && dropped.length === 1) return false;
  const changed = [...added, ...dropped];
  if (changed.length && changed.every((w) => SHIFT.test(w))) return false;
  const shared = now.size - added.length;
  return shared / (now.size + before.size - shared) >= 0.7;
}

/**
 * How the owner's message redirects the previous answer: a redirect, null when it does not
 * redirect it, or undefined when the message has no words of the owner's to judge (a
 * forward, or a photo without a caption), so it says nothing about the answer.
 * `previousRequest` and `previousReply` are the last exchange's texts when known; a reply
 * that ended in a question makes a plain "no" an answer to it, not a correction.
 */
export function redirectOf(
  message: string,
  previousRequest?: string | null,
  previousReply?: string | null,
): Redirect | null | undefined {
  const words = ownerWords(message);
  const text = words.text.trim();
  // attachments.ts stands this sentence in for a missing caption.
  if (!text || (words.attached && UNCAPTIONED.test(text))) return undefined;
  const opening = text.slice(0, 160);
  const short = text.split(/\s+/).length <= SHORT_WORDS;
  if (
    (RETRY.test(opening) || (short && SHORT_RETRY.test(opening))) &&
    !EXTENSION.test(text)
  )
    return "retry";
  if (isCorrection(text, (previousReply ?? "").trim().endsWith("?")))
    return "correction";
  const request = previousRequest ? ownerWords(previousRequest).text : "";
  if (request && isRephrase(text, request)) return "rephrase";
  return null;
}
