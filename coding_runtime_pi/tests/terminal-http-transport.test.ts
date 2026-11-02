import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  gatewayOutageFetch,
  terminalHttpRecoveryFetch,
  terminalHttpStatuses,
  retryParentHeader,
} from "../src/terminal-http-recovery.js";

const baseUrl = "https://synthetic.invalid/v1";
const attemptId = randomUUID();
function payload() {
  return {
    runtime_call_id: randomUUID(),
    model: "synthetic/model",
    runtime_purpose: "agent",
    max_tokens: 16000,
    messages: [{ role: "user", content: "Exact café scope" }],
    tools: [],
    cache_control: { type: "ephemeral" },
  };
}
function receipt(callId: string, providerStatus = 504): any {
  return {
    code:
      providerStatus === 429 ? "model_rate_limited" : "model_transient_failure",
    recovery: {
      version: 1,
      kind: "terminal-provider-http",
      callId,
      attemptId,
      providerStatus,
    },
  };
}
function json(value: unknown, status = 409) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

for (const status of terminalHttpStatuses)
  test(`terminal ${status} gets exactly one separately admitted attempt`, async () => {
    const body = payload(),
      requests: Request[] = [],
      bodies: any[] = [];
    let admissions = 0;
    const send = terminalHttpRecoveryFetch({
      baseUrl,
      attemptId,
      requestIdField: "runtime_call_id",
      admit: async () => {
        admissions++;
      },
      fetch: async (input) => {
        const request = input as Request;
        requests.push(request);
        bodies.push(await request.json());
        return json(receipt(bodies.at(-1).runtime_call_id, status));
      },
    });
    const response = await send(`${baseUrl}/chat/completions`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        authorization: "Bearer synthetic",
        "x-cache-key": "unchanged",
      },
    });
    assert.equal(response.status, 409);
    await response.text();
    assert.equal(requests.length, 2);
    assert.equal(admissions, 1);
    assert.notEqual(bodies[1].runtime_call_id, body.runtime_call_id);
    assert.deepEqual(
      { ...bodies[1], runtime_call_id: body.runtime_call_id },
      body,
    );
    assert.equal(
      requests[1]!.headers.get(retryParentHeader),
      body.runtime_call_id,
    );
    assert.equal(requests[1]!.headers.get("authorization"), "Bearer synthetic");
    assert.equal(requests[1]!.headers.get("x-cache-key"), "unchanged");
  });

for (const scenario of [
  "missing",
  "wrong-call",
  "wrong-attempt",
  "wrong-code",
  "wrong-version",
  "extra-field",
  "status-400",
  "status-501",
  "success-response",
  "wrong-route",
  "already-child",
  "malformed",
  "oversized",
  "plain-text",
  "empty",
])
  test(`ineligible receipt: ${scenario}`, async () => {
    const body = payload(),
      value = receipt(body.runtime_call_id);
    if (scenario === "missing") delete value.recovery;
    if (scenario === "wrong-call") value.recovery.callId = randomUUID();
    if (scenario === "wrong-attempt") value.recovery.attemptId = randomUUID();
    if (scenario === "wrong-code") value.code = "model_timeout";
    if (scenario === "wrong-version") value.recovery.version = 2;
    if (scenario === "extra-field") value.recovery.generationReturned = true;
    if (scenario.startsWith("status-"))
      value.recovery.providerStatus = Number(scenario.slice(7));
    let calls = 0,
      admissions = 0;
    const expected =
      scenario === "malformed"
        ? new Response("{", {
            status: 409,
            headers: { "content-type": "application/json" },
          })
        : scenario === "oversized"
          ? json({ ...value, padding: "x".repeat(5000) })
          : scenario === "plain-text"
            ? new Response(JSON.stringify(value), { status: 409 })
            : scenario === "empty"
              ? json(null)
              : json(value, scenario === "success-response" ? 200 : 409);
    const send = terminalHttpRecoveryFetch({
      baseUrl,
      attemptId,
      requestIdField: "runtime_call_id",
      admit: async () => {
        admissions++;
      },
      fetch: async () => {
        calls++;
        return expected;
      },
    });
    const response = await send(
      `${baseUrl}/${scenario === "wrong-route" ? "other" : "chat/completions"}`,
      {
        method: "POST",
        body: JSON.stringify(body),
        headers:
          scenario === "already-child"
            ? { [retryParentHeader]: randomUUID() }
            : {},
      },
    );
    assert.equal(response, expected);
    await response.text();
    assert.equal(calls, 1);
    assert.equal(admissions, 0);
  });

for (const scenario of [
  "disconnect",
  "admission-exhausted",
  "cancel-before-delay",
  "cancel-during-delay",
  "cancel-after-admission",
  "cancel-reading-receipt",
])
  test(`recovery stops: ${scenario}`, async () => {
    const body = payload(),
      stop = new AbortController();
    let calls = 0,
      admissions = 0;
    const send = terminalHttpRecoveryFetch({
      baseUrl,
      attemptId,
      requestIdField: "runtime_call_id",
      admit: async () => {
        admissions++;
        if (scenario === "admission-exhausted")
          throw Error("Allocation exhausted");
        if (scenario === "cancel-after-admission") stop.abort();
      },
      fetch: async () => {
        calls++;
        if (scenario === "disconnect")
          throw Error("Connection lost without receipt");
        if (scenario === "cancel-before-delay") stop.abort();
        if (
          ["cancel-during-delay", "cancel-reading-receipt"].includes(scenario)
        )
          setTimeout(() => stop.abort(), 10);
        if (scenario === "cancel-reading-receipt")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{"));
              },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        return json(receipt(body.runtime_call_id));
      },
    });
    await assert.rejects(
      send(`${baseUrl}/chat/completions`, {
        method: "POST",
        body: JSON.stringify(body),
        signal: stop.signal,
      }),
    );
    assert.equal(calls, 1);
    assert.equal(
      admissions,
      ["admission-exhausted", "cancel-after-admission"].includes(scenario)
        ? 1
        : 0,
    );
  });

const outage = (fetch: typeof globalThis.fetch, windowMs = 2000) => {
  let admitted = 0;
  return {
    send: gatewayOutageFetch({
      baseUrl,
      requestIdField: "runtime_call_id",
      admit: async () => {
        admitted++;
      },
      fetch,
      windowMs,
      firstDelayMs: 1,
      maxDelayMs: 1,
    }),
    admitted: () => admitted,
  };
};
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json", "x-synthetic": "kept" },
  body: JSON.stringify(body),
});

test("a model request waits out a gateway restart with a new identity each time", async () => {
  const seen: any[] = [];
  const answers: (() => Response)[] = [
    () => {
      throw new TypeError("fetch failed");
    },
    () => new Response("bad gateway", { status: 502 }),
    () => new Response("{}", { status: 200 }),
  ];
  const original = payload();
  const { send, admitted } = outage(async (input) => {
    const request = input as Request;
    seen.push({
      body: await request.clone().json(),
      header: request.headers.get("x-synthetic"),
    });
    return answers[seen.length - 1]!();
  });
  const response = await send(`${baseUrl}/chat/completions`, post(original));
  assert.equal(response.status, 200);
  assert.equal(seen.length, 3);
  assert.equal(seen[0].body.runtime_call_id, original.runtime_call_id);
  assert.equal(
    new Set(seen.map((s) => s.body.runtime_call_id)).size,
    3,
    "a call the host may have started is never replayed under its identity",
  );
  for (const { body, header } of seen) {
    assert.deepEqual(
      { ...body, runtime_call_id: "" },
      { ...original, runtime_call_id: "" },
    );
    assert.equal(header, "kept");
  }
  assert.equal(admitted(), 2);
});

test("a host answer is returned at once and other requests pass through", async () => {
  for (const status of [200, 401, 409, 429, 500]) {
    let sends = 0;
    const { send } = outage(async () => {
      sends++;
      return new Response("{}", { status });
    });
    const response = await send(`${baseUrl}/chat/completions`, post(payload()));
    assert.equal(response.status, status);
    assert.equal(sends, 1);
  }
  let sends = 0;
  const { send } = outage(async () => {
    sends++;
    return new Response("x", { status: 502 });
  });
  await send(`${baseUrl}/models`);
  assert.equal(sends, 1);
});

test("an outage past the window fails, and a cancelled run stops waiting", async () => {
  const { send } = outage(async () => {
    throw new TypeError("fetch failed");
  }, 1);
  await assert.rejects(
    send(`${baseUrl}/chat/completions`, post(payload())),
    /fetch failed/,
  );
  const { send: gateway } = outage(
    async () => new Response("x", { status: 503 }),
    1,
  );
  assert.equal(
    (await gateway(`${baseUrl}/chat/completions`, post(payload()))).status,
    503,
  );
  const stop = new AbortController();
  let sends = 0;
  const { send: cancelled } = outage(async () => {
    sends++;
    stop.abort();
    throw new TypeError("fetch failed");
  });
  await assert.rejects(
    cancelled(`${baseUrl}/chat/completions`, {
      ...post(payload()),
      signal: stop.signal,
    }),
  );
  assert.equal(sends, 1);
});

test("the wait starts at the first failure, however long the call had run", async () => {
  let sends = 0;
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const { send } = outage(async () => {
      sends++;
      now += 200_000;
      if (sends === 1) throw new TypeError("fetch failed");
      now -= 200_000;
      if (sends < 4) throw new TypeError("fetch failed");
      return new Response("{}", { status: 200 });
    }, 1000);
    const response = await send(`${baseUrl}/chat/completions`, post(payload()));
    assert.equal(response.status, 200);
    assert.equal(sends, 4);
  } finally {
    Date.now = realNow;
  }
});

test("a resent call that ran for a long time gets its own wait", async () => {
  let sends = 0;
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const { send } = outage(async () => {
      sends++;
      if (sends === 2) now += 300_000;
      if (sends < 4) throw new TypeError("fetch failed");
      return new Response("{}", { status: 200 });
    }, 1000);
    assert.equal(
      (await send(`${baseUrl}/chat/completions`, post(payload()))).status,
      200,
    );
    assert.equal(sends, 4);
  } finally {
    Date.now = realNow;
  }
});
