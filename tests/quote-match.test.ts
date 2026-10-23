import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchQuote,
  matchQuoteDetailed,
  containsToken,
} from "../src/quote-match.js";
import { checkResearchQuote } from "../src/research.js";
import { budgetNotice } from "../src/custom-agent.js";

const page =
  "The museum’s hours:\n\n  “Open   daily, 10am – 6pm.”\nLast entry is 30 minutes before closing. Closed on Christmas Day—and on New Year’s Day.";

test("a quote that differs only in typography matches and returns the source's own words", () => {
  // Exact text is returned unchanged.
  assert.equal(
    matchQuote(page, "Last entry is 30 minutes"),
    "Last entry is 30 minutes",
  );
  // Straight for curly quotes, a hyphen for an en dash, single for repeated or no-break spaces.
  assert.equal(
    matchQuote(page, '"Open daily, 10am - 6pm."'),
    "“Open daily, 10am – 6pm.”",
  );
  assert.equal(matchQuote(page, "The museum's hours:"), "The museum’s hours:");
  assert.equal(
    matchQuote(page, "Christmas Day--and"),
    undefined,
    "two hyphens are not one dash",
  );
  assert.equal(
    matchQuote(page, "Christmas Day-and on New Year's Day"),
    "Christmas Day—and on New Year’s Day",
  );
  // Zero-width characters in the source do not change the wording.
  assert.equal(matchQuote("Open​ daily", "Open daily"), "Open​ daily");
});

test("an elided quote over a short span comes back whole, so omitted words stay visible", () => {
  assert.equal(
    matchQuote(page, "Open daily ... Closed on Christmas Day"),
    "Open daily, 10am – 6pm.” Last entry is 30 minutes before closing. Closed on Christmas Day",
  );
  assert.equal(
    matchQuote(page, "museum’s hours: […] Last entry is 30 minutes"),
    "museum’s hours: “Open daily, 10am – 6pm.” Last entry is 30 minutes",
  );
  // An omitted negation is returned, not hidden behind the ellipsis.
  assert.equal(
    matchQuote(
      "Trial results: The drug is not effective in adults over 65.",
      "The drug is ... effective in adults",
    ),
    "The drug is not effective in adults",
  );
  // A leading or trailing ellipsis just marks an excerpt.
  assert.equal(
    matchQuote(page, "…Last entry is 30 minutes…"),
    "Last entry is 30 minutes",
  );
  // A source that itself contains "..." still matches directly.
  assert.equal(
    matchQuote("Loading... done", "Loading... done"),
    "Loading... done",
  );
});

test("a longer elided span comes back elided, and a span past the bound is refused", () => {
  const filler = (n: number) => "Unrelated filler sentence here. ".repeat(n);
  const near = `The company announced today ${filler(12)}that it has been acquired by Microsoft.`;
  assert.equal(
    matchQuote(near, "The company announced ... acquired by Microsoft"),
    "The company announced … acquired by Microsoft",
  );
  // Reproduced in review: four pieces matched across about 30k characters.
  const far = `The company ${filler(300)} has been ${filler(300)} acquired by ${filler(300)} Microsoft.`;
  assert.equal(
    matchQuote(far, "The company ... has been ... acquired by ... Microsoft"),
    undefined,
  );
  // The shortest span counts, not the first occurrence of the first piece.
  const repeated = `The company said ${filler(30)} The company said it was acquired by Microsoft.`;
  assert.equal(
    matchQuote(repeated, "The company said ... acquired by Microsoft"),
    "The company said it was acquired by Microsoft",
  );
});

test("an elided quote is refused when its pieces split words, come out of order or are too many", () => {
  // Reproduced in review: "profitable" matched inside "unprofitable".
  assert.equal(
    matchQuote(
      "The firm said the firm is unprofitable this year.",
      "The firm said ... profitable this year",
    ),
    undefined,
  );
  assert.equal(
    matchQuote("alpha beta gamma", "alpha be...ta gamma"),
    undefined,
  );
  // The same bound applies to an excerpt marked by a leading or trailing ellipsis.
  assert.equal(
    matchQuote("It was unprofitable this year.", "...profitable this year"),
    undefined,
  );
  // And to a contiguous quote: it may not start or end inside a word.
  assert.equal(
    matchQuote("It was unprofitable this year.", "profitable this year"),
    undefined,
  );
  // Scripts written without spaces have no word boundary to check.
  assert.equal(
    matchQuote("新加坡国立大学图书馆开放时间", "图书馆开放时间"),
    "图书馆开放时间",
  );
  // Out of order: the pieces exist, but not in this order.
  assert.equal(
    matchQuote(page, "Closed on Christmas Day ... Open daily, 10am"),
    undefined,
  );
  // Short pieces could be stitched from anywhere.
  assert.equal(matchQuote(page, "Open ... 6pm"), undefined);
  // Four pieces are allowed; a fifth is a collage.
  const five =
    "Alpha section one. Bravo section two. Charlie section three. Delta section four. Echo section five.";
  assert.equal(
    matchQuote(
      five,
      "Alpha section ... Bravo section ... Charlie section ... Delta section",
    ),
    "Alpha section one. Bravo section two. Charlie section three. Delta section",
  );
  assert.equal(
    matchQuote(
      five,
      "Alpha section ... Bravo section ... Charlie section ... Delta section ... Echo section",
    ),
    undefined,
  );
});

test("a match may not start or end inside a word joined by an apostrophe, hyphen or number punctuation", () => {
  // Reproduced in the delta review: each of these passed before.
  for (const [source, quote] of [
    ["Officials say they can't confirm the date.", "they can"],
    ["The compound is non-toxic in rats.", "toxic in rats"],
    ["Stock: 1,234 units remain.", "234 units"],
    ["Revenue was 1.5 million last year.", "5 million"],
    ["The plan costs $12.99 per month.", "99 per month"],
    // The same holds for each piece of an elided quote.
    [
      "Officials say they can't confirm the date of the meeting.",
      "Officials say they can ... the meeting",
    ],
  ])
    assert.equal(matchQuote(source, quote), undefined, quote);
  // The accepted cost: a possessive's word cannot be quoted without its "'s".
  assert.equal(matchQuote("The firm's revenue rose.", "The firm"), undefined);
  assert.equal(
    matchQuote("The firm's revenue rose.", "The firm's revenue"),
    "The firm's revenue",
  );
  // Whole words and numbers still match, and sentence punctuation ends a word.
  assert.equal(
    matchQuote("Revenue was 1.5 million last year.", "1.5 million"),
    "1.5 million",
  );
  assert.equal(
    matchQuote("It ended in 2024. Then", "ended in 2024"),
    "ended in 2024",
  );
  assert.equal(matchQuote("They can't, he said.", "they can't"), undefined);
  assert.equal(matchQuote("They can't, he said.", "They can't"), "They can't");
  // An en or em dash between words separates them; a hyphen joins them.
  assert.equal(
    matchQuote("Open Monday–Friday from 9am.", "Friday from 9am"),
    "Friday from 9am",
  );
  assert.equal(matchQuote("A well-known fact.", "known fact"), undefined);
  // A leading sign belongs to its number; a dash after a word is a range.
  assert.equal(matchQuote("Shares fell -5% today.", "5% today"), undefined);
  assert.equal(matchQuote("Shares fell −5% today.", "5% today"), undefined);
  assert.equal(matchQuote("Shares fell -5% today.", "-5% today"), "-5% today");
  assert.equal(matchQuote("Open 9am-5pm daily.", "5pm daily"), "5pm daily");
});

/** A span of `length` filler characters, in words. */
const words = (length: number) =>
  "the quarterly figures were reviewed in detail by staff "
    .repeat(Math.ceil(length / 55))
    .slice(0, length)
    .replace(/\S*$/, "");

test("a long elided span may not hide a negating or limiting word", () => {
  // Reproduced in the delta review: "not" about 380 characters into the span.
  const negated = `The board said the merger ${words(350)} was not approved by regulators this year.`;
  const quote = "The board said the merger ... approved by regulators";
  assert.deepEqual(matchQuoteDetailed(negated, quote), {
    refused: "hidden_qualifier",
  });
  // The same span without the negation comes back elided.
  assert.equal(
    matchQuote(negated.replace("was not approved", "was approved"), quote),
    "The board said the merger … approved by regulators",
  );
  // "only" about 350 characters in.
  const limited = `Members may borrow ten books ${words(320)} only from the central branch each month.`;
  assert.deepEqual(
    matchQuoteDetailed(
      limited,
      "Members may borrow ten books ... from the central branch",
    ),
    { refused: "hidden_qualifier" },
  );
  // "cannot" and other reversing words count too.
  const cannot = `The review found the treatment ${words(350)} cannot be effective in adults.`;
  assert.deepEqual(
    matchQuoteDetailed(
      cannot,
      "The review found the treatment ... be effective in adults",
    ),
    { refused: "hidden_qualifier" },
  );
  // A qualifier inside a quoted piece is shown, so it is not refused.
  assert.equal(
    matchQuote(
      negated,
      "The board said the merger ... was not approved by regulators",
    ),
    "The board said the merger … was not approved by regulators",
  );
});

test("a hidden-qualifier refusal tells the child to quote the passage contiguously", async () => {
  const content = `The board said the merger ${words(350)} was not approved by regulators.`;
  const req = {
    execution: {
      user: "owner",
      db: { query: async () => ({ rows: [{ content, url: "https://x" }] }) },
    },
  } as any;
  await assert.rejects(
    checkResearchQuote(
      req,
      "run",
      "source",
      "The board said the merger ... approved by regulators",
      { tolerant: true },
    ),
    /leaving out a negating or limiting word.*Quote that passage without "\.\.\."/,
  );
  // One report check reads and normalises a cited source once.
  let reads = 0;
  const counting = {
    execution: {
      user: "owner",
      db: {
        query: async () => {
          reads++;
          return { rows: [{ content, url: "https://x" }] };
        },
      },
    },
  } as any;
  const sources = new Map();
  for (const quote of ["The board said", "approved by regulators"])
    await checkResearchQuote(counting, "run", "source", quote, {
      tolerant: true,
      sources,
    });
  assert.equal(reads, 1);
  // A source cached by an exact check still serves a later tolerant one.
  const mixed = new Map();
  await checkResearchQuote(counting, "run", "source", "The board said", {
    sources: mixed,
  });
  assert.equal(
    (
      await checkResearchQuote(counting, "run", "source", "The   board said", {
        tolerant: true,
        sources: mixed,
      })
    ).quote,
    "The board said",
  );
});

test("a fabricated or altered quote is refused", () => {
  assert.equal(matchQuote(page, "Open on Sundays until midnight"), undefined);
  assert.equal(matchQuote(page, '"Open daily, 9am - 6pm."'), undefined);
  assert.equal(matchQuote(page, "open daily"), undefined, "case still matters");
  assert.equal(
    matchQuote(page, "Open daily ... Closed on Boxing Day"),
    undefined,
  );
  assert.equal(matchQuote(page, "  ...  "), undefined);
});

test("a short ref matches only as a whole token, not inside a longer number or word", () => {
  assert(containsToken("Library record 1234567 (branch 042).", "1234567"));
  assert(containsToken("Library record 1234567 (branch 042).", "042"));
  assert(containsToken('{"id":1234567}', "1234567"));
  assert(containsToken("D05.SI closed higher", "D05.SI"));
  assert(!containsToken("record 91234567", "1234567"));
  assert(!containsToken("record 12345678", "1234567"));
  assert(!containsToken("reading 1234567.5", "1234567"));
  assert(!containsToken("total 123.45", "123"));
  assert(!containsToken("total 1,234", "234"));
  assert(!containsToken("id_1234567", "1234567"));
  // A later whole occurrence still counts.
  assert(containsToken("91234567 then 1234567.", "1234567"));
});

test("a child is warned one call before its last and offered only its report on the last", () => {
  const allocation = 90000;
  assert.equal(
    budgetNotice(
      { ms: 80000, models: 3, tools: 10 },
      allocation,
      "agent_report",
    ),
    undefined,
  );
  const warning = budgetNotice(
    { ms: 80000, models: 1, tools: 10 },
    allocation,
    "agent_report",
  );
  assert.equal(warning?.final, false);
  for (const left of [
    { ms: 80000, models: 0, tools: 10 },
    { ms: 80000, models: 3, tools: 1 },
    { ms: 15000, models: 3, tools: 10 },
  ])
    assert.equal(
      budgetNotice(left, allocation, "research_report")?.final,
      true,
      JSON.stringify(left),
    );
  // A short allocation is not treated as running out from its first call.
  assert.equal(
    budgetNotice({ ms: 15000, models: 3, tools: 10 }, 20000, "agent_report"),
    undefined,
  );
});
