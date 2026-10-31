import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { allTestFiles, assignShards, parseShard } from "./test-shard.mjs";
import { testTitles, weightsFromLog } from "./update-test-weights.mjs";

test("every test file lands in exactly one shard, including unrecorded ones", () => {
  const files = allTestFiles();
  const weights = JSON.parse(readFileSync("tests/test-weights.json", "utf8"));
  const shards = assignShards(
    [...files, "tests/brand-new.test.ts"],
    weights,
    6,
  );
  assert.equal(shards.length, 6);
  assert.deepEqual(
    shards.flat().sort(),
    [...files, "tests/brand-new.test.ts"].sort(),
  );
});

test("shards are deterministic and balanced by recorded time", () => {
  const weights = {
    "a.ts": 100,
    "b.ts": 60,
    "c.ts": 40,
    "d.ts": 30,
    "e.ts": 30,
    "f.ts": 20,
  };
  const files = Object.keys(weights);
  const shards = assignShards(files, weights, 2);
  assert.deepEqual(shards, assignShards([...files].reverse(), weights, 2));
  const totals = shards.map((s) => s.reduce((n, f) => n + weights[f], 0));
  assert.ok(Math.abs(totals[0] - totals[1]) <= 20, String(totals));
});

test("the recorded times give shards far closer than an even file split", () => {
  const files = allTestFiles();
  const weights = JSON.parse(readFileSync("tests/test-weights.json", "utf8"));
  const totals = assignShards(files, weights, 6).map((s) =>
    s.reduce((n, f) => n + (weights[f] ?? 0), 0),
  );
  assert.ok(Math.max(...totals) - Math.min(...totals) < 15, String(totals));
});

test("a malformed shard is refused", () => {
  assert.deepEqual(parseShard("2/6"), { index: 2, count: 6 });
  for (const bad of ["0/6", "7/6", "2", "a/b"])
    assert.throws(() => parseShard(bad));
});

test("weights credit each duration to the file declaring that title", () => {
  const owners = testTitles({
    "tests/a.test.ts": `test("first", () => {});\ntest("it's shared", () => {});`,
    "tests/b.test.ts": `test(\n  "second \\"quoted\\"",\n  () => {},\n);\ntest("it's shared", () => {});`,
  });
  const row = (shard, text) =>
    `tests ${shard}/6\tstep\t2026-10-31T09:06:38.1Z ${text}`;
  const log = [
    row(1, "ok 1 - first"),
    row(1, "  ---"),
    row(1, "  duration_ms: 1500"),
    row(2, 'ok 1 - second "quoted"'),
    row(2, "  duration_ms: 2000"),
    row(2, "ok 2 - it's shared"),
    row(2, "  duration_ms: 9000"),
    row(1, "not ok 2 - first"),
    row(1, "  duration_ms: 500"),
    "format and types\tstep\t2026-10-31T09:06:38.1Z ok 1 - first",
  ].join("\n");
  assert.deepEqual(weightsFromLog(log, owners), {
    "tests/a.test.ts": 2,
    "tests/b.test.ts": 2,
  });
});

test("weights credit templated titles, and a literal title beats a template", () => {
  const owners = testTitles({
    "tests/loop.test.ts":
      "test(`preserves ${size}-character reports`, () => {});",
    "tests/exact.test.ts": 'test("preserves 8-character reports", () => {});',
  });
  const row = (text) => `tests 1/6\tstep\t2026-10-31T09:06:38.1Z ${text}`;
  const log = [
    row("ok 1 - preserves 16000-character reports"),
    row("  duration_ms: 3000"),
    row("ok 2 - preserves 8-character reports"),
    row("  duration_ms: 1000"),
    row("ok 3 - preserves nothing"),
    row("  duration_ms: 9000"),
  ].join("\n");
  assert.deepEqual(weightsFromLog(log, owners), {
    "tests/exact.test.ts": 1,
    "tests/loop.test.ts": 3,
  });
});
