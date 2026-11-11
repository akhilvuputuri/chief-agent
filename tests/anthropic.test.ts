import test from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicDirect,
  isAnthropicDirectReasoning,
  stripAnthropicDirectReasoning,
} from "../src/anthropic.js";
import { ModelError, type ModelMessage } from "../src/model.js";
import { spending, type Spending } from "../src/spending.js";

const prices = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const encoder = new TextEncoder();
type Block = Record<string, any>;

function sse(events: Block[], { close = true } = {}) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const e of events)
          controller.enqueue(
            encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`),
          );
        if (close) controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** A complete Messages stream for the given final content blocks. */
function stream(
  content: Block[],
  {
    stop = "end_turn",
    model = "claude-opus-5-5",
    usage = {},
    final = {},
    transformations = [] as Block[],
    stopDetails = null as Block | null,
  } = {},
) {
  const events: Block[] = [
    {
      type: "message_start",
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
          output_tokens: 1,
          ...usage,
        },
        input_transformations: transformations,
      },
    },
  ];
  content.forEach((block, index) => {
    const start =
      block.type === "text"
        ? { type: "text", text: "" }
        : block.type === "thinking"
          ? { type: "thinking", thinking: "", signature: "" }
          : block.type === "tool_use"
            ? { ...block, input: {} }
            : block;
    events.push({ type: "content_block_start", index, content_block: start });
    if (block.type === "text")
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      });
    if (block.type === "thinking") {
      if (block.thinking)
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: block.thinking },
        });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: block.signature },
      });
    }
    if (block.type === "tool_use")
      events.push({
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input),
        },
      });
    events.push({ type: "content_block_stop", index });
  });
  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: stop,
        stop_sequence: null,
        stop_details: stopDetails,
      },
      usage: { output_tokens: 50, ...final },
    },
    { type: "message_stop" },
  );
  return events;
}

function adapter(
  respond: (call: number) => Response | Promise<Response>,
  options: { workspaceId?: string } = {},
) {
  const requests: { url: string; headers: Headers; body: any }[] = [];
  const model = new AnthropicDirect("test-key", {
    model: "anthropic/claude-opus-5.5",
    nativeModel: "claude-opus-5-5",
    prices,
    ...options,
    transport: (async (url: unknown, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return respond(requests.length);
    }) as typeof fetch,
  });
  return { model, requests };
}
const run = (
  model: AnthropicDirect,
  messages: ModelMessage[],
  extra: Partial<Parameters<AnthropicDirect["generate"]>[0]> = {},
) =>
  model.generate({
    messages,
    tools: [],
    reasoning: "medium",
    signal: new AbortController().signal,
    ...extra,
  });
const reply = [{ type: "text", text: "Done." }];

function marked(body: any) {
  const blocks = [
    ...(body.system ?? []),
    ...body.messages.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content : [],
    ),
  ];
  return blocks.filter((b: any) => b.cache_control);
}

test("Chief requests translate to the Messages API with thinking, effort, betas and cache marks", async () => {
  const { model, requests } = adapter(() => sse(stream(reply)));
  const messages: ModelMessage[] = [
    { role: "system", content: "Stable instructions" },
    { role: "system", content: "Turn summary" },
    {
      role: "user",
      content: [
        { type: "text", text: "Look", cache_control: { type: "ephemeral" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "image_url", image_url: { url: "https://example.com/a.jpg" } },
      ],
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "a", arguments: '{"x":1}' },
        },
        {
          id: "c2",
          type: "function",
          function: { name: "b", arguments: "{bad" },
        },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "one" },
    { role: "tool", tool_call_id: "c2", content: "two" },
    { role: "system", content: "Current state: 10:00" },
  ];
  await run(model, messages, {
    reasoning: "high",
    cacheKey: "private-key",
    sessionId: "private-session",
    tools: [
      {
        name: "a",
        description: "A",
        parameters: { type: "object", properties: {} },
      },
    ],
  });
  const [{ url, headers, body }] = requests;
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(headers.get("authorization"), "Bearer test-key");
  assert.deepEqual(headers.get("anthropic-beta")?.split(","), [
    "thinking-binding-controls-2026-08-01",
  ]);
  // No workspace configured: no workspace header.
  assert.equal(headers.get("anthropic-workspace-id"), null);
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.max_tokens, 8000);
  assert.equal(body.stream, true);
  assert.deepEqual(body.thinking, {
    type: "adaptive",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  });
  assert.deepEqual(body.output_config, { effort: "high" });
  // Server-side refusal fallbacks are never requested (they could serve above the ceilings).
  assert.equal(body.fallbacks, undefined);
  assert.deepEqual(body.cache_control, { type: "ephemeral" });
  for (const absent of ["temperature", "top_p", "tool_choice", "metadata"])
    assert.equal(body[absent], undefined);
  assert.ok(!JSON.stringify(body).includes("private-"));
  assert.deepEqual(body.tools, [
    {
      name: "a",
      description: "A",
      input_schema: { type: "object", properties: {} },
    },
  ]);
  // The first, stable system message is marked; the per-turn summary is not.
  assert.deepEqual(body.system, [
    {
      type: "text",
      text: "Stable instructions",
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: "Turn summary" },
  ]);
  assert.deepEqual(body.messages, [
    {
      role: "user",
      content: [
        // The input's wire-only marker is not copied; the owner's message gets its own.
        { type: "text", text: "Look" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AAAA" },
        },
        {
          type: "image",
          source: { type: "url", url: "https://example.com/a.jpg" },
          cache_control: { type: "ephemeral" },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "c1", name: "a", input: { x: 1 } },
        { type: "tool_use", id: "c2", name: "b", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: "one" },
        {
          type: "tool_result",
          tool_use_id: "c2",
          content: "two",
          cache_control: { type: "ephemeral" },
        },
      ],
    },
    // The state message stays a mid-conversation system message, unmarked.
    {
      role: "system",
      content: [{ type: "text", text: "Current state: 10:00" }],
    },
  ]);
  assert.equal(marked(body).length + 1, 4);
  // The caller's messages are not modified.
  assert.deepEqual((messages[2]!.content as any)[0].cache_control, {
    type: "ephemeral",
  });
});

test("misplaced system messages become reminders and a history must open with a user turn", async () => {
  const { model, requests } = adapter(() => sse(stream(reply)));
  await run(model, [
    { role: "system", content: "Stable" },
    { role: "assistant", content: "Earlier answer" },
    { role: "system", content: "Mid note" },
    { role: "user", content: "Question" },
    { role: "assistant", content: "Answer" },
    { role: "user", content: "Follow-up" },
    { role: "system", content: "Note A" },
    { role: "system", content: "State" },
  ]);
  const { messages } = requests[0]!.body;
  assert.equal(messages[0].role, "user");
  assert.deepEqual(messages[1], {
    role: "assistant",
    content: [{ type: "text", text: "Earlier answer" }],
  });
  // After an assistant turn: folded into the next user turn.
  assert.deepEqual(messages[2].content[0], {
    type: "text",
    text: "<system-reminder>\nMid note\n</system-reminder>",
  });
  assert.equal(messages[2].content[1].text, "Question");
  // Followed by another system message: folded; the last one remains a system message.
  assert.deepEqual(
    messages[4].content.map((b: any) => b.text),
    ["Follow-up", "<system-reminder>\nNote A\n</system-reminder>"],
  );
  assert.equal(messages[5].role, "system");
  assert.equal(messages.at(-1).content[0].cache_control, undefined);
  assert.ok(marked(requests[0]!.body).length <= 3);
});

test("text, usage, cost and thinking normalize to OpenRouter's shape and replay only direct reasoning", async () => {
  const thinking = { type: "thinking", thinking: "", signature: "sig-1" };
  const redacted = { type: "redacted_thinking", data: "opaque" };
  const { model, requests } = adapter((call) =>
    sse(
      call === 1
        ? stream(
            [
              thinking,
              redacted,
              { type: "text", text: "Hello " },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "search",
                input: { q: "x" },
              },
            ],
            {
              stop: "tool_use",
              final: { output_tokens_details: { thinking_tokens: 30 } },
              transformations: [
                {
                  type: "thinking_dropped",
                  path: "messages.1.content.0",
                  reason: "prefix_binding_mismatch",
                },
                {
                  type: "thinking_dropped",
                  path: "messages.1.content.1",
                  reason: "prefix_binding_mismatch",
                },
              ],
            },
          )
        : stream(reply),
    ),
  );
  const first = await run(model, [{ role: "user", content: "Hi" }]);
  assert.equal(first.provider, "Anthropic");
  assert.equal(first.model, "anthropic/claude-opus-5.5");
  assert.equal(first.finishReason, "tool_calls");
  assert.equal(first.message.content, "Hello ");
  assert.deepEqual(first.message.tool_calls, [
    {
      id: "toolu_1",
      type: "function",
      function: { name: "search", arguments: '{"q":"x"}' },
    },
  ]);
  assert.deepEqual(first.message.reasoning_details, [
    {
      type: "anthropic.thinking",
      format: "anthropic-direct-v1",
      block: thinking,
    },
    {
      type: "anthropic.thinking",
      format: "anthropic-direct-v1",
      block: redacted,
    },
  ]);
  assert.deepEqual(first.usage, {
    prompt_tokens: 1300,
    completion_tokens: 50,
    total_tokens: 1350,
    prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 200 },
    completion_tokens_details: { reasoning_tokens: 30 },
    cost: (100 * 4 + 1000 * 0.2 + 200 * 5 + 50 * 20) / 1e6,
    route: "anthropic-direct",
    thinking_dropped: 2,
  });
  await run(model, [
    { role: "user", content: "Hi" },
    {
      ...first.message,
      reasoning_details: [
        { type: "reasoning.encrypted", data: "openrouter-bound" },
        ...first.message.reasoning_details!,
        { type: "reasoning.text", text: "foreign" },
      ],
    },
    { role: "tool", tool_call_id: "toolu_1", content: "result" },
  ]);
  const assistant = requests[1]!.body.messages[1];
  assert.deepEqual(assistant.content, [
    thinking,
    redacted,
    { type: "text", text: "Hello " },
    { type: "tool_use", id: "toolu_1", name: "search", input: { q: "x" } },
  ]);
});

test("finish reasons map to OpenRouter values and requireComplete rejects truncated output", async () => {
  for (const [stop, finish] of [
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["model_context_window_exceeded", "length"],
  ]) {
    const { model } = adapter(() => sse(stream(reply, { stop })));
    assert.equal(
      (await run(model, [{ role: "user", content: "x" }])).finishReason,
      finish,
    );
  }
  const { model } = adapter(() => sse(stream(reply, { stop: "max_tokens" })));
  await assert.rejects(
    run(model, [{ role: "user", content: "x" }], {
      requireComplete: true,
      maxOutputTokens: 64000,
    }),
    (error: ModelError) =>
      !error.transient &&
      error.diagnostics.failureCode === "incomplete" &&
      error.diagnostics.finishReason === "length" &&
      error.diagnostics.providerFault === undefined &&
      error.diagnostics.route === "anthropic-direct" &&
      error.diagnostics.provider === "Anthropic",
  );
  const empty = adapter(() =>
    sse(
      stream([{ type: "thinking", thinking: "", signature: "s" }], {
        stop: "max_tokens",
      }),
    ),
  );
  await assert.rejects(
    run(empty.model, [{ role: "user", content: "x" }]),
    (error: ModelError) =>
      !error.transient && error.diagnostics.failureCode === "empty",
  );
  await assert.rejects(
    run(empty.model, [{ role: "user", content: "x" }], {
      maxOutputTokens: 128001,
    }),
    /Invalid model output allowance/,
  );
});

test("a refusal is a non-transient content_filter failure and partial output is discarded", async () => {
  const { model } = adapter(() =>
    sse(
      stream([{ type: "text", text: "Partial" }], {
        stop: "refusal",
        stopDetails: {
          type: "refusal",
          category: "cyber",
          explanation: "private",
        },
      }),
    ),
  );
  await assert.rejects(
    run(model, [{ role: "user", content: "x" }]),
    (error: ModelError) => {
      assert.equal(error.transient, false);
      assert.equal(error.diagnostics.failureCode, "refusal");
      assert.equal(error.diagnostics.finishReason, "content_filter");
      assert.equal(error.diagnostics.refusalCategory, "cyber");
      assert.equal(error.diagnostics.route, "anthropic-direct");
      assert.ok(!JSON.stringify(error.diagnostics).includes("private"));
      assert.ok(!error.message.includes("Partial"));
      return true;
    },
  );
});

test("stored fallback blocks from earlier data are ignored, never replayed", async () => {
  const thinking = { type: "thinking", thinking: "", signature: "sig-1" };
  const entry = (block: Block) => ({
    type: "anthropic.thinking",
    format: "anthropic-direct-v1",
    block,
  });
  const { model, requests } = adapter(() => sse(stream(reply)));
  await run(model, [
    { role: "user", content: "x" },
    {
      role: "assistant",
      content: "Earlier",
      reasoning_details: [
        entry({
          type: "fallback",
          from: { model: "claude-opus-5-5" },
          to: { model: "claude-opus-5" },
        }),
        entry(thinking),
      ],
    },
    { role: "user", content: "y" },
  ]);
  assert.deepEqual(requests[0]!.body.messages[1].content, [
    thinking,
    { type: "text", text: "Earlier" },
  ]);
  // And they are stripped before OpenRouter like any direct entry.
  const [stripped] = stripAnthropicDirectReasoning([
    {
      role: "assistant" as const,
      content: "a",
      reasoning_details: [entry({ type: "fallback" })],
    },
  ]);
  assert.ok(!("reasoning_details" in stripped!));
});

test("Chief's two leading system messages: only the stable first one is marked, across turns", async () => {
  const { model, requests } = adapter(() => sse(stream(reply)));
  // The shape src/context.ts assembles: instructions and memories, the per-turn summary,
  // history, the owner's message, then the per-call state message.
  const turn = (summary: string, state: string): ModelMessage[] => [
    { role: "system", content: "Instructions\nExplicit memories: []" },
    { role: "system", content: summary },
    { role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer" },
    { role: "user", content: "Current question" },
    { role: "system", content: state },
  ];
  await run(model, turn("Summary of turn 1", "State 1"));
  await run(model, turn("Summary of turn 2", "State 2"));
  const [first, second] = requests.map((r) => r.body);
  for (const body of [first, second]) {
    assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
    assert.equal(body.system[1].cache_control, undefined);
    assert.equal(body.messages.at(-1).role, "system");
    assert.equal(body.messages.at(-1).content[0].cache_control, undefined);
    // Top-level plus at most three block marks: Anthropic allows four breakpoints.
    assert.ok(marked(body).length + 1 <= 4);
  }
  // The marked prefix is byte-identical across turns although the summary changed.
  assert.deepEqual(first.system[0], second.system[0]);
  assert.notDeepEqual(first.system[1], second.system[1]);
});

test("empty and whitespace-only tool results are sent without content", async () => {
  const { model, requests } = adapter(() => sse(stream(reply)));
  await run(model, [
    { role: "user", content: "x" },
    {
      role: "assistant",
      content: null,
      tool_calls: ["a", "b", "c"].map((id) => ({
        id,
        type: "function" as const,
        function: { name: "t", arguments: "{}" },
      })),
    },
    { role: "tool", tool_call_id: "a", content: "" },
    { role: "tool", tool_call_id: "b", content: "  \n" },
    { role: "tool", tool_call_id: "c", content: [{ type: "text", text: " " }] },
  ]);
  const results = requests[0]!.body.messages[2].content;
  assert.deepEqual(
    results.map((b: Block) => [b.tool_use_id, "content" in b]),
    [
      ["a", false],
      ["b", false],
      ["c", false],
    ],
  );
});

test("a workspace ID is sent as the anthropic-workspace-id header and must be well formed", async () => {
  const { model, requests } = adapter(() => sse(stream(reply)), {
    workspaceId: "wrkspc_01AbC",
  });
  await run(model, [{ role: "user", content: "x" }]);
  assert.equal(
    requests[0]!.headers.get("anthropic-workspace-id"),
    "wrkspc_01AbC",
  );
  assert.equal(requests[0]!.headers.get("authorization"), "Bearer test-key");
  for (const workspaceId of [
    "wrkspc_",
    "workspace_1",
    "wrkspc_a b",
    "wrkspc_a\n",
  ])
    assert.throws(
      () =>
        new AnthropicDirect("k", {
          model: "anthropic/claude-opus-5.5",
          nativeModel: "claude-opus-5-5",
          prices,
          workspaceId,
        }),
      /Invalid Anthropic workspace ID/,
    );
});

test("complete-response calls bound the stream's wire size", async () => {
  const big = [{ type: "text", text: "x".repeat(2_000_000) }];
  const { model } = adapter(() => sse(stream(big)));
  await assert.rejects(
    run(model, [{ role: "user", content: "x" }], {
      requireComplete: true,
      maxOutputTokens: 1000,
    }),
    (e: ModelError) =>
      !e.transient &&
      e.diagnostics.failureCode === "malformed" &&
      e.diagnostics.providerFault === undefined &&
      e.diagnostics.route === "anthropic-direct",
  );
  // Ordinary calls are not bounded, and the allowance grows with the output allowance.
  assert.equal(
    (await run(model, [{ role: "user", content: "x" }])).finishReason,
    "stop",
  );
  assert.equal(
    (
      await run(model, [{ role: "user", content: "x" }], {
        requireComplete: true,
        maxOutputTokens: 4000,
      })
    ).finishReason,
    "stop",
  );
});

test("provider faults are classified only before any output", async () => {
  const error = (
    status: number,
    type: string,
    headers: Record<string, string> = {},
  ) =>
    Response.json(
      { type: "error", error: { type, message: "raw provider text" } },
      { status, headers },
    );
  const cases: [Response, string | undefined, boolean, number?][] = [
    [error(401, "authentication_error"), "auth", false],
    [error(403, "permission_error"), "permission", false],
    [error(402, "billing_error"), "billing", false],
    [
      error(429, "rate_limit_error", { "retry-after": "7" }),
      "rate_limit",
      true,
      7,
    ],
    [error(529, "overloaded_error"), "unavailable", true],
    [error(500, "api_error"), "unavailable", true],
    [error(404, "not_found_error"), "not_found", false],
    [error(400, "invalid_request_error"), "rejected", false],
    [error(413, "request_too_large"), undefined, false],
  ];
  for (const [response, fault, transient, retry] of cases) {
    const { model } = adapter(() => response);
    await assert.rejects(
      run(model, [{ role: "user", content: "x" }]),
      (e: ModelError) => {
        assert.ok(e instanceof ModelError);
        assert.equal(e.diagnostics.providerFault, fault);
        assert.equal(e.transient, transient);
        assert.equal(e.diagnostics.httpStatus, response.status);
        assert.equal(e.diagnostics.retryAfterSeconds, retry);
        // Failed log lines and spans attribute the failure to this pathway.
        assert.equal(e.diagnostics.route, "anthropic-direct");
        assert.equal(e.diagnostics.provider, "Anthropic");
        assert.ok(!JSON.stringify(e.diagnostics).includes("raw provider"));
        assert.ok(!e.message.includes("raw provider"));
        return true;
      },
    );
  }
  const offline = new AnthropicDirect("k", {
    model: "anthropic/claude-opus-5.5",
    nativeModel: "claude-opus-5-5",
    prices,
    transport: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  await assert.rejects(
    run(offline, [{ role: "user", content: "x" }]),
    (e: ModelError) =>
      e.transient &&
      e.diagnostics.failureCode === "transport" &&
      e.diagnostics.providerFault === "unavailable" &&
      e.diagnostics.route === "anthropic-direct" &&
      e.diagnostics.provider === "Anthropic",
  );
  const overloaded = {
    type: "error",
    error: { type: "overloaded_error", message: "raw" },
  };
  const events = stream(reply);
  const early = adapter(() => sse([events[0]!, overloaded]));
  await assert.rejects(
    run(early.model, [{ role: "user", content: "x" }]),
    (e: ModelError) =>
      e.transient &&
      e.diagnostics.failureCode === "provider" &&
      e.diagnostics.providerFault === "unavailable" &&
      e.diagnostics.route === "anthropic-direct",
  );
  const late = adapter(() => sse([...events.slice(0, 3), overloaded]));
  await assert.rejects(
    run(late.model, [{ role: "user", content: "x" }]),
    (e: ModelError) => e.transient && e.diagnostics.providerFault === undefined,
  );
  // A stream cut off before message_stop is a disconnect, never a partial success.
  const cut = adapter(() => sse(events.slice(0, -2)));
  await assert.rejects(
    run(cut.model, [{ role: "user", content: "x" }]),
    (e: ModelError) =>
      e.transient &&
      e.diagnostics.failureCode === "transport" &&
      e.diagnostics.providerFault === undefined &&
      e.diagnostics.route === "anthropic-direct",
  );
});

test("a 400 is rejected; beta enrollment carries its stable code, and only enum values are kept", async () => {
  const body = (error: Block, status = 400) =>
    Response.json({ type: "error", error }, { status });
  const enrolled = adapter(() =>
    body({
      type: "invalid_request_error",
      message: "raw provider text",
      details: { error_code: "organization_not_enrolled_in_beta" },
    }),
  );
  await assert.rejects(
    run(enrolled.model, [{ role: "user", content: "x" }]),
    (e: ModelError) => {
      assert.equal(e.diagnostics.providerFault, "rejected");
      assert.equal(e.diagnostics.errorType, "invalid_request_error");
      assert.equal(
        e.diagnostics.errorCode,
        "organization_not_enrolled_in_beta",
      );
      assert.equal(e.transient, false);
      assert.ok(!JSON.stringify(e.diagnostics).includes("raw provider"));
      return true;
    },
  );
  // An unknown type or a code that is not a plain identifier is not copied.
  const odd = adapter(() =>
    body(
      {
        type: "Some free text",
        message: "raw provider text",
        details: { error_code: "Not An Identifier!" },
      },
      400,
    ),
  );
  await assert.rejects(
    run(odd.model, [{ role: "user", content: "x" }]),
    (e: ModelError) =>
      e.diagnostics.providerFault === "rejected" &&
      e.diagnostics.errorType === undefined &&
      e.diagnostics.errorCode === undefined,
  );
});

test("streaming reports progress and abort rethrows the signal's reason", async () => {
  const progress: any[] = [];
  const { model } = adapter(() => sse(stream(reply)));
  await run(model, [{ role: "user", content: "x" }], {
    stream: true,
    onProgress: (value) => {
      progress.push(value);
    },
  });
  assert.ok(progress.length >= 2);
  assert.ok(
    progress.every(
      (p) =>
        p.responseId === "msg_fixture" &&
        p.provider === "Anthropic" &&
        p.bytes > 0,
    ),
  );
  const quiet: any[] = [];
  await run(model, [{ role: "user", content: "x" }], {
    onProgress: (v) => void quiet.push(v),
  });
  assert.equal(quiet.length, 0);

  const controller = new AbortController();
  const reason = new Error("cancelled");
  const hanging = adapter(() =>
    sse(stream(reply).slice(0, 3), { close: false }),
  );
  await assert.rejects(
    run(hanging.model, [{ role: "user", content: "x" }], {
      signal: controller.signal,
      stream: true,
      onProgress: () => controller.abort(reason),
    }),
    (error) => error === reason,
  );
});

test("the spending ledger records an estimate and settles the computed cost", async () => {
  const calls: any[] = [];
  const ledger = {
    begin: async (provider: string, estimate: number) => (
      calls.push({ provider, estimate }),
      "charge-1"
    ),
    settle: async (id: string, usage: any) => void calls.push({ id, usage }),
  } as unknown as Spending;
  const { model } = adapter(() => sse(stream(reply)));
  const result = await spending.run(ledger, () =>
    run(model, [{ role: "user", content: "x" }]),
  );
  assert.equal(calls[0].provider, "anthropic-main");
  assert.ok(calls[0].estimate > (8000 * 20) / 1e6);
  assert.deepEqual(calls[1], { id: "charge-1", usage: result.usage });
});

test("strip helper removes only direct reasoning and the constructor refuses unknown models", () => {
  const direct = {
    type: "anthropic.thinking",
    format: "anthropic-direct-v1",
    block: { type: "thinking", thinking: "", signature: "s" },
  };
  const foreign = { type: "reasoning.text", text: "t" };
  assert.ok(isAnthropicDirectReasoning(direct));
  assert.ok(!isAnthropicDirectReasoning(foreign));
  assert.ok(!isAnthropicDirectReasoning({ ...direct, format: "other" }));
  const untouched = { role: "user" as const, content: "x" };
  const stripped = stripAnthropicDirectReasoning([
    untouched,
    {
      role: "assistant" as const,
      content: "a",
      reasoning_details: [direct, foreign],
    },
    { role: "assistant" as const, content: "b", reasoning_details: [direct] },
  ]);
  assert.equal(stripped[0], untouched);
  // Nothing to strip: the very same array.
  const clean = [
    untouched,
    { role: "assistant" as const, content: "a", reasoning_details: [foreign] },
  ];
  assert.equal(stripAnthropicDirectReasoning(clean), clean);
  assert.deepEqual(stripped[1]!.reasoning_details, [foreign]);
  assert.ok(!("reasoning_details" in stripped[2]!));
  assert.throws(
    () =>
      new AnthropicDirect("k", {
        model: "anthropic/x",
        nativeModel: "claude-unknown",
        prices,
      }),
    /Unsupported Anthropic model/,
  );
  assert.throws(
    () =>
      new AnthropicDirect("k", {
        model: "anthropic/claude-opus-5.5",
        nativeModel: "claude-opus-5-5",
        prices: { ...prices, cacheRead: 0 },
      }),
    /prices must be positive/,
  );
});
