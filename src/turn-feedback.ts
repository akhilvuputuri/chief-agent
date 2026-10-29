// Implicit feedback on a turn (issue #323): whether the owner's next message redirects the
// answer before it. The owner does not rate answers; when one is not what they wanted they
// say "try again" or "do something else", correct it, or ask the same thing in other words.
// Text patterns only, no model call. The result leaves the process as a fixed label, never
// the words that matched.

import { isCorrection, ownerWords } from "./learning.js";

export type Redirect = "retry" | "correction" | "rephrase";

// Asking for another attempt or a different approach, anywhere in the message's opening.
const RETRY =
  /\b(try again|again,? please|one more time|redo( it| that| this)?|do (it|that|this) again|(do|try|give me|show me|suggest) (something|someone|somewhere) (else|different)|(a |an )?(different|another|other) (way|approach|answer|option|one|idea|suggestion)s?\b|start over|from scratch)\b/i;

// Function words that say nothing about what was asked.
const STOP = new Set(
  (
    "a an the to of in on at for by from with into about as and or but so if than then " +
    "is are was were be been am do does did has have had can could will would should " +
    "i me my we our you your it its they them their this that these those " +
    "please pls what whats how who when where which why any some just"
  ).split(" "),
);

const contentWords = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );

/**
 * Whether `text` asks for what `previous` asked, in other words: at least four content
 * words each, and at least 60% of their union shared. A follow-up on the same subject
 * ("and tomorrow?") shares too little to count.
 */
export function isRephrase(text: string, previous: string) {
  const now = contentWords(text);
  const before = contentWords(previous);
  if (now.size < 4 || before.size < 4) return false;
  let shared = 0;
  for (const w of now) if (before.has(w)) shared++;
  return shared / (now.size + before.size - shared) >= 0.6;
}

/**
 * How the owner's message redirects the previous answer, or null when it does not.
 * `previousRequest` and `previousReply` are the last exchange's texts when known; a reply
 * that ended in a question makes a plain "no" an answer to it, not a correction.
 */
export function redirectOf(
  message: string,
  previousRequest?: string | null,
  previousReply?: string | null,
): Redirect | null {
  const text = ownerWords(message).text.trim();
  if (!text) return null;
  if (RETRY.test(text.slice(0, 160))) return "retry";
  if (isCorrection(text, (previousReply ?? "").trim().endsWith("?")))
    return "correction";
  const request = previousRequest ? ownerWords(previousRequest).text : "";
  if (request && isRephrase(text, request)) return "rephrase";
  return null;
}
