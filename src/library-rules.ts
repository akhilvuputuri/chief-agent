/** Pure catalogue rules: the borrowability verdict, ebook ranking and phone-readable hints. */
export const ebookFormats = [
  "ebook-kobo",
  "ebook-epub-adobe",
  "ebook-overdrive",
  "ebook-epub-open",
] as const;
export const luckyDayDays = 7;
export const defaultLendingDays = 21;
export type Verdict = "borrow_now" | "lucky_day" | "hold" | "unobtainable";
export interface Availability {
  availableCopies: number;
  ownedCopies: number;
  luckyDayAvailableCopies: number;
  holdsCount: number;
  estimatedWaitDays: number | null;
  isHoldable: boolean;
}
/** isAvailable is never consulted: Lucky Day copies are borrowable while it reads false. */
export function verdict(a: Availability, lendingDays = defaultLendingDays) {
  if (a.availableCopies > 0)
    return { verdict: "borrow_now" as const, lendingDays, holdable: true };
  if (a.luckyDayAvailableCopies > 0)
    return {
      verdict: "lucky_day" as const,
      lendingDays: luckyDayDays,
      holdable: false,
    };
  if (a.isHoldable)
    return { verdict: "hold" as const, lendingDays, holdable: true };
  return { verdict: "unobtainable" as const, lendingDays, holdable: false };
}
export function normalise(text: string) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const penalised =
  /large print|summary|study guide|boxed set|box set|sampler|workbook|companion to/i;
export interface Rankable {
  title: string;
  subtitle?: string | null;
  creator?: string | null;
}
/** Token overlap with an exact-title bonus, author bonus and derivative-edition penalty; 0..1. */
export function score(item: Rankable, query: string, author?: string) {
  const q = normalise(query);
  const title = normalise(item.title);
  const full = normalise(item.title + " " + (item.subtitle ?? ""));
  if (!q || !title) return 0;
  const qTokens = new Set(q.split(" "));
  const tTokens = new Set(full.split(" "));
  let overlap = 0;
  for (const t of qTokens) if (tTokens.has(t)) overlap++;
  let s = overlap / Math.max(qTokens.size, 1);
  if (title === q) s += 0.35;
  else if (title.startsWith(q) || q.startsWith(title)) s += 0.15;
  if (author && item.creator) {
    const a = normalise(author);
    const c = normalise(item.creator);
    if (c === a || c.includes(a) || a.includes(c)) s += 0.2;
    else s -= 0.2;
  }
  if (penalised.test(item.title + " " + (item.subtitle ?? ""))) s -= 0.3;
  return Math.max(0, s);
}
/** Ambiguous when the best match is weak, when two editions tie, or when a strong rival has a different author. */
export function ambiguous(
  ranked: { score: number; creator?: string | null }[],
) {
  if (ranked.length === 0) return false;
  const [top, second] = ranked;
  if (top!.score < 0.6) return true;
  if (!second) return false;
  if (top!.score - second.score < 0.15) return true;
  return (
    second.score >= 0.85 &&
    normalise(second.creator ?? "") !== normalise(top!.creator ?? "")
  );
}
export interface Candidate {
  title: string;
  creator: string;
  kobo: boolean;
  verdict: Verdict;
  lendingDays: number;
  availableCopies: number;
  luckyDayCopies: number;
  ownedCopies: number;
  holdsCount: number;
  estimatedWaitDays: number | null;
}
const n = (x: number) => x.toLocaleString("en-SG");
export function answerHint(c: Candidate) {
  const who = `${c.title} — ${c.creator}.`;
  const kobo = c.kobo
    ? ""
    : " Note: this edition is not listed for Kobo; it may only be readable in the Libby app.";
  const wait =
    c.estimatedWaitDays === null
      ? ""
      : `, about ${n(c.estimatedWaitDays)} days`;
  switch (c.verdict) {
    case "borrow_now":
      return `${who} Available now (${n(c.availableCopies)} of ${n(c.ownedCopies)} copies free). ${c.lendingDays}-day loan; reaches your Kobo after its next sync.${kobo}`;
    case "lucky_day":
      return `${who} No regular copies free (${n(c.ownedCopies)} owned, ${n(c.holdsCount)} holds${wait}), but ${n(c.luckyDayCopies)} Lucky Day copies are free right now: a ${luckyDayDays}-day loan that cannot be renewed or held.${kobo}`;
    case "hold":
      return `${who} All ${n(c.ownedCopies)} copies out; ${n(c.holdsCount)} waiting${wait}. A hold is possible.${kobo}`;
    default:
      return `${who} NLB has no lendable ebook copy of this edition right now.`;
  }
}
/** Lending period from library metadata, searched tolerantly; falls back to the default. */
export function lendingDaysFrom(info: unknown, fallback = defaultLendingDays) {
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): number | null => {
    if (!node || typeof node !== "object" || depth > 6 || seen.has(node))
      return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const o = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(o)) {
      // Only the normal lending-period settings count; Lucky Day and redelivery periods are separate keys.
      if (/^lendingPeriods?$/i.test(key)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const ebook = (value as Record<string, unknown>).ebook;
          if (typeof ebook === "number" && ebook > 0 && ebook <= 90)
            return ebook;
        }
        if (Array.isArray(value))
          for (const item of value) {
            if (!item || typeof item !== "object") continue;
            const e = item as Record<string, unknown>;
            const format = String(
              e.formatType ?? e.format ?? e.mediaType ?? "",
            );
            const days = e.lendingPeriodDays ?? e.defaultDays;
            if (
              /^ebook$/i.test(format) &&
              typeof days === "number" &&
              days > 0 &&
              days <= 90
            )
              return days;
          }
      } else if (!/lucky|redeliver/i.test(key)) {
        const found = walk(value, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(info, 0) ?? fallback;
}
