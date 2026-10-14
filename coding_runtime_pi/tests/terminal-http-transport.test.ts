import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
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
