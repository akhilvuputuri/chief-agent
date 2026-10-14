import { test } from "node:test";
import assert from "node:assert/strict";
import { documents } from "../src/documents.js";
import { reportDocument } from "../src/report.js";

test("reference documents require every valid page and start unread in a replacement attempt", async () => {
  const text = "字".repeat(3999) + "😀" + "tail".repeat(3000);
  const d = documents([{ id: "approved_plan", title: "Exact scope", text }]);
  assert.deepEqual(d.unread(), ["approved_plan"]);
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
  assert.deepEqual(d.unread(), ["approved_plan"]);
  const result: string[] = [];
  for (let page = 0; page < Math.ceil(text.length / 4000); page++) {
    const chunk = await read(page);
    assert(!chunk.text.includes("�"));
    for (let i = chunk.from; i < chunk.to; i++)
      result[i] = chunk.text[i - chunk.from];
  }
  assert.equal(result.join(""), text);
  assert.deepEqual(d.unread(), []);
  assert.deepEqual(
    documents([{ id: "approved_plan", title: "Exact scope", text }]).unread(),
    ["approved_plan"],
  );
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
  const text = "a".repeat(3999) + "😀" + "b".repeat(500000 - 4001);
  const input = [{ id: "candidate_diff", title: "Bound candidate diff", text }];
  const evidence = documents(input);
  const restored: string[] = [];
  for (let page = 0; page < 125; page++) {
    const result = await evidence.tool.execute(
      "read",
      { id: "candidate_diff", page },
      undefined,
      undefined,
      {} as any,
    );
    const chunk = JSON.parse((result.content[0] as any).text);
    assert.equal(chunk.pages, 125);
    assert(chunk.text.length <= 4002);
    assert(!chunk.text.includes("�"));
    for (let i = chunk.from; i < chunk.to; i++)
      restored[i] = chunk.text[i - chunk.from];
  }
  assert.equal(restored.join(""), text);
  assert.deepEqual(evidence.unread(), []);
  assert.deepEqual(documents(input).unread(), ["candidate_diff"]);
  assert.throws(() => documents([{ ...input[0]!, text: text + "X" }]));
  assert.throws(() =>
    documents(
      Array.from({ length: 5 }, (_, i) => ({
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
