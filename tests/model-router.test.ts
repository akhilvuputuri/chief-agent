import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ModelError,
  OpenRouter,
  type Generation,
  type ModelAdapter,
  type ModelMessage,
} from "../src/model.js";
import {
  DirectCooldown,
  FallbackAdapter,
  ModelRouter,
  type ModelRouterOptions,
} from "../src/model-router.js";
import { AnthropicDirect } from "../src/anthropic.js";
import type { ModelPolicy } from "../src/model-policy.js";
import { setOpsSink } from "../src/ops-log.js";

const OPUS = "anthropic/claude-opus-5.5";
const policy = (fallback = true): ModelPolicy => ({
  schemaVersion: 1,
  main: OPUS,
  providers: {
    anthropic: {
      fallback,
      models: {
        [OPUS]: {
          id: "claude-opus-5-5",
          input: 4,
          output: 20,
          cacheRead: 0.2,
          cacheWrite: 5,
        },
      },
    },
  },
});

type Call = { route: string; messages: ModelMessage[] };
function fake(
  route: string,
  calls: Call[],
  model: string,
  fail?: () => unknown,
): ModelAdapter {
  return {
    model,
    async generate(input) {
      calls.push({ route, messages: input.messages });
      if (fail) throw fail();
      return {
        message: { role: "assistant", content: route },
        provider: route,
        model,
        usage: {
          cost: 0.01,
          ...(route === "direct" ? { route: "anthropic-direct" } : {}),
        },
      } satisfies Generation;
    },
  };
}

function router(
  options: Partial<ModelRouterOptions> & { fail?: () => unknown } = {},
) {
  const calls: Call[] = [];
  const { fail, ...rest } = options;
  const r = new ModelRouter({
    provider: "anthropic",
    openRouterKey: "or-test",
    anthropicKey: "an-test",
    ceilings: { input: 4, output: 20 },
    policy: policy(),
    cooldown: new DirectCooldown(),
    openRouter: (model) => fake("openrouter", calls, model),
    anthropic: (model) => fake("direct", calls, model, fail),
    ...rest,
  });
  return { r, calls };
}

const input = (
  messages: ModelMessage[] = [{ role: "user", content: "hi" }],
) => ({
  messages,
  tools: [],
  reasoning: "medium" as const,
  signal: new AbortController().signal,
});
const fault = (providerFault: string, retryAfterSeconds?: number) => () =>
  new ModelError("Model request failed (HTTP 401).", false, {
    httpStatus: 401,
    providerFault,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });

function captureOps() {
  const lines: Record<string, unknown>[] = [];
  const previous = setOpsSink((line) => lines.push(JSON.parse(line)));
  return { lines, restore: () => setOpsSink(previous) };
}

test("direct only with the anthropic setting, a key, a mapped model and a price within the ceilings", () => {
  const cases: [Partial<ModelRouterOptions>, string, string][] = [
    [{}, OPUS, "anthropic-direct"],
    [{ provider: "openrouter" }, OPUS, "openrouter"],
    [{ anthropicKey: "" }, OPUS, "openrouter"],
    [{}, "anthropic/claude-sonnet-5.5", "openrouter"],
    [{}, "google/gemini-3.8-flash", "openrouter"],
    [{ ceilings: { input: 3, output: 20 } }, OPUS, "openrouter"],
    [{ ceilings: { input: 4, output: 19 } }, OPUS, "openrouter"],
    [{ policy: { schemaVersion: 1, main: OPUS } }, OPUS, "openrouter"],
  ];
  for (const [options, model, expected] of cases)
    assert.equal(
      router(options).r.route(model),
      expected,
      JSON.stringify(options),
    );
});

test("the OpenRouter route is the plain adapter, and every adapter keeps the OpenRouter model ID", async () => {
  const real = new ModelRouter({
    provider: "openrouter",
    openRouterKey: "or-test",
    anthropicKey: "",
    ceilings: { input: 4, output: 20 },
    policy: policy(),
  });
  const flash = real.modelFor("google/gemini-3.8-flash");
  assert.ok(flash instanceof OpenRouter);
  assert.equal(flash.model, "google/gemini-3.8-flash");
  assert.equal(real.modelFor(OPUS).model, OPUS);
  const direct = new ModelRouter({
    provider: "anthropic",
    openRouterKey: "or-test",
    anthropicKey: "an-test",
    ceilings: { input: 4, output: 20 },
    policy: policy(false),
  }).modelFor(OPUS);
  assert.ok(direct instanceof AnthropicDirect);
  assert.equal(direct.model, OPUS);
  const { r, calls } = router();
  const adapter = r.modelFor(OPUS);
  assert.ok(adapter instanceof FallbackAdapter);
  assert.equal(adapter.model, OPUS);
  assert.equal((await adapter.generate(input())).message.content, "direct");
  assert.deepEqual(
    calls.map((c) => c.route),
    ["direct"],
  );
});

test("each provider fault falls back once on OpenRouter, marked and logged structurally", async () => {
  for (const kind of [
    "auth",
    "billing",
    "rate_limit",
    "unavailable",
    "not_found",
  ]) {
    const ops = captureOps();
    try {
      const { r, calls } = router({ fail: fault(kind) });
      const result = await r.modelFor(OPUS).generate(input());
      assert.deepEqual(
        calls.map((c) => c.route),
        ["direct", "openrouter"],
        kind,
      );
      assert.equal(result.message.content, "openrouter");
      assert.equal(result.usage?.fallback_from, "anthropic-direct");
      assert.equal(result.usage?.fallback_reason, kind);
      assert.equal(result.usage?.cost, 0.01);
      const line = ops.lines.find(
        (l) => l.event === "model.provider_fallback",
      )!;
      assert.equal(line.model, OPUS);
      assert.equal(line.reason, kind);
      assert.equal(line.dropped, undefined);
      assert.ok(!JSON.stringify(ops.lines).includes("an-test"));
    } finally {
      ops.restore();
    }
  }
});

test("other failures, aborts, fallback off and a missing OpenRouter key surface the direct error", async () => {
  const plain = () => new ModelError("Invalid model tool calls");
  for (const [options, failure] of [
    [{}, plain],
    [{ policy: policy(false) }, fault("auth")],
    [{ openRouterKey: "" }, fault("auth")],
  ] as [Partial<ModelRouterOptions>, () => unknown][]) {
    const { r, calls } = router({ ...options, fail: failure });
    await assert.rejects(r.modelFor(OPUS).generate(input()), ModelError);
    assert.deepEqual(
      calls.map((c) => c.route),
      ["direct"],
    );
  }
  const aborted = new AbortController();
  const { r, calls } = router({
    fail: () => (aborted.abort(), fault("unavailable")()),
  });
  await assert.rejects(
    r.modelFor(OPUS).generate({ ...input(), signal: aborted.signal }),
    ModelError,
  );
  assert.deepEqual(
    calls.map((c) => c.route),
    ["direct"],
  );
});

test("cooldowns skip the direct pathway for a bounded time; an outage falls back one call at a time", async () => {
  let now = 0;
  const cooldown = new DirectCooldown(() => now);
  const ops = captureOps();
  try {
    const { r, calls } = router({ cooldown, fail: fault("billing") });
    const adapter = r.modelFor(OPUS);
    await adapter.generate(input());
    const skipped = await adapter.generate(input());
    assert.equal(skipped.usage?.fallback_cooldown, true);
    assert.equal(skipped.usage?.fallback_reason, "billing");
    // A new adapter shares the same cooldown.
    await r.modelFor(OPUS).generate(input());
    assert.deepEqual(
      calls.map((c) => c.route),
      ["direct", "openrouter", "openrouter", "openrouter"],
    );
    assert.equal(
      ops.lines.find((l) => l.event === "model.provider_fallback")?.cooldownS,
      600,
    );
    now = 600_000;
    calls.length = 0;
    await adapter.generate(input());
    assert.deepEqual(
      calls.map((c) => c.route),
      ["direct", "openrouter"],
    );
  } finally {
    ops.restore();
  }
  assert.equal(DirectCooldown.seconds("rate_limit"), 30);
  assert.equal(DirectCooldown.seconds("rate_limit", 1), 5);
  assert.equal(DirectCooldown.seconds("rate_limit", 45), 45);
  assert.equal(DirectCooldown.seconds("rate_limit", 3600), 120);
  assert.equal(DirectCooldown.seconds("unavailable"), 0);
  assert.equal(DirectCooldown.seconds("auth"), 600);
  // A rate limit expires after its bounded hint.
  now = 0;
  const limited = new DirectCooldown(() => now);
  limited.remember(OPUS, "rate_limit", 10);
  assert.equal(limited.active(OPUS), "rate_limit");
  assert.equal(limited.active("anthropic/other"), "rate_limit");
  now = 10_000;
  assert.equal(limited.active(OPUS), undefined);
  // An unknown model cools only that model; an outage never cools.
  limited.remember(OPUS, "not_found");
  limited.remember(OPUS, "unavailable");
  assert.equal(limited.active(OPUS), "not_found");
  assert.equal(limited.active("anthropic/other"), undefined);
  // Without OpenRouter to fall back to, a cooldown does not stop the direct call.
  const { r, calls } = router({ cooldown: limited, openRouterKey: "" });
  await r.modelFor(OPUS).generate(input());
  assert.deepEqual(
    calls.map((c) => c.route),
    ["direct"],
  );
});

test("direct-produced reasoning never reaches OpenRouter; OpenRouter's own reasoning is kept", async () => {
  const native = {
    type: "anthropic.thinking",
    format: "anthropic-direct-v1",
    block: { type: "thinking", thinking: "x", signature: "s" },
  };
  const routed = { type: "reasoning.encrypted", data: "y" };
  const messages: ModelMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "a", reasoning_details: [native, routed] },
    { role: "assistant", content: "b", reasoning_details: [native] },
    { role: "user", content: "again" },
  ];
  const sent = (calls: Call[], route: string) =>
    calls.find((c) => c.route === route)!.messages;
  const expected: ModelMessage[] = [
    messages[0]!,
    { role: "assistant", content: "a", reasoning_details: [routed] },
    { role: "assistant", content: "b" },
    messages[3]!,
  ];
  // The fallback path.
  const fallback = router({ fail: fault("unavailable") });
  await fallback.r.modelFor(OPUS).generate(input(messages));
  assert.deepEqual(sent(fallback.calls, "direct"), messages);
  assert.deepEqual(sent(fallback.calls, "openrouter"), expected);
  // The setting flipped back to openrouter mid-conversation.
  const flipped = router({ provider: "openrouter" });
  await flipped.r.modelFor(OPUS).generate(input(messages));
  assert.deepEqual(sent(flipped.calls, "openrouter"), expected);
  // Nothing to strip: the same message objects go through.
  const clean = router({ provider: "openrouter" });
  const plainMessages: ModelMessage[] = [
    { role: "assistant", content: "a", reasoning_details: [routed] },
  ];
  await clean.r.modelFor(OPUS).generate(input(plainMessages));
  assert.equal(sent(clean.calls, "openrouter")[0], plainMessages[0]);
});
