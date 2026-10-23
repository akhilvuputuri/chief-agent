/**
 * Tolerant quote grounding. A quote must be the source's own words, in order, from one
 * source; only typography that models routinely change is ignored: whitespace runs, curly
 * versus straight quote marks, dash variants and invisible characters. "..." or "…" may stand
 * for omitted words between exact pieces. Every match starts and ends on a word boundary (in
 * scripts written with spaces), where an apostrophe or hyphen between letters and a "." or ","
 * between digits do not end a word. An elided quote whose source span is short is returned
 * whole, so an omitted word such as "not" stays visible; a longer span is returned elided only
 * when the omitted text has no negating or limiting word, and refused past a fixed bound.
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
/**
 * Words that change what the surrounding text means. Omitted text containing one is never
 * hidden behind " … ": the quote must show it.
 */
const QUALIFIER = /\b(?:not|no|never|only|except|unless|without)\b|n't\b/i;

/**
 * The normalised text, with the original UTF-16 span of every normalised unit so a match can
 * be mapped back to the source's own words.
 */
export function normalizeForQuote(input: string) {
  const parts: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  let space = false;
  for (const ch of input) {
    const at = index;
    index += ch.length;
    if (INVISIBLE.has(ch)) continue;
    if (/\s/.test(ch)) {
      if (space) ends[ends.length - 1] = index;
      else {
        parts.push(" ");
        starts.push(at);
        ends.push(index);
        space = true;
      }
      continue;
    }
    space = false;
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
      parts.push(mapped[u]!);
      starts.push(at);
      ends.push(index);
    }
  }
  return { text: parts.join(""), starts, ends };
}

/** A source prepared once for several quotes. */
export type PreparedSource = {
  content: string;
  normalized: ReturnType<typeof normalizeForQuote>;
};
export const prepareSource = (content: string): PreparedSource => ({
  content,
  normalized: normalizeForQuote(content),
});

const verbatim = (
  { content, normalized: source }: PreparedSource,
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
const LETTER = /\p{L}/u;
const DIGIT_CHAR = /\p{N}/u;
/** True when two adjacent characters belong to one word, so a match may not split them. */
const joined = (a: string | undefined, b: string | undefined) =>
  !!a &&
  !!b &&
  WORD_CHAR.test(a) &&
  WORD_CHAR.test(b) &&
  !UNSPACED.test(a) &&
  !UNSPACED.test(b);
/** Characters that join two words into one; en and em dashes separate words instead. */
const HYPHENS = new Set(["-", "‐", "‑"]);
/**
 * True when the punctuation at normalised position `p` joins its neighbours into one word or
 * number: "can't", "non-toxic", "1,234", "1.5". A dash is judged by the source's own
 * character, since all dashes normalise to "-".
 */
function bridges({ content, normalized }: PreparedSource, p: number) {
  const text = normalized.text;
  const [a, mark, b] = [text[p - 1], text[p], text[p + 1]];
  if (!a || !mark || !b) return false;
  if (mark === "." || mark === ",")
    return DIGIT_CHAR.test(a) && DIGIT_CHAR.test(b);
  if (
    mark !== "'" &&
    !(mark === "-" && HYPHENS.has(content[normalized.starts[p]!]!))
  )
    return false;
  return (
    LETTER.test(a) && LETTER.test(b) && !UNSPACED.test(a) && !UNSPACED.test(b)
  );
}
/** True when position `i` (between text[i-1] and text[i]) lies inside a word or number. */
const inside = (source: PreparedSource, i: number) =>
  joined(source.normalized.text[i - 1], source.normalized.text[i]) ||
  bridges(source, i - 1) ||
  bridges(source, i);

/** First occurrence of `piece` at or after `from` that does not start or end inside a word. */
function findBounded(source: PreparedSource, piece: string, from: number) {
  const text = source.normalized.text;
  for (let at = text.indexOf(piece, from); at >= 0;) {
    if (!inside(source, at) && !inside(source, at + piece.length)) return at;
    at = text.indexOf(piece, at + 1);
  }
  return -1;
}

/** Why a quote was refused, when the reason can tell the child how to fix it. */
export type QuoteRefusal = "hidden_qualifier";

/**
 * Matches a quote against a source. On success `quote` is source text with whitespace
 * collapsed: the contiguous match; for an elided quote, the whole span when it is at most
 * WHOLE_SPAN_LIMIT characters, else the pieces joined by " … " when the span is at most
 * MAX_ELIDED_SPAN and no omitted part contains a QUALIFIER word.
 */
export function matchQuoteDetailed(
  source: string | PreparedSource,
  quote: string,
): { quote: string } | { refused?: QuoteRefusal } {
  const prepared = typeof source === "string" ? prepareSource(source) : source;
  const text = prepared.normalized.text;
  const wanted = normalizeForQuote(quote).text.trim();
  if (!wanted) return {};
  let refused: QuoteRefusal | undefined;
  const attempt = (q: string): string | undefined => {
    // The whole quote first, so a source that itself contains "..." still matches directly.
    const whole = findBounded(prepared, q, 0);
    if (whole >= 0) return verbatim(prepared, whole, q.length);
    const pieces = q
      .split(GAP)
      .map((p) => p.trim())
      .filter(Boolean);
    if (!pieces.length || pieces.length > MAX_QUOTE_PIECES) return undefined;
    // A leading or trailing "..." only says the quote is an excerpt: the piece alone must match.
    if (pieces.length === 1) {
      const at = findBounded(prepared, pieces[0]!, 0);
      return at < 0 ? undefined : verbatim(prepared, at, pieces[0]!.length);
    }
    if (pieces.some((p) => p.length < MIN_QUOTE_PIECE)) return undefined;
    // The shortest span over every occurrence of the first piece, later pieces matched
    // greedily. As the start moves right, each later piece's greedy position never moves
    // left, so each piece keeps a cursor and the whole search is one pass over the text.
    const cursors: number[] = pieces.map(() => -1);
    let best: number[] | undefined;
    let span = Infinity;
    for (
      let start = findBounded(prepared, pieces[0]!, 0);
      start >= 0;
      start = findBounded(prepared, pieces[0]!, start + 1)
    ) {
      const at = [start];
      let from = start + pieces[0]!.length;
      for (let i = 1; i < pieces.length; i++) {
        if (cursors[i]! < from)
          cursors[i] = findBounded(prepared, pieces[i]!, from);
        if (cursors[i]! < 0) break;
        at.push(cursors[i]!);
        from = cursors[i]! + pieces[i]!.length;
      }
      // A later piece missing after this start is missing after every later start too.
      if (at.length < pieces.length) break;
      if (from - start < span) {
        span = from - start;
        best = at;
      }
    }
    if (!best || span > MAX_ELIDED_SPAN) return undefined;
    if (span <= WHOLE_SPAN_LIMIT) return verbatim(prepared, best[0]!, span);
    // In a long span, an omitted "not" or "only" would reverse or narrow the quote unseen.
    const omitted = best
      .slice(1)
      .map((at, i) => text.slice(best![i]! + pieces[i]!.length, at));
    if (omitted.some((gap) => QUALIFIER.test(gap))) {
      refused = "hidden_qualifier";
      return undefined;
    }
    return best
      .map((at, i) => verbatim(prepared, at, pieces[i]!.length))
      .join(" … ");
  };
  const found = attempt(wanted);
  if (found !== undefined) return { quote: found };
  // Models often wrap a quote in its own quotation marks; the marks are not the source's words.
  const inner = /^(["'])([\s\S]*)\1$/.exec(wanted)?.[2]?.trim();
  const unwrapped = inner ? attempt(inner) : undefined;
  return unwrapped !== undefined
    ? { quote: unwrapped }
    : refused
      ? { refused }
      : {};
}

/** The source's own words for a grounded quote, or undefined (see matchQuoteDetailed). */
export function matchQuote(
  source: string | PreparedSource,
  quote: string,
): string | undefined {
  const result = matchQuoteDetailed(source, quote);
  return "quote" in result ? result.quote : undefined;
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
