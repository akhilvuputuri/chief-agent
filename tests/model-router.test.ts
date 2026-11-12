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
  FallbackAlerts,
  type FallbackNotice,
  DirectCooldown,
  FallbackAdapter,
  ModelRouter,
  StrippedOpenRouter,
  type ModelRouterOptions,
} from "../src/model-router.js";
import { AnthropicDirect } from "../src/anthropic.js";
import { readModelPolicy, type ModelPolicy } from "../src/model-policy.js";
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
const fault =
  (
    providerFault: string,
    retryAfterSeconds?: number,
    extra: Record<string, unknown> = {},
  ) =>
  () =>
    new ModelError("Model request failed (HTTP 401).", false, {
      httpStatus: 401,
      providerFault,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...extra,
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

test("the OpenRouter route wraps the plain adapter, and every adapter keeps the OpenRouter model ID", async () => {
  const real = new ModelRouter({
    provider: "openrouter",
    openRouterKey: "or-test",
    anthropicKey: "",
    ceilings: { input: 4, output: 20 },
    policy: policy(),
  });
  const flash = real.modelFor("google/gemini-3.8-flash");
  assert.ok(flash instanceof StrippedOpenRouter);
  assert.ok((flash as any).inner instanceof OpenRouter);
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
    "permission",
    "billing",
    "rate_limit",
    "unavailable",
    "not_found",
    "rejected",
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

test("other failures, refusals, aborts, fallback off and a missing OpenRouter key surface the direct error", async () => {
  const plain = () => new ModelError("Invalid model tool calls");
  // A refusal never falls back: it is the model's answer, not a provider fault.
  const refusal = () =>
    new ModelError("The model declined this request.", false, {
      route: "anthropic-direct",
      failureCode: "refusal",
      finishReason: "content_filter",
    });
  for (const [options, failure] of [
    [{}, plain],
    [{}, refusal],
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
  // An ordinary rejected request falls back that call only; beta enrollment fails every call.
  assert.equal(DirectCooldown.seconds("rejected"), 0);
  assert.equal(
    DirectCooldown.seconds("rejected", undefined, "invalid_request_error"),
    0,
  );
  assert.equal(
    DirectCooldown.seconds(
      "rejected",
      undefined,
      "organization_not_enrolled_in_beta",
    ),
    600,
  );
  assert.equal(DirectCooldown.seconds("permission"), 600);
  // A rate limit expires after its bounded hint.
  now = 0;
  const limited = new DirectCooldown(() => now);
  limited.remember(OPUS, "rate_limit", 10);
  assert.equal(limited.active(OPUS), "rate_limit");
  // Anthropic limits each model separately: Opus's limit leaves Haiku direct (journal 164).
  assert.equal(limited.active("anthropic/other"), undefined);
  now = 10_000;
  assert.equal(limited.active(OPUS), undefined);
  // An unknown model cools only that model; an outage never cools.
  limited.remember(OPUS, "not_found");
  limited.remember(OPUS, "unavailable");
  assert.equal(limited.active(OPUS), "not_found");
  assert.equal(limited.active("anthropic/other"), undefined);
  // A permission refusal (403) is per model too; a bad key (401) cools every model.
  now = 0;
  const scoped = new DirectCooldown(() => now);
  assert.equal(scoped.remember(OPUS, "permission"), 600);
  assert.equal(scoped.active(OPUS), "permission");
  assert.equal(scoped.active("anthropic/other"), undefined);
  now = 600_000;
  assert.equal(scoped.active(OPUS), undefined);
  scoped.remember(OPUS, "auth");
  assert.equal(scoped.active("anthropic/other"), "auth");
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

test("a rejected request falls back without a cooldown; beta enrollment cools every model, visibly", async () => {
  let now = 0;
  const cooldown = new DirectCooldown(() => now);
  const ops = captureOps();
  try {
    const rejected = router({
      cooldown,
      fail: fault("rejected", undefined, {
        httpStatus: 400,
        errorType: "invalid_request_error",
      }),
    });
    await rejected.r.modelFor(OPUS).generate(input());
    await rejected.r.modelFor(OPUS).generate(input());
    assert.deepEqual(
      rejected.calls.map((c) => c.route),
      ["direct", "openrouter", "direct", "openrouter"],
    );
    const line = ops.lines.find((l) => l.event === "model.provider_fallback")!;
    assert.equal(line.reason, "rejected");
    assert.equal(line.cooldownS, 0);
    assert.equal(line.httpStatus, 400);
    assert.equal(line.errorType, "invalid_request_error");
    assert.equal(line.dropped, undefined);
    ops.lines.length = 0;
    const enrolled = router({
      cooldown,
      fail: fault("rejected", undefined, {
        httpStatus: 400,
        errorType: "invalid_request_error",
        errorCode: "organization_not_enrolled_in_beta",
      }),
    });
    await enrolled.r.modelFor(OPUS).generate(input());
    const skipped = await enrolled.r.modelFor(OPUS).generate(input());
    assert.equal(skipped.usage?.fallback_cooldown, true);
    assert.equal(skipped.usage?.fallback_reason, "rejected");
    assert.equal(cooldown.active("anthropic/other"), "rejected");
    assert.deepEqual(
      enrolled.calls.map((c) => c.route),
      ["direct", "openrouter", "openrouter"],
    );
    const [warn] = ops.lines.filter(
      (l) => l.event === "model.provider_fallback",
    );
    assert.equal(warn!.cooldownS, 600);
    assert.equal(warn!.errorCode, "organization_not_enrolled_in_beta");
    assert.equal(warn!.dropped, undefined);
  } finally {
    ops.restore();
  }
});

test("every OpenRouter call strips direct reasoning, any vendor, and is unchanged without it", async () => {
  const native = {
    type: "anthropic.thinking",
    format: "anthropic-direct-v1",
    block: { type: "thinking", thinking: "x", signature: "s" },
  };
  const routed = { type: "reasoning.encrypted", data: "y" };
  const history: ModelMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "a", reasoning_details: [native, routed] },
    { role: "user", content: "again" },
  ];
  for (const slug of [
    "google/gemini-3.8-flash",
    "openai/gpt-6.1-sol",
    "deepseek/deepseek-v4",
  ]) {
    const { r, calls } = router();
    assert.equal(r.route(slug), "openrouter");
    await r.modelFor(slug).generate(input(history));
    assert.deepEqual(calls[0]!.messages[1], {
      role: "assistant",
      content: "a",
      reasoning_details: [routed],
    });
    assert.equal(calls[0]!.messages[0], history[0]);
  }
  // Nothing to strip: the same input, array and message objects reach the adapter.
  const seen: unknown[] = [];
  const inner: ModelAdapter = {
    model: "google/gemini-3.8-flash",
    async generate(i) {
      seen.push(i);
      return { message: { role: "assistant", content: "ok" } };
    },
  };
  const clean: ModelMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "a", reasoning_details: [routed] },
  ];
  const request = input(clean);
  await new StrippedOpenRouter(inner.model!, inner).generate(request);
  assert.equal(seen[0], request);
  assert.equal((seen[0] as typeof request).messages, clean);
});

test("with the bundled policy and a key, every Claude model Chief uses goes direct; the rest stay on OpenRouter", () => {
  const bundled = readModelPolicy();
  const { r } = router({ policy: bundled });
  for (const slug of [
    bundled.main!,
    bundled.judge!,
    ...Object.values(bundled.agents!.tiers),
    "anthropic/claude-opus-5.5",
    "anthropic/claude-sonnet-5.5",
    "anthropic/claude-haiku-5.5",
  ])
    assert.equal(r.route(slug), "anthropic-direct", slug);
  // Jev, embeddings and other vendors stay on OpenRouter (journal 164).
  for (const slug of [
    "typesafe/jev-1.13-20260917",
    "openai/text-embedding-3-small",
    "google/gemini-3.8-flash",
    "anthropic/claude-sonnet-5",
  ])
    assert.equal(r.route(slug), "openrouter", slug);
  // Each direct model builds a real adapter: the adapter accepts every mapped native model.
  for (const [slug, mapped] of Object.entries(
    bundled.providers!.anthropic!.models,
  ))
    assert.doesNotThrow(
      () =>
        new AnthropicDirect("k", {
          model: slug,
          nativeModel: mapped.id,
          prices: mapped,
        }),
      slug,
    );
});

test("every direct failure that falls back is reported, and a failing report never changes the call", async () => {
  let now = 0;
  const cooldown = new DirectCooldown(() => now);
  const notices: FallbackNotice[] = [];
  const ops = captureOps();
  try {
    const { r, calls } = router({
      cooldown,
      fail: fault("billing"),
      onFallback: (n) => notices.push(n),
    });
    const model = r.modelFor(OPUS);
    await model.generate(input());
    // In the cooldown the call goes straight to OpenRouter: no second notice.
    await model.generate(input());
    assert.deepEqual(
      calls.map((c) => c.route),
      ["direct", "openrouter", "openrouter"],
    );
    assert.deepEqual(notices, [
      { model: OPUS, reason: "billing", cooldownS: 600, httpStatus: 401 },
    ]);
    // A success reports nothing.
    const ok = router({ onFallback: (n) => notices.push(n) });
    await ok.r.modelFor(OPUS).generate(input());
    assert.equal(notices.length, 1);
    // A notifier that throws: the fallback answer still arrives.
    const throwing = router({
      cooldown: new DirectCooldown(() => now),
      fail: fault("unavailable"),
      onFallback: () => {
        throw new Error("telegram down");
      },
    });
    const result = await throwing.r.modelFor(OPUS).generate(input());
    assert.equal(result.usage?.fallback_from, "anthropic-direct");
  } finally {
    ops.restore();
  }
});

test("the owner is told about a fallback at most once an hour per fault, with what was held back", async () => {
  let now = 0;
  const sent: string[] = [];
  const alerts = new FallbackAlerts(() => now);
  alerts.send = async (text) => {
    sent.push(text);
  };
  const billing: FallbackNotice = {
    model: OPUS,
    reason: "billing",
    cooldownS: 600,
    httpStatus: 402,
  };
  alerts.notice(billing);
  alerts.notice(billing);
  alerts.notice({
    ...billing,
    reason: "unavailable",
    cooldownS: 0,
    httpStatus: 529,
  });
  now = 3_600_000 - 1;
  alerts.notice(billing);
  assert.equal(sent.length, 2);
  assert.match(
    sent[0]!,
    /a billing or credit limit was reached \(HTTP 402\), model anthropic\/claude-opus-5\.5/,
  );
  assert.match(sent[0]!, /retrying it through OpenRouter/);
  assert.match(
    sent[0]!,
    /For the next 10 min this model's calls go straight to OpenRouter/,
  );
  assert.match(sent[0]!, /"fallback": false in config\/model-policy\.json/);
  assert.match(sent[1]!, /Anthropic was unavailable \(HTTP 529\)/);
  assert.match(sent[1]!, /next call tries Claude directly again/);
  now = 3_600_000;
  alerts.notice(billing);
  assert.equal(sent.length, 3);
  assert.match(
    sent[2]!,
    /2 more direct attempts for this model failed the same way in the hour before/,
  );
  // Another model's rate limit is told even while this one's is held back.
  alerts.notice({ ...billing, reason: "rate_limit", httpStatus: 429 });
  alerts.notice({
    ...billing,
    reason: "rate_limit",
    httpStatus: 429,
    model: "anthropic/claude-haiku-5.5",
  });
  assert.equal(sent.length, 5);
  assert.match(sent[4]!, /model anthropic\/claude-haiku-5\.5/);
  // A failing send is swallowed.
  alerts.send = async () => {
    throw new Error("telegram down");
  };
  alerts.notice({ ...billing, reason: "auth" });
});

test("the summarized-thinking opt-in never changes an OpenRouter request, direct or fallback (journal 171)", async () => {
  const bodies: string[] = [];
  const openRouter = new OpenRouter("or-test", OPUS, 4, 20, (async (
    _url: unknown,
    init?: RequestInit,
  ) => {
    bodies.push(String(init?.body));
    return Response.json({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      provider: "test",
      usage: { cost: 0.01 },
    });
  }) as typeof fetch);
  await openRouter.generate(input());
  await openRouter.generate({ ...input(), thinkingDisplay: "summarized" });
  const fallback = new FallbackAdapter(
    OPUS,
    fake("direct", [], OPUS, fault("unavailable")),
    openRouter,
    new DirectCooldown(),
  );
  const ops = captureOps();
  try {
    await fallback.generate({ ...input(), thinkingDisplay: "summarized" });
  } finally {
    ops.restore();
  }
  assert.equal(bodies.length, 3);
  assert.equal(bodies[1], bodies[0]);
  assert.equal(bodies[2], bodies[0]);
  assert.ok(!bodies[0]!.includes("summarized"));
  assert.ok(!bodies[0]!.includes("display"));
});
