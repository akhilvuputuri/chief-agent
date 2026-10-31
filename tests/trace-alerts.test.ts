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
    /is 45\.6% over the last 7 days, below the limit of 60%/,
  );
});

test("a monitor's name is one plain line, and changes are said plainly", () => {
  assert.match(
    alertText(alert({ monitor_name: "x\n*URGENT* run\u202e it" })),
    /^Alert: x \*URGENT\* run it is 42%/,
  );
  assert.equal(
    alertText(alert({ kind: "resolved", value: null, reason: "removed" })),
    "Resolved: Tool errors no longer applies; the monitor was deleted.",
  );
  assert.equal(
    alertText(alert({ kind: "resolved", value: null, reason: "changed" })),
    "Resolved: Tool errors no longer applies; the monitor was changed or switched off.",
  );
});

test("an alert is marked delivered only after it was sent", async () => {
  const sent: string[] = [];
  const { post, marked } = server([alert(), alert({ id: "a2" })]);
  const relay = new AlertRelay(
    "http://agentwatch:4318",
    ["o"],
    async (_o, t) => void sent.push(t),
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
      ["o"],
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
      ["o"],
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
      ["o"],
      async (_o, t) => void sent.push(t),
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
      ["o"],
      async (_o, t) => {
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

test("a retry repeats nothing to whoever already has the alert", async () => {
  const restore = setOpsSink(() => undefined);
  try {
    // The mark fails: the owner gets it once, and only the mark is retried.
    const sent: string[] = [];
    const marking = server([alert()], true);
    const relay = new AlertRelay(
      "http://agentwatch:4318",
      ["o"],
      async (_o, t) => void sent.push(t),
      marking.post,
    );
    await relay.poll();
    await relay.poll();
    assert.equal(sent.length, 1);
    assert.equal(marking.marked.length, 2);

    // A second owner who cannot be reached: the first gets one copy, and after a few polls
    // the alert stops holding up the queue.
    const got: string[] = [];
    const partial = server([alert()]);
    const two = new AlertRelay(
      "http://agentwatch:4318",
      ["first", "gone"],
      async (owner) => {
        if (owner === "gone") throw new Error("bot was never started");
        got.push(owner);
      },
      partial.post,
    );
    for (let i = 0; i < 4; i++) await two.poll();
    assert.deepEqual(got, ["first"]);
    assert.deepEqual(partial.marked, []);
    assert.equal(await two.poll(), 1);
    assert.equal(partial.marked.length, 1);

    // Reaching nobody, it keeps waiting however long Telegram is down.
    const none = server([alert()]);
    const down = new AlertRelay(
      "http://agentwatch:4318",
      ["o"],
      async () => {
        throw new Error("down");
      },
      none.post,
    );
    for (let i = 0; i < 8; i++) await down.poll();
    assert.deepEqual(none.marked, []);
  } finally {
    setOpsSink(restore);
  }
});

test("a resolved message cannot overtake its alert", async () => {
  const restore = setOpsSink(() => undefined);
  try {
    const sent: string[] = [];
    let telegramUp = false;
    const { post } = server([
      alert({ id: "firing" }),
      alert({ id: "resolved", kind: "resolved", value: 0.1 }),
    ]);
    const relay = new AlertRelay(
      "http://agentwatch:4318",
      ["o"],
      async (_o, t) => {
        if (!telegramUp && t.startsWith("Alert")) throw new Error("flaky");
        sent.push(t);
      },
      post,
    );
    assert.equal(await relay.poll(), 0);
    assert.deepEqual(sent, []);
    telegramUp = true;
    assert.equal(await relay.poll(), 2);
    assert.match(sent[0]!, /^Alert/);
    assert.match(sent[1]!, /^Resolved/);
  } finally {
    setOpsSink(restore);
  }
});

test("an unreadable alert is reported and cannot block the ones after it", async () => {
  const lines: string[] = [];
  const restore = setOpsSink((line) => void lines.push(line));
  try {
    const sent: string[] = [];
    const { post, marked } = server([
      { id: "bad", value: "NaN" },
      { id: "../no-id" },
      alert({ id: "good" }),
    ]);
    const relay = new AlertRelay(
      "http://agentwatch:4318",
      ["o"],
      async (_o, t) => void sent.push(t),
      post,
    );
    assert.equal(await relay.poll(), 2);
    assert.match(sent[0]!, /could not read/);
    assert.match(sent[1]!, /^Alert: Tool errors/);
    assert.deepEqual(marked, [
      "http://agentwatch:4318/api/alerts/bad/delivered",
      "http://agentwatch:4318/api/alerts/good/delivered",
    ]);
    assert.ok(lines.some((l) => l.includes("ALERT_INVALID")));
  } finally {
    setOpsSink(restore);
  }
});

test("wording: singular units, a score as a percentage, and when a late alert was raised", () => {
  const now = 2_000_000_000_000;
  assert.match(
    alertText(alert({ samples: 1, window_minutes: 1 }), now),
    /over the last 1 minute, above .* \(1 sample\)/,
  );
  assert.match(
    alertText(
      alert({
        metric: "score_mean",
        comparison: "below",
        threshold: 0.6,
        value: 0.456,
      }),
      now,
    ),
    /is 45\.6% .*below the limit of 60%/,
  );
  const at = (minutes: number) =>
    String(BigInt(now - minutes * 60_000) * 1_000_000n);
  assert.doesNotMatch(alertText(alert({ created_ns: at(2) }), now), /raised/);
  assert.match(
    alertText(alert({ created_ns: at(45) }), now),
    /raised 45 minutes ago/,
  );
  assert.match(
    alertText(alert({ created_ns: at(300) }), now),
    /raised 5 hours ago/,
  );
});

test("the base URL comes from the traces endpoint", () => {
  assert.equal(
    alertsBase("http://agentwatch:4318/v1/traces"),
    "http://agentwatch:4318",
  );
});
