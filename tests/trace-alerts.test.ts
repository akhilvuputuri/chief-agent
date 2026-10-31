import { test } from "node:test";
import assert from "node:assert/strict";
import { setOpsSink } from "../src/ops-log.js";
import {
  AlertRelay,
  alertsBase,
  alertText,
  type MonitorAlert,
} from "../src/trace-alerts.js";

const alert = (over: Partial<MonitorAlert> = {}): MonitorAlert => ({
  id: "a1",
  monitor_name: "Tool errors",
  kind: "firing",
  metric: "tool_error_rate",
  comparison: "above",
  threshold: 0.3,
  value: 0.42,
  bound: 0.33,
  samples: 50,
  window_minutes: 1440,
  ...over,
});

function server(alerts: unknown[], failMark = false) {
  const marked: string[] = [];
  const post = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST") {
      marked.push(u);
      return new Response("{}", { status: failMark ? 500 : 200 });
    }
    return new Response(JSON.stringify({ alerts }), { status: 200 });
  }) as typeof fetch;
  return { post, marked };
}

test("alert text shows the numbers in the metric's own units", () => {
  assert.equal(
    alertText(alert()),
    "Alert: Tool errors is 42% over the last 24 hours, above the limit of 30% (50 samples). Details in agentwatch.",
  );
  assert.equal(
    alertText(alert({ kind: "resolved", value: 0.1 })),
    "Resolved: Tool errors is back to 10% over the last 24 hours (limit 30%).",
  );
  assert.match(
    alertText(
      alert({
        metric: "cost_usd",
        threshold: 5,
        value: 6.5,
        window_minutes: 60,
      }),
    ),
    /is \$6\.50 over the last 1 hour, above the limit of \$5\.00/,
  );
  assert.match(
    alertText(
      alert({
        metric: "model_p95_ms",
        threshold: 20000,
        value: 31000,
        window_minutes: 90,
      }),
    ),
    /is 31\.0 s over the last 90 minutes/,
  );
  assert.match(
    alertText(
      alert({
        metric: "score_mean",
        comparison: "below",
        threshold: 0.6,
        value: 0.456,
        window_minutes: 7 * 1440,
      }),
    ),
    /is 0\.456 over the last 7 days, below the limit of 0\.6/,
  );
});

test("an alert is marked delivered only after it was sent", async () => {
  const sent: string[] = [];
  const { post, marked } = server([alert(), alert({ id: "a2" })]);
  const relay = new AlertRelay(
    "http://agentwatch:4318",
    async (t) => void sent.push(t),
    post,
  );
  const restore = setOpsSink(() => undefined);
  try {
    assert.equal(await relay.poll(), 2);
    assert.equal(sent.length, 2);
    assert.deepEqual(marked, [
      "http://agentwatch:4318/api/alerts/a1/delivered",
      "http://agentwatch:4318/api/alerts/a2/delivered",
    ]);

    // Telegram failing: not marked, so it is retried on the next poll.
    const failing = server([alert()]);
    const down = new AlertRelay(
      "http://agentwatch:4318",
      async () => {
        throw new Error("telegram down");
      },
      failing.post,
    );
    assert.equal(await down.poll(), 0);
    assert.deepEqual(failing.marked, []);
  } finally {
    setOpsSink(restore);
  }
});

test("agentwatch being down, or sending nonsense, costs a log line an hour and never throws", async () => {
  const lines: string[] = [];
  const restore = setOpsSink((line) => void lines.push(line));
  let now = 1_000_000;
  try {
    const down = new AlertRelay(
      "http://agentwatch:4318",
      async () => assert.fail("nothing to send"),
      (async () => {
        throw new Error("refused");
      }) as typeof fetch,
      () => now,
    );
    assert.equal(await down.poll(), 0);
    assert.equal(await down.poll(), 0);
    assert.equal(lines.filter((l) => l.includes("alerts_failed")).length, 1);
    now += 3_600_000;
    await down.poll();
    assert.equal(lines.filter((l) => l.includes("alerts_failed")).length, 2);

    const sent: string[] = [];
    const nonsense = server([{ id: "../x", kind: 1 }]);
    const relay = new AlertRelay(
      "http://agentwatch:4318",
      async (t) => void sent.push(t),
      nonsense.post,
    );
    assert.equal(await relay.poll(), 0);
    assert.deepEqual(sent, []);
    assert.deepEqual(nonsense.marked, []);
  } finally {
    setOpsSink(restore);
  }
});

test("at most five alerts a poll, and polls do not overlap", async () => {
  const many = Array.from({ length: 8 }, (_, i) => alert({ id: `a${i}` }));
  const sent: string[] = [];
  const { post } = server(many);
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const restore = setOpsSink(() => undefined);
  try {
    const relay = new AlertRelay(
      "http://agentwatch:4318",
      async (t) => {
        await gate;
        sent.push(t);
      },
      post,
    );
    const first = relay.poll();
    assert.equal(await relay.poll(), 0);
    release();
    assert.equal(await first, 5);
    assert.equal(sent.length, 5);
  } finally {
    setOpsSink(restore);
  }
});

test("the base URL comes from the traces endpoint", () => {
  assert.equal(
    alertsBase("http://agentwatch:4318/v1/traces"),
    "http://agentwatch:4318",
  );
});
