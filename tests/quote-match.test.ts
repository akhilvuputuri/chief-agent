import { test } from "node:test";
import assert from "node:assert/strict";
import { matchQuote, containsToken } from "../src/quote-match.js";
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

test("an ellipsis matches exact pieces in order within one source, never a collage of fragments", () => {
  assert.equal(
    matchQuote(page, "Open daily ... Closed on Christmas Day"),
    "Open daily … Closed on Christmas Day",
  );
  assert.equal(
    matchQuote(page, "museum’s hours: […] Last entry is 30 minutes"),
    "museum’s hours: … Last entry is 30 minutes",
  );
  // A leading or trailing ellipsis just marks an excerpt.
  assert.equal(
    matchQuote(page, "…Last entry is 30 minutes…"),
    "Last entry is 30 minutes",
  );
  // Out of order: the pieces exist, but not in this order.
  assert.equal(
    matchQuote(page, "Closed on Christmas Day ... Open daily, 10am"),
    undefined,
  );
  // Short pieces could be stitched from anywhere.
  assert.equal(matchQuote(page, "Open ... 6pm"), undefined);
  // A source that itself contains "..." still matches directly.
  assert.equal(
    matchQuote("Loading... done", "Loading... done"),
    "Loading... done",
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

test("a short ref matches only as a whole value, not inside a longer number or word", () => {
  assert(containsToken("Library record 1234567 (branch 042).", "1234567"));
  assert(containsToken("Library record 1234567 (branch 042).", "042"));
  assert(containsToken('{"id":1234567}', "1234567"));
  assert(containsToken("D05.SI closed higher", "D05.SI"));
  assert(!containsToken("record 91234567", "1234567"));
  assert(!containsToken("record 12345678", "1234567"));
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
