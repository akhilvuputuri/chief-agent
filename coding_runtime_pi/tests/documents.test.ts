import { test } from "node:test";
import assert from "node:assert/strict";
import { documents } from "../src/documents.js";
import { documentPageChars, reportDocument } from "../src/report.js";

test("reference documents page every character, including a split surrogate pair", async () => {
  // A surrogate pair sits across the first page boundary.
  const text =
    "字".repeat(documentPageChars - 1) +
    "😀" +
    "tail".repeat(documentPageChars);
  const d = documents([{ id: "approved_plan", title: "Exact scope", text }]);
  await assert.rejects(
    d.tool.execute(
      "bad",
      { id: "approved_plan", page: -1 },
      undefined,
      undefined,
      {} as any,
    ),
  );
  const read = async (page: number) => {
    const result = await d.tool.execute(
      "call",
      { id: "approved_plan", page },
      undefined,
      undefined,
      {} as any,
    );
    const block = result.content[0];
    assert.equal(block?.type, "text");
    return JSON.parse((block as { type: "text"; text: string }).text);
  };
  await read(0);
  await read(0);
  const result: string[] = [];
  for (
    let page = 0;
    page < Math.ceil(text.length / documentPageChars);
    page++
  ) {
    const chunk = await read(page);
    assert(!chunk.text.includes("�"));
    for (let i = chunk.from; i < chunk.to; i++)
      result[i] = chunk.text[i - chunk.from];
  }
  assert.equal(result.join(""), text);
});
test("report identity binds full content and verdict independently of summary presentation", () => {
  const base = {
    kind: "review" as const,
    summary: "Status",
    detail: "字".repeat(32000),
    verdict: "APPROVE" as const,
  };
  const original = reportDocument(base);
  assert.notEqual(
    original.hash,
    reportDocument({ ...base, detail: base.detail.slice(0, -1) + "X" }).hash,
  );
  assert.notEqual(
    original.hash,
    reportDocument({ ...base, verdict: "REQUEST_CHANGES" }).hash,
  );
  assert.equal(original.detail, base.detail);
  assert.throws(() => reportDocument({ ...base, detail: base.detail + "X" }));
});

test("complete maximum-size immutable evidence is paged without relaxing report bounds", async () => {
  const text =
    "a".repeat(documentPageChars - 1) +
    "😀" +
    "b".repeat(500000 - documentPageChars - 1);
  const pages = Math.ceil(500000 / documentPageChars);
  const input = [{ id: "candidate_diff", title: "Bound candidate diff", text }];
  const evidence = documents(input);
  const restored: string[] = [];
  for (let page = 0; page < pages; page++) {
    const result = await evidence.tool.execute(
      "read",
      { id: "candidate_diff", page },
      undefined,
      undefined,
      {} as any,
    );
    const chunk = JSON.parse((result.content[0] as any).text);
    assert.equal(chunk.pages, pages);
    assert(chunk.text.length <= documentPageChars + 2);
    assert(!chunk.text.includes("�"));
    for (let i = chunk.from; i < chunk.to; i++)
      restored[i] = chunk.text[i - chunk.from];
  }
  assert.equal(restored.join(""), text);
  assert.throws(() => documents([{ ...input[0]!, text: text + "X" }]));
  assert.throws(() =>
    documents(
      Array.from({ length: 6 }, (_, i) => ({
        id: `doc_${i}`,
        title: "Bound",
        text: "x",
      })),
    ),
  );
  assert.throws(() =>
    reportDocument({
      kind: "review",
      summary: "Bound",
      detail: "x".repeat(32001),
      verdict: "APPROVE",
    }),
  );
});

test("an optional document is marked as optional reading in the description", async () => {
  const d = documents([
    { id: "review_delta", title: "Changed since review", text: "delta" },
    {
      id: "candidate_diff",
      title: "Complete diff",
      text: "x".repeat(documentPageChars * 3),
      optional: true,
    },
  ]);
  assert.match(d.description, /candidate_diff: .*3 pages; optional reference/);
  assert.doesNotMatch(d.description, /review_delta: .*optional/);
  const read = (id: string, page: number) =>
    d.tool.execute("call", { id, page }, undefined, undefined, {} as any);
  await read("candidate_diff", 1);
  await read("review_delta", 0);
  // One page now carries what took eight: a 300,000-character diff is 10 pages, not 75.
  assert.equal(documentPageChars, 32000);
});
