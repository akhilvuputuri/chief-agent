/**
 * Tolerant quote grounding. A quote must be the source's own words, in order, from one
 * source; only typography that models routinely change is ignored: whitespace runs, curly
 * versus straight quote marks, dash variants and invisible characters. "..." or "…" may stand
 * for omitted words between exact pieces. Every match starts and ends on a word boundary (in
 * scripts written with spaces). An elided quote whose source span is short is returned whole,
 * so an omitted word such as "not" stays visible; a longer span is refused past a fixed bound.
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
 * An elided match whose source span (normalised characters, first piece to last) fits the
 * report's quote limit is returned as the whole contiguous span, omitted words included.
 */
export const WHOLE_SPAN_LIMIT = 300;
/** Longer spans are returned elided, up to this bound; beyond it the quote is refused. */
export const MAX_ELIDED_SPAN = 600;
/** Occurrences of a first piece tried when looking for the shortest span. */
const MAX_STARTS = 1000;

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

const WORD_CHAR = /[\p{L}\p{N}_]/u;
/** Scripts written without spaces between words, where a word boundary cannot be told. */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/** True when two adjacent characters belong to one word, so a match may not split them. */
const joined = (a: string | undefined, b: string | undefined) =>
  !!a &&
  !!b &&
  WORD_CHAR.test(a) &&
  WORD_CHAR.test(b) &&
  !UNSPACED.test(a) &&
  !UNSPACED.test(b);

/** First occurrence of `piece` at or after `from` that does not start or end inside a word. */
function findBounded(text: string, piece: string, from: number) {
  for (let at = text.indexOf(piece, from); at >= 0;) {
    const end = at + piece.length;
    if (!joined(text[at - 1], text[at]) && !joined(text[end - 1], text[end]))
      return at;
    at = text.indexOf(piece, at + 1);
  }
  return -1;
}

/**
 * Returns the source's own words for a quote that is grounded in `content`, or undefined.
 * The result is source text with whitespace collapsed: the contiguous match, or for an elided
 * quote the whole span when it is at most WHOLE_SPAN_LIMIT characters, else the pieces joined
 * by " … " when the span is at most MAX_ELIDED_SPAN.
 */
export function matchQuote(content: string, quote: string): string | undefined {
  const source = normalizeForQuote(content);
  const wanted = normalizeForQuote(quote).text.trim();
  if (!wanted) return undefined;
  const attempt = (q: string) => {
    // The whole quote first, so a source that itself contains "..." still matches directly.
    const whole = findBounded(source.text, q, 0);
    if (whole >= 0) return verbatim(content, source, whole, q.length);
    const pieces = q
      .split(GAP)
      .map((p) => p.trim())
      .filter(Boolean);
    if (!pieces.length || pieces.length > MAX_QUOTE_PIECES) return undefined;
    // A leading or trailing "..." only says the quote is an excerpt: the piece alone must match.
    if (pieces.length === 1) {
      const at = findBounded(source.text, pieces[0]!, 0);
      return at < 0
        ? undefined
        : verbatim(content, source, at, pieces[0]!.length);
    }
    if (pieces.some((p) => p.length < MIN_QUOTE_PIECE)) return undefined;
    // The shortest span over the first piece's occurrences; later pieces match greedily,
    // which gives the shortest span for that start.
    let best: number[] | undefined;
    let span = Infinity;
    for (
      let start = findBounded(source.text, pieces[0]!, 0), tries = 0;
      start >= 0 && tries < MAX_STARTS;
      start = findBounded(source.text, pieces[0]!, start + 1), tries++
    ) {
      const at = [start];
      let from = start + pieces[0]!.length;
      for (const piece of pieces.slice(1)) {
        const found = findBounded(source.text, piece, from);
        if (found < 0) break;
        at.push(found);
        from = found + piece.length;
      }
      // No later piece can follow a start whose rest did not match; later starts only shrink the text.
      if (at.length < pieces.length) break;
      if (from - start < span) {
        span = from - start;
        best = at;
      }
    }
    if (!best || span > MAX_ELIDED_SPAN) return undefined;
    if (span <= WHOLE_SPAN_LIMIT)
      return verbatim(content, source, best[0]!, span);
    return best
      .map((at, i) => verbatim(content, source, at, pieces[i]!.length))
      .join(" … ");
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
 * True when `token` appears in `text` as a whole token: not inside a longer word or number.
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
