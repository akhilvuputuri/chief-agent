import { test } from "node:test";
import assert from "node:assert/strict";
import { LibraryClient } from "../src/library-client.js";
import { MemoryPacing } from "../src/library-pacing.js";
import { LibraryTools } from "../src/library.js";
import {
  answerHint,
  lendingDaysFrom,
  score,
  verdict,
} from "../src/library-rules.js";
import { JobTools } from "../src/tools.js";
import { toolError } from "../src/tool-errors.js";
import { action } from "../src/protocol.js";

const item = (
  id: string,
  title: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  title,
  firstCreatorName: "Andy Weir",
  type: { id: "ebook" },
  formats: [{ id: "ebook-kobo" }, { id: "ebook-epub-adobe" }],
  availableCopies: 0,
  ownedCopies: 246,
  luckyDayAvailableCopies: 6,
  luckyDayOwnedCopies: 270,
  holdsCount: 2267,
  estimatedWaitDays: 130,
  isHoldable: true,
  isAvailable: false,
  ...extra,
});
const searchPage = {
  totalItems: 25,
  items: [
    item("5665700", "Project Hail Mary"),
    item("1", "Project Hail Mary", {
      subtitle: "Large Print",
      formats: [{ id: "ebook-epub-adobe" }],
    }),
    item("2", "Project Hail Mary", {
      type: { id: "audiobook" },
      formats: [{ id: "audiobook-overdrive" }],
    }),
    item("3", "Hail Mary", {
      firstCreatorName: "Kate Quinn",
      availableCopies: 2,
      ownedCopies: 5,
      luckyDayAvailableCopies: 0,
      holdsCount: 0,
      estimatedWaitDays: 1,
    }),
    item("4", "Mars One", {
      type: { id: "audiobook" },
      formats: [{ id: "audiobook-mp3" }],
    }),
    item("5", "Sleeping Giants", { firstCreatorName: "Sylvain Neuvel" }),
    item("6", "Whalefall", {
      firstCreatorName: "Daniel Kraus",
      formats: [{ id: "magazine-overdrive" }],
      type: { id: "magazine" },
    }),
  ],
};

function harness() {
  let now = Date.UTC(2026, 8, 20, 4, 0, 0);
  const calls: URL[] = [];
  const client = new LibraryClient({
    pacing: new MemoryPacing(() => now),
    now: () => now,
    random: () => 0,
    sleep: async (ms) => {
      now += ms;
    },
    request: (async (input: any) => {
      const url = new URL(input);
      calls.push(url);
      if (url.pathname === "/v2/libraries/nlb")
        return Response.json({ lendingPeriods: { ebook: 21, audiobook: 14 } });
      if (url.pathname.endsWith("/media")) return Response.json(searchPage);
      const ids = url.searchParams.get("titleIds")!.split(",");
      return Response.json({
        items: ids.map((id) => {
          const found = searchPage.items.find((i) => i.id === id)!;
          return {
            ...found,
            availableCopies: id === "5665700" ? 0 : found.availableCopies,
          };
        }),
      });
    }) as typeof fetch,
  });
  const tools = new LibraryTools(client, () => now);
  return { tools, calls, advance: (ms: number) => (now += ms) };
}

test("the verdict follows the availability rule and never isAvailable", () => {
  const base = {
    availableCopies: 0,
    ownedCopies: 246,
    luckyDayAvailableCopies: 6,
    holdsCount: 2267,
    estimatedWaitDays: 130,
    isHoldable: true,
  };
  assert.deepEqual(verdict(base), {
    verdict: "lucky_day",
    lendingDays: 7,
    holdable: false,
  });
  assert.equal(
    verdict({ ...base, luckyDayAvailableCopies: 0 }).verdict,
    "hold",
  );
  assert.equal(verdict({ ...base, availableCopies: 3 }).verdict, "borrow_now");
  assert.equal(verdict({ ...base, availableCopies: 3 }).lendingDays, 21);
  assert.equal(
    verdict({ ...base, luckyDayAvailableCopies: 0, isHoldable: false }).verdict,
    "unobtainable",
  );
  assert.equal(lendingDaysFrom({ lendingPeriods: { ebook: 14 } }), 14);
  assert.equal(
    lendingDaysFrom({
      settings: {
        lendingPeriods: [{ formatType: "ebook", lendingPeriodDays: 28 }],
      },
    }),
    28,
  );
  assert.equal(lendingDaysFrom({ unrelated: true }), 21);
  assert.match(
    answerHint({
      title: "Project Hail Mary",
      creator: "Andy Weir",
      kobo: true,
      verdict: "lucky_day",
      lendingDays: 7,
      availableCopies: 0,
      luckyDayCopies: 6,
      ownedCopies: 246,
      holdsCount: 2267,
      estimatedWaitDays: 130,
    }),
    /6 Lucky Day copies are free right now: a 7-day loan that cannot be renewed or held/,
  );
  assert.ok(
    score(
      { title: "Project Hail Mary", creator: "Andy Weir" },
      "project hail mary",
      "Weir",
    ) >
      score(
        {
          title: "Project Hail Mary",
          subtitle: "Large Print",
          creator: "Andy Weir",
        },
        "project hail mary",
        "Weir",
      ),
  );
});

test("library_check filters to ebooks, ranks, applies the verdict and caches for fifteen minutes", async () => {
  const h = harness();
  const result = await h.tools.call("123", "run", {
    operation: "library_check",
    query: "project hail mary",
  });
  assert.equal(h.calls.length, 3);
  assert.equal(result.omittedNonEbook, 3);
  assert.equal(result.candidates.length, 3);
  assert.equal(result.candidates[0]!.titleId, "5665700");
  assert.equal(result.candidates[0]!.verdict, "lucky_day");
  assert.equal(result.candidates[0]!.lendingDays, 7);
  assert.equal(result.candidates[0]!.kobo, true);
  assert.equal(result.candidates[1]!.kobo, false);
  assert.equal(result.bestMatch, "5665700");
  assert.equal(result.ambiguous, false);
  assert.match(result.candidates[0]!.answerHint, /Lucky Day/);
  assert.equal(
    result.candidates[0]!.siteUrl,
    "https://nlb.overdrive.com/media/5665700",
  );
  assert.ok(JSON.stringify(result).length < 12000);
  const searchUrl = h.calls.find((u) => u.pathname.endsWith("/media"))!;
  assert.equal(searchUrl.searchParams.get("mediaType"), "ebook");
  assert.equal(searchUrl.searchParams.get("showOnlyAvailable"), null);
  await h.tools.call("123", "run", {
    operation: "library_check",
    query: "project hail mary",
  });
  assert.equal(h.calls.length, 3);
  h.advance(16 * 60000);
  await h.tools.call("123", "run", {
    operation: "library_check",
    query: "project hail mary",
  });
  assert.equal(h.calls.length, 5);
  const again = await h.tools.call("123", "run", {
    operation: "library_availability",
    titleIds: ["5665700", "3"],
  });
  assert.equal(again.titles[1]!.verdict, "borrow_now");
  assert.equal(h.calls.length, 5);
  const vague = await h.tools.check("hail mary");
  assert.equal(vague.ambiguous, true);
  assert.equal(vague.bestMatch, undefined);
});

test("the dispatcher validates arguments, refuses when unconfigured and offers no account data", async () => {
  const db = { query: async () => ({ rows: [] }) } as any;
  const without = new JobTools(db, { call: async () => ({}) });
  await assert.rejects(
    without.execute("123", "run", {
      operation: "library_check",
      query: "dune",
    }),
    (e: any) => toolError(e).code === "NOT_CONFIGURED",
  );
  assert.throws(() =>
    action.parse({ operation: "library_check", query: "dune", user: "456" }),
  );
  assert.throws(() =>
    action.parse({ operation: "library_availability", titleIds: ["abc"] }),
  );
  assert.throws(() =>
    action.parse({
      operation: "library_availability",
      titleIds: ["1", "2", "3", "4", "5", "6"],
    }),
  );
  const h = harness();
  const with_ = new JobTools(
    db,
    { call: async () => ({}) },
    undefined,
    undefined,
    undefined,
    undefined,
    h.tools,
  );
  const result: any = await with_.execute("123", "run", {
    operation: "library_check",
    query: "whalefall",
    author: "Kraus",
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.omittedNonEbook, 3);
  assert.ok(!JSON.stringify(result).includes("cardId"));
});
