/**
 * Tolerant quote grounding. A quote still has to be the source's own words, in order, from
 * one source; only typography that models routinely change is ignored:
 * whitespace runs, curly versus straight quote marks, dash variants, invisible characters,
 * and "..." or "…" standing for omitted text between exact pieces.
 */

const SINGLE_QUOTES = new Set(["‘", "’", "‚", "‛", "′"]);
const DOUBLE_QUOTES = new Set(["“", "”", "„", "‟", "″"]);
const DASHES = new Set(["‐", "‑", "‒", "–", "—", "―", "−"]);
/** Zero-width and soft-hyphen characters that never change the wording. */
const INVISIBLE = new Set(["­", "​", "‌", "‍", "⁠", "﻿"]);
/** "...", "…" or a bracketed "[...]" marks words left out of a quote. */
const GAP = /\s*\[?\s*\.{3,}\s*\]?\s*/;
/** Each piece around an ellipsis must be long enough not to match by chance. */
export const MIN_QUOTE_PIECE = 8;
/** At most three omissions: a quote is an excerpt, not a collage. */
export const MAX_QUOTE_PIECES = 4;

/**
 * The normalised text, with the original UTF-16 span of every normalised unit so a match can
 * be mapped back to the source's own words.
 */
export function normalizeForQuote(input: string) {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const ch of input) {
    const at = index;
    index += ch.length;
    if (INVISIBLE.has(ch)) continue;
    if (/\s/.test(ch)) {
      if (text.endsWith(" ")) ends[ends.length - 1] = index;
      else {
        text += " ";
        starts.push(at);
        ends.push(index);
      }
      continue;
    }
    const mapped =
      ch === "…"
        ? "..."
        : SINGLE_QUOTES.has(ch)
          ? "'"
          : DOUBLE_QUOTES.has(ch)
            ? '"'
            : DASHES.has(ch)
              ? "-"
              : ch;
    for (let u = 0; u < mapped.length; u++) {
      text += mapped[u];
      starts.push(at);
      ends.push(index);
    }
  }
  return { text, starts, ends };
}

const verbatim = (
  content: string,
  source: ReturnType<typeof normalizeForQuote>,
  at: number,
  length: number,
) =>
  content
    .slice(source.starts[at], source.ends[at + length - 1])
    .replace(/\s+/g, " ")
    .trim();

/**
 * Returns the source's own words for a quote that is grounded in `content`, or undefined.
 * The result is the matching source text (whitespace collapsed), with " … " between the
 * pieces of an elided quote, so what the host passes on is what the source says.
 */
export function matchQuote(content: string, quote: string): string | undefined {
  if (content.includes(quote)) return quote;
  const source = normalizeForQuote(content);
  const wanted = normalizeForQuote(quote).text.trim();
  if (!wanted) return undefined;
  const attempt = (q: string) => {
    // The whole quote first, so a source that itself contains "..." still matches directly.
    const whole = source.text.indexOf(q);
    if (whole >= 0) return verbatim(content, source, whole, q.length);
    const pieces = q
      .split(GAP)
      .map((p) => p.trim())
      .filter(Boolean);
    // A leading or trailing "..." only says the quote is an excerpt: the piece alone must match.
    if (
      !pieces.length ||
      pieces.length > MAX_QUOTE_PIECES ||
      (pieces.length > 1 && pieces.some((p) => p.length < MIN_QUOTE_PIECE))
    )
      return undefined;
    const spans: string[] = [];
    let from = 0;
    for (const piece of pieces) {
      const at = source.text.indexOf(piece, from);
      if (at < 0) return undefined;
      spans.push(verbatim(content, source, at, piece.length));
      from = at + piece.length;
    }
    return spans.join(" … ");
  };
  const found = attempt(wanted);
  if (found !== undefined) return found;
  // Models often wrap a quote in its own quotation marks; the marks are not the source's words.
  const wrapped = /^(["'])([\s\S]*)\1$/.exec(wanted);
  const inner = wrapped?.[2]?.trim();
  return inner ? attempt(inner) : undefined;
}

/** A short excerpt of a rejected quote for a validation message. */
export function quoteExcerpt(quote: string, max = 80) {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

const WORD = /[\p{L}\p{N}_]/u;
const DIGIT = /\d/;

/**
 * True when `token` appears in `text` as a whole value: not inside a longer word or number.
 * "1234567" matches "record 1234567," but not "91234567" or "1234567.5".
 */
export function containsToken(text: string, token: string) {
  if (!token) return false;
  for (
    let at = text.indexOf(token);
    at >= 0;
    at = text.indexOf(token, at + 1)
  ) {
    const before = text[at - 1] ?? "";
    const after = text[at + token.length] ?? "";
    if (WORD.test(before) || WORD.test(after)) continue;
    // A decimal or grouped number continues across "." or ",": 123 is not a token of 123.45.
    if (
      /[.,]/.test(after) &&
      DIGIT.test(token.at(-1) ?? "") &&
      DIGIT.test(text[at + token.length + 1] ?? "")
    )
      continue;
    if (
      /[.,]/.test(before) &&
      DIGIT.test(token[0] ?? "") &&
      DIGIT.test(text[at - 2] ?? "")
    )
      continue;
    return true;
  }
  return false;
}
