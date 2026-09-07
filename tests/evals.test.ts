import { test } from "node:test";
import assert from "node:assert/strict";
import { grade } from "../evals/grade.js";
const expected = [
  { id: "a", title: "A" },
  { id: "b", title: "B" },
];
const item = (id: string, title: string) => ({
  id,
  title,
  assessment: "unknown",
  reason: "No evidence supplied",
});
test("eval grader catches substitution, duplicate coverage and false completion", () => {
  const g = grade(
    JSON.stringify({ complete: true, items: [item("a", "A"), item("x", "X")] }),
    expected,
  );
  assert.equal(g.pass, false);
  assert.equal(g.falseCompletion, true);
  assert.deepEqual(g.missing, ["b"]);
  assert.equal(
    grade(
      JSON.stringify({
        complete: true,
        items: [item("a", "A"), item("a", "A")],
      }),
      expected,
    ).duplicates,
    1,
  );
});
test("eval grader does not reward invalid output or guessed experience", () => {
  assert.equal(grade("done", expected).pass, false);
  const items = [item("a", "A"), { ...item("b", "B"), assessment: "gap" }];
  assert.equal(
    grade(JSON.stringify({ complete: true, items }), expected)
      .unknownsPreserved,
    false,
  );
  assert.equal(
    grade(
      JSON.stringify({
        complete: true,
        items: [item("a", "A"), item("b", "B")],
      }),
      expected,
    ).pass,
    true,
  );
});
