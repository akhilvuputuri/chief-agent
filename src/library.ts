import { z } from "zod";
import { LibraryClient, LibraryError } from "./library-client.js";
import { libraryKey } from "./library-routes.js";
import {
  ambiguous,
  answerHint,
  ebookFormats,
  lendingDaysFrom,
  score,
  verdict,
  type Verdict,
} from "./library-rules.js";
import type { LibraryAction } from "./library-schema.js";
import type { LibraryIdentity } from "./library-identity.js";
export const libraryCache = {
  searchMs: 15 * 60000,
  availabilityMs: 15 * 60000,
  libraryMs: 24 * 3600000,
  maxCandidates: 5,
};
const idText = z.union([z.string(), z.number()]).transform((v) => String(v));
const availabilityItem = z.object({
  id: idText,
  isAvailable: z.boolean().optional(),
  availableCopies: z.number().default(0),
  ownedCopies: z.number().default(0),
  luckyDayAvailableCopies: z.number().default(0),
  luckyDayOwnedCopies: z.number().default(0),
  holdsCount: z.number().default(0),
  estimatedWaitDays: z.number().nullable().default(null),
  isHoldable: z.boolean().default(false),
});
type AvailabilityItem = z.infer<typeof availabilityItem>;
const availabilityResponse = z
  .union([
    z.object({ items: z.array(availabilityItem) }),
    z.array(availabilityItem),
    z.record(availabilityItem),
  ])
  .transform((v): AvailabilityItem[] => {
    if (Array.isArray(v)) return v;
    const items = (v as { items?: unknown }).items;
    if (Array.isArray(items)) return items as AvailabilityItem[];
    return Object.values(v as Record<string, AvailabilityItem>);
  });
const searchItem = availabilityItem.extend({
  title: z.string(),
  subtitle: z.string().nullable().optional(),
  firstCreatorName: z.string().nullable().optional(),
  type: z.object({ id: z.string() }).optional(),
  formats: z.array(z.object({ id: z.string() })).default([]),
});
const searchResponse = z.object({
  items: z.array(searchItem).default([]),
  totalItems: z.number().optional(),
});
type SearchItem = z.infer<typeof searchItem>;
export interface CheckCandidate {
  titleId: string;
  title: string;
  subtitle?: string;
  creator: string;
  kobo: boolean;
  formats: string[];
  verdict: Verdict;
  lendingDays: number;
  availableCopies: number;
  luckyDayCopies: number;
  ownedCopies: number;
  holdsCount: number;
  estimatedWaitDays: number | null;
  checkedAt: string;
  answerHint: string;
  siteUrl: string;
}
interface Cached<T> {
  at: number;
  value: T;
}
/** Catalogue reads. No identity, no account data; results are compact and cached in memory. */
export class LibraryTools {
  private searches = new Map<string, Cached<SearchItem[]>>();
  private availability = new Map<
    string,
    Cached<{ item: AvailabilityItem; checkedAt: string }>
  >();
  private library?: Cached<number>;
  constructor(
    private client: LibraryClient,
    private now: () => number = Date.now,
    private identity?: LibraryIdentity,
  ) {}
  async call(user: string, _run: string, a: LibraryAction) {
    if (a.operation === "library_check") return this.check(a.query, a.author);
    if (a.operation === "library_shelf") return this.shelf(user);
    return this.recheck(a.titleIds);
  }
  async shelf(user: string) {
    if (!this.identity) throw new Error("Library account is not configured");
    const status = await this.identity.status(user);
    if (!status.linked)
      return {
        linked: false as const,
        state: status.state,
        note: "No Libby card is linked. The user can send /library link to connect it from the phone; drafting a link is not available to you.",
      };
    return this.identity.shelf(user);
  }
  private async lendingDays() {
    if (this.library && this.now() - this.library.at < libraryCache.libraryMs)
      return this.library.value;
    try {
      const info = await this.client.call("libraryInfo", {
        schema: z.unknown(),
        context: "turn",
      });
      this.library = { at: this.now(), value: lendingDaysFrom(info) };
    } catch (error) {
      if (!(error instanceof LibraryError)) throw error;
      if (!this.library) this.library = { at: 0, value: 21 };
    }
    return this.library.value;
  }
  private async search(query: string, author?: string) {
    const key = (query + "|" + (author ?? "")).toLowerCase();
    const cached = this.searches.get(key);
    if (cached && this.now() - cached.at < libraryCache.searchMs)
      return cached.value;
    const result = await this.client.call("mediaSearch", {
      query: {
        query: author ? `${query} ${author}` : query,
        mediaType: "ebook",
        perPage: "25",
        page: "1",
      },
      schema: searchResponse,
      context: "turn",
    });
    this.searches.set(key, { at: this.now(), value: result.items });
    return result.items;
  }
  private async availabilityFor(ids: string[]) {
    const fresh = new Map<
      string,
      { item: AvailabilityItem; checkedAt: string }
    >();
    const missing: string[] = [];
    for (const id of ids) {
      const c = this.availability.get(id);
      if (c && this.now() - c.at < libraryCache.availabilityMs)
        fresh.set(id, c.value);
      else missing.push(id);
    }
    if (missing.length) {
      const items = await this.client.call("mediaAvailability", {
        query: { titleIds: missing.join(",") },
        schema: availabilityResponse,
        context: "turn",
      });
      const checkedAt = new Date(this.now()).toISOString();
      for (const item of items) {
        const value = { item, checkedAt };
        this.availability.set(item.id, { at: this.now(), value });
        fresh.set(item.id, value);
      }
    }
    return fresh;
  }
  private candidate(
    item: SearchItem,
    a: AvailabilityItem,
    checkedAt: string,
    lendingDays: number,
  ): CheckCandidate {
    const formats = item.formats.map((f) => f.id);
    const v = verdict(a, lendingDays);
    const base = {
      titleId: item.id,
      title: item.title.slice(0, 200),
      ...(item.subtitle ? { subtitle: item.subtitle.slice(0, 200) } : {}),
      creator: (item.firstCreatorName ?? "Unknown author").slice(0, 120),
      kobo: formats.includes("ebook-kobo"),
      formats,
      verdict: v.verdict,
      lendingDays: v.lendingDays,
      availableCopies: a.availableCopies,
      luckyDayCopies: a.luckyDayAvailableCopies,
      ownedCopies: a.ownedCopies,
      holdsCount: a.holdsCount,
      estimatedWaitDays: a.estimatedWaitDays,
      checkedAt,
      siteUrl: `https://${libraryKey}.overdrive.com/media/${item.id}`,
    };
    return { ...base, answerHint: answerHint(base) };
  }
  async check(query: string, author?: string) {
    const items = await this.search(query, author);
    const ebooks = items.filter(
      (i) =>
        (!i.type || i.type.id === "ebook") &&
        i.formats.some((f) =>
          (ebookFormats as readonly string[]).includes(f.id),
        ),
    );
    const scored = ebooks
      .map((item) => ({
        item,
        score: score(
          {
            title: item.title,
            subtitle: item.subtitle,
            creator: item.firstCreatorName,
          },
          query,
          author,
        ),
      }))
      .filter((s) => s.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, libraryCache.maxCandidates);
    const lendingDays = await this.lendingDays();
    const availability = scored.length
      ? await this.availabilityFor(scored.map((s) => s.item.id))
      : new Map();
    const checkedAt = new Date(this.now()).toISOString();
    const candidates = scored.map(({ item }) => {
      const a = availability.get(item.id);
      return this.candidate(
        item,
        a?.item ?? item,
        a?.checkedAt ?? checkedAt,
        lendingDays,
      );
    });
    const isAmbiguous = ambiguous(
      scored.map((s) => ({ score: s.score, creator: s.item.firstCreatorName })),
    );
    return {
      query,
      ...(author ? { author } : {}),
      candidates,
      ambiguous: isAmbiguous,
      omittedNonEbook: items.length - ebooks.length,
      ...(candidates.length && !isAmbiguous
        ? { bestMatch: candidates[0]!.titleId }
        : {}),
      note: candidates.length
        ? "Verdicts come from the availability rule, not isAvailable. Cached for 15 minutes; do not repeat the same query."
        : "No NLB ebook matched. Ask for the exact title or author before searching again.",
    };
  }
  async recheck(titleIds: string[]) {
    const lendingDays = await this.lendingDays();
    const availability = await this.availabilityFor(titleIds);
    return {
      titles: titleIds.map((id) => {
        const a = availability.get(id);
        if (!a)
          return {
            titleId: id,
            verdict: null,
            known: false,
            note: "Not in the catalogue answer; check the id with library_check.",
          };
        const v = verdict(a.item, lendingDays);
        return {
          titleId: id,
          verdict: v.verdict,
          lendingDays: v.lendingDays,
          availableCopies: a.item.availableCopies,
          luckyDayCopies: a.item.luckyDayAvailableCopies,
          ownedCopies: a.item.ownedCopies,
          holdsCount: a.item.holdsCount,
          estimatedWaitDays: a.item.estimatedWaitDays,
          checkedAt: a.checkedAt,
        };
      }),
    };
  }
}
