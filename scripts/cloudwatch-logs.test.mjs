import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GROUPS,
  MAX_WINDOW_S,
  QUERIES,
  parseArgs,
  parseTime,
  redact,
  clientOptions,
} from "./cloudwatch-logs.mjs";
import { HttpsProxyAgent } from "https-proxy-agent";

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

test("error output removes ARNs and account IDs", () => {
  const out = redact(
    "User: arn:aws:iam::123456789012:user/chief-log-reader-cloud is not authorized to perform: logs:StartQuery on resource: arn:aws:logs:ap-southeast-1:123456789012:log-group:/x:* because no identity-based policy allows it (account 123456789012)",
  );
  assert.doesNotMatch(out, /123456789012|chief-log-reader|arn:aws/);
  assert.match(out, /not authorized to perform: logs:StartQuery/);
});

test("errors query avoids the level in-list form that Logs Insights matched nothing for", () => {
  // Observed 26 September 2026: `filter level in ["error","warn"]` returned 0 rows
  // while `level = "error"` matched the same line; see journal 35.
  const q = QUERIES.errors.query();
  assert.doesNotMatch(q, /level in/);
  assert.match(q, /level = "error" or level = "warn"/);
});

test("event and run queries show delivery, routing and approval fields", () => {
  for (const name of ["event", "run", "errors"]) {
    const q = QUERIES[name].query("run-1", "telegram.delivered");
    for (const field of ["kind", "lane", "inputId", "approvalId", "approved"])
      assert.match(q, new RegExp(`\\b${field}\\b`), `${name} ${field}`);
  }
});

test("no saved query lists a display field twice", () => {
  for (const [name, spec] of Object.entries(QUERIES)) {
    const q = spec.query("run-1", "tool.finished");
    const m = /^fields ([^|]+)/.exec(q);
    if (!m) continue;
    const fields = m[1].split(",").map((f) => f.trim());
    assert.equal(new Set(fields).size, fields.length, name);
  }
});

test("uses the session proxy only when HTTPS_PROXY is set", () => {
  const direct = clientOptions({});
  assert.equal(direct.requestHandler.httpsAgent, undefined);
  assert.equal(direct.region, "ap-southeast-1");
  const proxied = clientOptions({ HTTPS_PROXY: "http://127.0.0.1:3128" });
  assert.ok(proxied.requestHandler.httpsAgent instanceof HttpsProxyAgent);
  assert.equal(proxied.requestHandler.throwOnRequestTimeout, true);
  const lower = clientOptions({ https_proxy: "http://127.0.0.1:3128" });
  assert.ok(lower.requestHandler.httpsAgent instanceof HttpsProxyAgent);
});
