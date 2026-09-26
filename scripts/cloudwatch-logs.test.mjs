import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GROUPS,
  MAX_WINDOW_S,
  QUERIES,
  parseArgs,
  parseTime,
} from "./cloudwatch-logs.mjs";

const now = 1_800_000_000;

test("defaults to the last hour, 100 rows, runtime group", () => {
  const r = parseArgs(["errors"], now);
  assert.equal(r.end - r.start, 3600);
  assert.equal(r.limit, 100);
  assert.equal(r.group, GROUPS.runtime);
});

test("rejects windows over 24 hours, too many rows and unknown options", () => {
  assert.throws(() => parseArgs(["errors", "--since", "2d"], now), /24 hours/);
  assert.throws(() => parseArgs(["errors", "--limit", "501"], now), /limit/);
  assert.throws(() => parseArgs(["errors", "--limit", "0"], now), /limit/);
  assert.throws(() => parseArgs(["errors", "--profile", "x"], now), /Unknown/);
  assert.throws(() => parseArgs(["drop"], now), /Unknown query/);
  assert.throws(
    () =>
      parseArgs(
        ["errors", "--since", "2026-09-26T00:00:00", "--until", "now"],
        now,
      ),
    /explicit zone/,
  );
  assert.ok(
    parseArgs(["errors", "--since", "24h"], now).end -
      parseArgs(["errors", "--since", "24h"], now).start <=
      MAX_WINDOW_S,
  );
});

test("run and event filters accept only identifier shapes (no query injection)", () => {
  const r = parseArgs(
    ["run", "--run", "7d0c1c6e-1111-4c2b-9d7e-0123456789ab"],
    now,
  );
  assert.match(r.query, /runId = "7d0c1c6e-1111-4c2b-9d7e-0123456789ab"/);
  for (const bad of ['x" or 1=1 or "', "a b", "", "a|stats count(*)"])
    assert.throws(() => parseArgs(["run", "--run", bad], now), /--run/);
  assert.throws(() => parseArgs(["run"], now), /--run/);
  assert.throws(
    () => parseArgs(["event", "--event", 'x" | fields @message'], now),
    /--event/,
  );
});

test("ISO times with a zone convert to UTC epoch seconds", () => {
  assert.equal(
    parseTime("2026-09-26T08:00:00+08:00", now),
    Date.parse("2026-09-26T00:00:00Z") / 1000,
  );
});

test("no saved query selects the raw message field", () => {
  for (const [name, spec] of Object.entries(QUERIES)) {
    const q = spec.query("run-1", "tool.finished");
    assert.doesNotMatch(q, /@message/, name);
  }
});
