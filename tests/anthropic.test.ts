import test from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicDirect,
  anthropicToolId,
  isAnthropicDirectReasoning,
  stripAnthropicDirectReasoning,
  rejectedReplays,
  RejectedReplays,
  thinkingStates,
  ThinkingStates,
} from "../src/anthropic.js";
import { z } from "zod";
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
            ? { ...block, input: {}, raw: undefined }
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
          // `raw` streams input text as given, e.g. cut off at the output allowance.
          partial_json: block.raw ?? JSON.stringify(block.input),
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
/** Runs fn inside a spending scope like the gateway's (owner and run), without a database. */
const scoped = <T>(user: string, runId: string, fn: () => Promise<T>) =>
  spending.run(
    {
      user,
      run: runId,
      begin: async () => undefined,
      settle: async () => {},
    } as unknown as Spending,
    fn,
  );

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
  // No top-level automatic mark: it would land on the volatile state message.
  assert.equal(body.cache_control, undefined);
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
  // Three explicit marks: stable system block, owner's message, last block before the state.
  assert.equal(marked(body).length, 3);
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
      position: 0,
    },
    {
      type: "anthropic.thinking",
      format: "anthropic-direct-v1",
      block: redacted,
      position: 0,
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

test("summarized thinking is asked for only when the call opts in (journal 171)", async () => {
  const { model, requests } = adapter(() => sse(stream(reply)));
  await run(model, [{ role: "user", content: "Hi" }], {
    thinkingDisplay: "summarized",
  });
  await run(model, [{ role: "user", content: "Hi" }]);
  assert.deepEqual(requests[0]!.body.thinking, {
    type: "adaptive",
    display: "summarized",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  });
  // Without the opt-in (every non-coding call) the API default, omitted, stays in force.
  assert.deepEqual(requests[1]!.body.thinking, {
    type: "adaptive",
    block_binding: { prefix_mismatch_behavior: "drop_block" },
  });
  assert.ok(!("display" in requests[1]!.body.thinking));
  // Nothing else in the request changes.
  const { thinking: _a, ...summarized } = requests[0]!.body;
  const { thinking: _b, ...plain } = requests[1]!.body;
  assert.deepEqual(summarized, plain);
});

test("summarized thinking round-trips verbatim; empty-text legacy blocks still replay", async () => {
  const summary =
    "**Checking the schema**\n\nThe migration adds a column; I should confirm été 🚀 and a trailing space ";
  const summarized = {
    type: "thinking",
    thinking: summary,
    signature: "sig-new",
  };
  const legacy = { type: "thinking", thinking: "", signature: "sig-old" };
  const { model, requests } = adapter((call) =>
    sse(
      call === 1
        ? stream(
            [
              summarized,
              { type: "text", text: "Reading it." },
              {
                type: "tool_use",
                id: "toolu_2",
                name: "read",
                input: { path: "db/1.sql" },
              },
            ],
            { stop: "tool_use" },
          )
        : stream(reply),
    ),
  );
  const first = await run(model, [{ role: "user", content: "Go" }], {
    thinkingDisplay: "summarized",
  });
  // The stored entry keeps the summary exactly as streamed (the coding call record's field).
  assert.deepEqual(first.message.reasoning_details, [
    {
      type: "anthropic.thinking",
      format: "anthropic-direct-v1",
      block: summarized,
      position: 0,
    },
  ]);
  // An older turn from before the opt-in: empty text, stored without a position.
  const earlier: ModelMessage = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "toolu_1",
        type: "function",
        function: { name: "read", arguments: '{"path":"a"}' },
      },
    ],
    reasoning_details: [
      {
        type: "anthropic.thinking",
        format: "anthropic-direct-v1",
        block: legacy,
      },
    ],
  };
  const history: ModelMessage[] = [
    { role: "user", content: "Go" },
    earlier,
    { role: "tool", tool_call_id: "toolu_1", content: "one" },
    first.message,
    { role: "tool", tool_call_id: "toolu_2", content: "two" },
  ];
  const before = JSON.stringify(history);
  await run(model, history, { thinkingDisplay: "summarized" });
  const sent = requests[1]!.body.messages;
  // Byte for byte: no truncation, trimming, normalization or cache mark on either block.
  assert.equal(JSON.stringify(sent[1].content[0]), JSON.stringify(legacy));
  assert.equal(JSON.stringify(sent[3].content[0]), JSON.stringify(summarized));
  assert.equal(sent[3].content[0].thinking, summary);
  assert.deepEqual(sent[3].content.slice(1), [
    { type: "text", text: "Reading it." },
    {
      type: "tool_use",
      id: "toolu_2",
      name: "read",
      input: { path: "db/1.sql" },
    },
  ]);
  // The caller's stored history is not modified by translation.
  assert.equal(JSON.stringify(history), before);
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
    // No top-level mark; the owner's message is also the last block before the state,
    // so two distinct marks (stable system block, owner's message).
    assert.equal(body.cache_control, undefined);
    assert.equal(marked(body).length, 2);
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
  assert.ok(progress.every((p) => p.provider === "Anthropic" && p.bytes > 0));
  // Wire progress can precede message_start; event progress names the response.
  assert.ok(progress.some((p) => p.responseId === "msg_fixture"));
  assert.ok(
    progress.every(
      (p) => p.responseId === undefined || p.responseId === "msg_fixture",
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

test("pings during a long thinking phase still report progress, without counting as output", async () => {
  const events = stream([{ type: "thinking", thinking: "", signature: "s" }]);
  const head = [events[0]!, events[1]!]; // message_start, thinking content_block_start
  const pings = Array.from({ length: 4 }, () => ({ type: "ping" }));
  const { model } = adapter(() => sse([...head, ...pings], { close: false }));
  const controller = new AbortController();
  const reason = new Error("stop waiting");
  const progress: any[] = [];
  setTimeout(() => controller.abort(reason), 200);
  await assert.rejects(
    run(model, [{ role: "user", content: "x" }], {
      signal: controller.signal,
      stream: true,
      onProgress: (value) => void progress.push(value),
    }),
    (error) => error === reason,
  );
  const wire = [...head, ...pings].reduce(
    (n, e) =>
      n +
      encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        .byteLength,
    0,
  );
  // One report per received chunk, pings included, up to every byte received.
  assert.ok(progress.length >= head.length + pings.length);
  assert.equal(progress.at(-1).bytes, wire);
  // A failing progress callback on the wire path never fails the call. Wire reports of
  // the first chunk precede message_start, so they carry no responseId; those reject here.
  const ok = adapter(() => sse(stream(reply)));
  let rejectedReports = 0;
  const result = await run(ok.model, [{ role: "user", content: "x" }], {
    stream: true,
    onProgress: async (p) => {
      if (p.responseId === undefined) {
        rejectedReports++;
        throw new Error("telemetry down");
      }
    },
  });
  assert.ok(rejectedReports >= 1);
  assert.equal(result.message.content, "Done.");
  // A ping-only failure before any content stays a provider fault (no output was emitted).
  const early = adapter(() =>
    sse([
      events[0]!,
      { type: "ping" },
      { type: "error", error: { type: "overloaded_error", message: "raw" } },
    ]),
  );
  await assert.rejects(
    run(early.model, [{ role: "user", content: "x" }], {
      stream: true,
      onProgress: () => {},
    }),
    (e: ModelError) => e.diagnostics.providerFault === "unavailable",
  );
});

test("without a trailing state message the last block still carries a mark", async () => {
  const { model, requests } = adapter(() => sse(stream(reply)));
  await run(model, [
    { role: "system", content: "Stable" },
    { role: "user", content: "Question" },
    { role: "assistant", content: "Answer" },
    { role: "user", content: "Follow-up" },
  ]);
  const { body } = requests[0]!;
  assert.equal(body.cache_control, undefined);
  assert.deepEqual(body.messages.at(-1).content.at(-1), {
    type: "text",
    text: "Follow-up",
    cache_control: { type: "ephemeral" },
  });
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
});

test("a rejected thinking replay retries once without it, marked; otherwise no retry", async () => {
  rejectedReplays.clear();
  const thinking = { type: "thinking", thinking: "", signature: "bad-sig" };
  const history: ModelMessage[] = [
    { role: "user", content: "x" },
    {
      role: "assistant",
      content: "Earlier",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: { name: "t", arguments: "{}" },
        },
      ],
      reasoning_details: [
        {
          type: "anthropic.thinking",
          format: "anthropic-direct-v1",
          block: thinking,
        },
      ],
    },
    { role: "tool", tool_call_id: "toolu_1", content: "result" },
  ];
  const rejected = () =>
    Response.json(
      {
        type: "error",
        error: { type: "invalid_request_error", message: "raw provider text" },
      },
      { status: 400 },
    );
  const types = (body: any) =>
    body.messages[1].content.map((b: Block) => b.type);
  // First 400, then 200: success with the marker; the retry has no thinking blocks.
  const healed = adapter((call) =>
    call === 1 ? rejected() : sse(stream(reply)),
  );
  const result = await run(healed.model, history);
  assert.equal(result.usage!.replay_dropped, true);
  assert.equal(healed.requests.length, 2);
  assert.deepEqual(types(healed.requests[0]!.body), [
    "thinking",
    "text",
    "tool_use",
  ]);
  assert.deepEqual(types(healed.requests[1]!.body), ["text", "tool_use"]);
  // That rejection is remembered (see the rejection-memory test); start the rest afresh.
  rejectedReplays.clear();
  // Both 400: the rejected fault surfaces, so the router can fall back.
  const broken = adapter(() => rejected());
  await assert.rejects(run(broken.model, history), (e: ModelError) => {
    assert.equal(e.diagnostics.providerFault, "rejected");
    assert.equal(e.diagnostics.replayDropped, true);
    assert.ok(!JSON.stringify(e.diagnostics).includes("raw provider"));
    return true;
  });
  assert.equal(broken.requests.length, 2);
  // No replayed blocks: no retry.
  const plain = adapter(() => rejected());
  await assert.rejects(
    run(plain.model, [{ role: "user", content: "x" }]),
    (e: ModelError) =>
      e.diagnostics.providerFault === "rejected" &&
      e.diagnostics.replayDropped === undefined,
  );
  assert.equal(plain.requests.length, 1);
  // Other faults with replayed blocks do not retry either.
  const busy = adapter(() =>
    Response.json(
      { type: "error", error: { type: "overloaded_error", message: "x" } },
      { status: 529 },
    ),
  );
  await assert.rejects(run(busy.model, history), ModelError);
  assert.equal(busy.requests.length, 1);
  // Nor does beta enrollment, which no replay change can fix.
  const enrolled = adapter(() =>
    Response.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "x",
          details: { error_code: "organization_not_enrolled_in_beta" },
        },
      },
      { status: 400 },
    ),
  );
  await assert.rejects(run(enrolled.model, history), ModelError);
  assert.equal(enrolled.requests.length, 1);
  // A successful first call carries no marker.
  const fine = adapter(() => sse(stream(reply)));
  assert.equal(
    (await run(fine.model, history)).usage!.replay_dropped,
    undefined,
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

test("a tool call cut off at the output allowance carries its raw truncated input, never runnable", async () => {
  const cut = '{"key":"poem","value":"Roses are red, vio';
  const { model } = adapter(() =>
    sse(
      stream(
        [
          { type: "text", text: "Saving." },
          {
            type: "tool_use",
            id: "toolu_a",
            name: "memory_set",
            input: { key: "x" },
          },
          {
            type: "tool_use",
            id: "toolu_b",
            name: "memory_set",
            input: {},
            raw: cut,
          },
        ],
        { stop: "max_tokens" },
      ),
    ),
  );
  const result = await run(model, [{ role: "user", content: "x" }]);
  assert.equal(result.finishReason, "length");
  const [complete, last] = result.message.tool_calls!;
  // Earlier, complete calls are unchanged.
  assert.equal(complete!.function.arguments, '{"key":"x"}');
  // The SDK's tolerant parse would have produced {"key":"poem"}; the raw text is kept instead.
  assert.equal(last!.id, "toolu_b");
  assert.equal(last!.function.arguments, cut);
  assert.throws(() => JSON.parse(last!.function.arguments));
  // Input that happens to parse is still made unparsable; a call with no input text too.
  for (const raw of ['{"key":"poem"} ', ""]) {
    const { model } = adapter(() =>
      sse(
        stream(
          [{ type: "tool_use", id: "toolu_c", name: "t", input: {}, raw }],
          {
            stop: "max_tokens",
          },
        ),
      ),
    );
    const call = (await run(model, [{ role: "user", content: "x" }])).message
      .tool_calls![0]!;
    assert.throws(() => JSON.parse(call.function.arguments));
  }
  // A completed tool_use turn keeps the parsed input.
  const done = adapter(() =>
    sse(
      stream(
        [{ type: "tool_use", id: "toolu_d", name: "t", input: { a: 1 } }],
        {
          stop: "tool_use",
        },
      ),
    ),
  );
  assert.equal(
    (await run(done.model, [{ role: "user", content: "x" }])).message
      .tool_calls![0]!.function.arguments,
    '{"a":1}',
  );
});

test("foreign tool-call ids are mapped consistently; valid ids and returned ids are unchanged", async () => {
  const foreign = [
    "functions.memory_set:0",
    "call_abc|fc_68f0",
    "",
    "x".repeat(80),
  ];
  const history: ModelMessage[] = [
    { role: "user", content: "x" },
    {
      role: "assistant",
      content: null,
      tool_calls: [...foreign, "toolu_01AbC-d_9"].map((id) => ({
        id,
        type: "function" as const,
        function: { name: "t", arguments: "{}" },
      })),
    },
    ...[...foreign, "toolu_01AbC-d_9"].map((id) => ({
      role: "tool" as const,
      tool_call_id: id,
      content: "ok",
    })),
  ];
  const { model, requests } = adapter(() =>
    sse(
      stream([{ type: "tool_use", id: "toolu_new", name: "t", input: {} }], {
        stop: "tool_use",
      }),
    ),
  );
  const result = await run(model, history);
  await run(model, history);
  const uses = requests[0]!.body.messages[1].content.map((b: Block) => b.id);
  const results = requests[0]!.body.messages[2].content.map(
    (b: Block) => b.tool_use_id,
  );
  assert.deepEqual(uses, results);
  for (const id of uses) {
    assert.match(id, /^[a-zA-Z0-9_-]+$/);
    assert.ok(id.length <= 64);
  }
  assert.equal(new Set(uses).size, uses.length);
  assert.equal(uses.at(-1), "toolu_01AbC-d_9");
  assert.match(uses[0], /^functions_memory_set_0_[0-9a-f]{16}$/);
  // Deterministic across calls (and so across cache prefixes and thinking replays).
  assert.deepEqual(
    requests[1]!.body.messages[1].content.map((b: Block) => b.id),
    uses,
  );
  assert.equal(anthropicToolId("call_abc|fc_68f0"), uses[1]);
  // The caller's history and the API's own returned ids are unchanged.
  assert.equal(history[1]!.tool_calls![0]!.id, "functions.memory_set:0");
  assert.equal(result.message.tool_calls![0]!.id, "toolu_new");
});

/** A Chief-shaped call: two system messages, the turn so far, and a fresh state message. */
const chiefCall = (turn: ModelMessage[], state: string): ModelMessage[] => [
  { role: "system", content: "Stable instructions" },
  { role: "system", content: "Turn summary" },
  { role: "user", content: "Owner request" },
  ...turn,
  { role: "system", content: state },
];
const thinkingTurn = (signature: string, id: string) =>
  sse(
    stream(
      [
        { type: "thinking", thinking: "", signature },
        { type: "tool_use", id, name: "t", input: {} },
      ],
      { stop: "tool_use" },
    ),
  );

test("each replayed thinking block gets the exact state message it followed, rebuilt in place", async () => {
  thinkingStates.clear();
  const { model, requests } = adapter((call) =>
    thinkingTurn(`sig-${call}`, `toolu_${call}`),
  );
  const turn: ModelMessage[] = [];
  await scoped("owner-1", "run-1", async () => {
    for (let call = 1; call <= 3; call++) {
      const result = await run(model, chiefCall(turn, `State ${call}`));
      turn.push(result.message, {
        role: "tool",
        tool_call_id: result.message.tool_calls![0]!.id,
        content: `result ${call}`,
      });
    }
  });
  const text = (m: Block) =>
    m.content.map((b: Block) =>
      b.type === "text" ? `${m.role}:${b.text}` : `${m.role}:${b.type}`,
    );
  // Call 3: each earlier state sits where it was, before the assistant turn that followed it.
  assert.deepEqual(requests[2]!.body.messages.flatMap(text), [
    "user:Owner request",
    "system:State 1",
    "assistant:thinking",
    "assistant:tool_use",
    "user:tool_result",
    "system:State 2",
    "assistant:thinking",
    "assistant:tool_use",
    "user:tool_result",
    "system:State 3",
  ]);
  // Byte-for-byte: call 2's whole request (apart from cache marks) is a prefix of call 3's.
  const strip = (body: any) =>
    JSON.parse(JSON.stringify(body.messages), (k, v) =>
      k === "cache_control" ? undefined : v,
    );
  const second = strip(requests[1]!.body);
  assert.deepEqual(strip(requests[2]!.body).slice(0, second.length), second);
  // Re-inserted states are never cache-marked; the last mark stays on the latest results.
  const states = requests[2]!.body.messages.filter(
    (m: Block) => m.role === "system",
  );
  assert.ok(states.every((m: Block) => !m.content[0].cache_control));
  assert.ok(requests[2]!.body.messages.at(-2).content.at(-1).cache_control);
  // A state still in place is not duplicated.
  const kept = chiefCall(
    [{ role: "system", content: "State 1" }, ...turn.slice(0, 2)],
    "State 9",
  );
  await scoped("owner-1", "run-1", () => run(model, kept));
  assert.equal(
    requests[3]!.body.messages.filter((m: Block) => m.role === "system").length,
    2,
  );
  // After a restart (an empty map) nothing is inserted, as before.
  thinkingStates.clear();
  await scoped("owner-1", "run-1", () =>
    run(model, chiefCall(turn, "State 4")),
  );
  assert.deepEqual(
    requests[4]!.body.messages
      .filter((m: Block) => m.role === "system")
      .map((m: Block) => m.content[0].text),
    ["State 4"],
  );
  thinkingStates.clear();
});

test("thinking states are scoped to the owner and run that recorded them", async () => {
  thinkingStates.clear();
  const { model, requests } = adapter((call) =>
    thinkingTurn(`sig-scope-${call}`, `toolu_s${call}`),
  );
  const first = await scoped("owner-1", "run-1", () =>
    run(model, chiefCall([], "Private state of owner 1")),
  );
  assert.equal(thinkingStates.entries, 1);
  // Another owner's request carrying a copy of that block (a sandbox can send arbitrary
  // reasoning_details): the block is replayed, but owner 1's state is never inserted.
  const copied: ModelMessage[] = [
    first.message,
    { role: "tool", tool_call_id: "toolu_s1", content: "r" },
  ];
  const systems = (n: number) =>
    requests[n]!.body.messages.flatMap((m: Block) =>
      m.role === "system" ? m.content.map((b: Block) => b.text) : [],
    );
  await scoped("owner-2", "run-9", () =>
    run(model, chiefCall(copied, "State of owner 2")),
  );
  assert.deepEqual(systems(1), ["State of owner 2"]);
  assert.ok(!JSON.stringify(requests[1]!.body).includes("owner 1"));
  // The same owner in another run does not get it either.
  await scoped("owner-1", "run-2", () =>
    run(model, chiefCall(copied, "Another run")),
  );
  assert.deepEqual(systems(2), ["Another run"]);
  // No scope at all (a coding call from a sandbox): nothing inserted...
  await run(model, chiefCall(copied, "Unscoped"));
  assert.deepEqual(systems(3), ["Unscoped"]);
  // ...and nothing recorded, even with a trailing system message.
  const before = thinkingStates.entries;
  await run(model, chiefCall([], "Unscoped state"));
  assert.equal(thinkingStates.entries, before);
  // The recording scope still gets it back.
  await scoped("owner-1", "run-1", () =>
    run(model, chiefCall(copied, "Next call")),
  );
  assert.deepEqual(systems(5), ["Private state of owner 1", "Next call"]);
  thinkingStates.clear();
});

test("a replay retried without thinking re-inserts no states; requests without a state remember none", async () => {
  thinkingStates.clear();
  rejectedReplays.clear();
  const first = adapter(() => thinkingTurn("sig-r", "toolu_r"));
  const generated = await scoped("owner-1", "run-1", () =>
    run(first.model, chiefCall([], "State A")),
  );
  const turn: ModelMessage[] = [
    generated.message,
    { role: "tool", tool_call_id: "toolu_r", content: "r" },
  ];
  const rejected = () =>
    Response.json(
      { type: "error", error: { type: "invalid_request_error", message: "x" } },
      { status: 400 },
    );
  const retried = adapter((call) =>
    call === 1 ? rejected() : sse(stream(reply)),
  );
  await scoped("owner-1", "run-1", () =>
    run(retried.model, chiefCall(turn, "State B")),
  );
  const roles = (body: any) => body.messages.map((m: Block) => m.role);
  assert.deepEqual(roles(retried.requests[0]!.body), [
    "user",
    "system",
    "assistant",
    "user",
    "system",
  ]);
  assert.deepEqual(roles(retried.requests[1]!.body), [
    "user",
    "assistant",
    "user",
    "system",
  ]);
  // No trailing state message (the coding loop, the learner): nothing is remembered.
  thinkingStates.clear();
  rejectedReplays.clear();
  const bare = adapter(() => thinkingTurn("sig-bare", "toolu_bare"));
  await scoped("owner-1", "run-1", () =>
    run(bare.model, [{ role: "user", content: "x" }]),
  );
  assert.equal(thinkingStates.entries, 0);
});

test("a rejected replay is remembered: later calls skip those blocks instead of failing again", async () => {
  thinkingStates.clear();
  rejectedReplays.clear();
  const reasoning = (signature: string, position?: number) => ({
    type: "anthropic.thinking",
    format: "anthropic-direct-v1",
    block: { type: "thinking", thinking: "", signature },
    ...(position === undefined ? {} : { position }),
  });
  const history = (signatures: string[]): ModelMessage[] =>
    signatures.flatMap((signature, i) => [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: `toolu_${i}`,
            type: "function" as const,
            function: { name: "t", arguments: "{}" },
          },
        ],
        reasoning_details: [reasoning(signature)],
      },
      { role: "tool" as const, tool_call_id: `toolu_${i}`, content: "r" },
    ]);
  const rejected = () =>
    Response.json(
      { type: "error", error: { type: "invalid_request_error", message: "x" } },
      { status: 400 },
    );
  // Any request that replays the bad block is rejected; others succeed.
  const { model, requests } = adapter((call) =>
    JSON.stringify(requests[call - 1]!.body).includes("sig-bad")
      ? rejected()
      : thinkingTurn(`sig-new-${call}`, `toolu_new${call}`),
  );
  const signatures = (n: number) =>
    requests[n]!.body.messages.flatMap((m: Block) =>
      Array.isArray(m.content)
        ? m.content.flatMap((b: Block) =>
            b.type === "thinking" ? [b.signature] : [],
          )
        : [],
    );
  const owner = (messages: ModelMessage[]) =>
    scoped("owner-1", "run-1", () => run(model, chiefCall(messages, "S")));
  const turn = history(["sig-good", "sig-bad"]);
  const healed = await owner(turn);
  assert.equal(healed.usage!.replay_dropped, true);
  assert.equal(requests.length, 2);
  assert.equal(rejectedReplays.entries, 2);
  // Next call: both blocks of the rejected request are skipped, so one request, no retry;
  // the block the retry returned is replayed.
  turn.push(healed.message, {
    role: "tool",
    tool_call_id: healed.message.tool_calls![0]!.id,
    content: "r",
  });
  const next = await owner(turn);
  assert.equal(requests.length, 3);
  assert.equal(next.usage!.replay_dropped, undefined);
  assert.deepEqual(signatures(2), ["sig-new-2"]);
  // Its state was kept, since its prefix (the retry's request) is what is sent now.
  assert.deepEqual(
    requests[2]!.body.messages
      .filter((m: Block) => m.role === "system")
      .map((m: Block) => m.content[0].text),
    ["S", "S"],
  );
  // The memory is per scope: another run still replays (and is rejected and retried).
  await scoped("owner-1", "run-2", () =>
    run(model, chiefCall(history(["sig-bad"]), "S")),
  );
  assert.equal(requests.length, 5);
  // Bounded, least recently used first.
  const memory = new RejectedReplays(2);
  const block = (signature: string) => ({ type: "thinking", signature });
  memory.add("s", block("a"));
  memory.add("s", block("b"));
  assert.ok(memory.has("s", block("a")));
  memory.add("s", block("c"));
  assert.equal(memory.entries, 2);
  assert.ok(!memory.has("s", block("b")));
  assert.ok(memory.has("s", block("a")) && memory.has("s", block("c")));
  assert.ok(!memory.has("t", block("a")));
  assert.ok(!memory.has(undefined, block("a")));
  memory.add(undefined, { type: "thinking", signature: "" });
  assert.equal(memory.entries, 2);
  thinkingStates.clear();
  rejectedReplays.clear();
});

test("interleaved thinking keeps its position on replay; entries without one lead", async () => {
  const thinking = (signature: string) => ({
    type: "thinking",
    thinking: "",
    signature,
  });
  const use = (id: string) => ({
    type: "tool_use",
    id,
    name: "t",
    input: {},
  });
  const responses: Block[][] = [
    // Progress-update thinking before each tool call.
    [thinking("t1"), use("toolu_a"), thinking("t2"), use("toolu_b")],
    // Text first, then thinking, a call, and thinking at the very end.
    [
      { type: "text", text: "Checking." },
      thinking("t3"),
      use("toolu_c"),
      thinking("t4"),
    ],
    // Thinking before text that follows a call: text is stored first, so it counts as slot 0.
    [
      thinking("t5"),
      use("toolu_d"),
      { type: "text", text: "Then" },
      thinking("t6"),
      use("toolu_e"),
    ],
  ];
  // A fresh request (the owner's message alone) gets the next response; a replay gets text.
  let fresh = 0;
  const { model, requests } = adapter((call) =>
    sse(
      requests[call - 1]!.body.messages.length === 1
        ? stream(responses[fresh++]!, { stop: "tool_use" })
        : stream(reply),
    ),
  );
  const order = (blocks: Block[]) =>
    blocks.map((b) =>
      b.type === "thinking"
        ? b.signature
        : b.type === "tool_use"
          ? b.id
          : b.text,
    );
  for (const [i, expected, positions] of [
    [0, ["t1", "toolu_a", "t2", "toolu_b"], [0, 1]],
    [1, ["Checking.", "t3", "toolu_c", "t4"], [1, 2]],
    [2, ["t5", "Then", "toolu_d", "t6", "toolu_e"], [0, 2]],
  ] as const) {
    const result = await run(model, [{ role: "user", content: "x" }]);
    assert.deepEqual(
      result.message.reasoning_details!.map((e: any) => e.position),
      positions,
    );
    await run(model, [
      { role: "user", content: "x" },
      result.message,
      ...result.message.tool_calls!.map((c) => ({
        role: "tool" as const,
        tool_call_id: c.id,
        content: "r",
      })),
    ]);
    assert.deepEqual(
      order(requests.at(-1)!.body.messages[1].content),
      expected,
      `response ${i + 1}`,
    );
  }
  // Older entries (no position) lead; a position past the end or invalid is clamped.
  const stored = (signature: string, position?: unknown) => ({
    type: "anthropic.thinking",
    format: "anthropic-direct-v1",
    block: thinking(signature),
    ...(position === undefined ? {} : { position }),
  });
  await run(model, [
    { role: "user", content: "x" },
    {
      role: "assistant",
      content: "Text",
      tool_calls: [
        {
          id: "toolu_x",
          type: "function",
          function: { name: "t", arguments: "{}" },
        },
      ],
      reasoning_details: [
        stored("old"),
        stored("late", 9),
        stored("bad", -1),
        stored("mid", 1),
      ],
    },
    { role: "tool", tool_call_id: "toolu_x", content: "r" },
  ]);
  assert.deepEqual(order(requests.at(-1)!.body.messages[1].content), [
    "old",
    "bad",
    "Text",
    "mid",
    "toolu_x",
    "late",
  ]);
  // The stored entry still passes the coding API's reasoning_details shape and the tag check.
  const entry = stored("x", 2);
  assert.ok(isAnthropicDirectReasoning(entry));
  assert.ok(z.array(z.record(z.unknown())).safeParse([entry]).success);
});

test("an id recurring in later assistant turns is sent unchanged in each (the API accepts it)", async () => {
  // Measured 11 November 2026: the same tool_use id in two assistant turns, mapped-style or
  // native-style (`call_1`), got HTTP 200; the same id twice within one turn got a 400.
  const turns = (id: string): ModelMessage[] =>
    [1, 2].flatMap((n) => [
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id,
            type: "function" as const,
            function: { name: "t", arguments: "{}" },
          },
        ],
      },
      { role: "tool" as const, tool_call_id: id, content: String(n) },
    ]);
  const { model, requests } = adapter(() => sse(stream(reply)));
  for (const id of ["functions.memory_set:0", "call_1"]) {
    await run(model, [{ role: "user", content: "x" }, ...turns(id)]);
    const messages = requests.at(-1)!.body.messages;
    const uses = messages.flatMap((m: Block) =>
      m.content
        .filter((b: Block) => b.type === "tool_use")
        .map((b: Block) => b.id),
    );
    const results = messages.flatMap((m: Block) =>
      m.content
        .filter((b: Block) => b.type === "tool_result")
        .map((b: Block) => b.tool_use_id),
    );
    assert.deepEqual(uses, [anthropicToolId(id), anthropicToolId(id)]);
    assert.deepEqual(results, uses);
  }
});

test("the state memory is bounded by entries and characters, least recently used first", () => {
  const states = new ThinkingStates(2, 100);
  const block = (signature: string) => ({ type: "thinking", signature });
  states.remember("s", block("a"), ["A"]);
  states.remember("s", block("b"), ["B"]);
  assert.deepEqual(states.get("s", block("a")), ["A"]);
  states.remember("s", block("c"), ["C"]);
  // b was least recently used.
  assert.equal(states.get("s", block("b")), undefined);
  assert.deepEqual(states.get("s", block("a")), ["A"]);
  states.remember("s", block("d"), ["x".repeat(20)]);
  states.remember("s", block("e"), ["y".repeat(20)]);
  assert.equal(states.entries, 2);
  // Too large for the memory, without a signature or without a scope: not kept.
  states.remember("s", block("f"), ["z".repeat(30)]);
  states.remember("s", { type: "thinking", signature: "" }, ["S"]);
  states.remember(undefined, block("g"), ["G"]);
  assert.equal(states.get("s", block("f")), undefined);
  assert.equal(states.entries, 2);
  // Another scope never reads a state, and no scope reads nothing.
  assert.equal(states.get("t", block("e")), undefined);
  assert.equal(states.get(undefined, block("e")), undefined);
  // Redacted blocks are keyed by their data; keys are hashes, never the signature itself.
  states.remember("s", { type: "redacted_thinking", data: "opaque" }, ["R"]);
  assert.deepEqual(
    states.get("s", { type: "redacted_thinking", data: "opaque" }),
    ["R"],
  );
  assert.doesNotMatch(ThinkingStates.key("s", block("secret-sig"))!, /secret/);
  assert.notEqual(
    ThinkingStates.key("s", block("a")),
    ThinkingStates.key("t", block("a")),
  );
});

test("failures after a complete, billed response carry its normalized usage", async () => {
  const cases: [Block[], Record<string, unknown>, string][] = [
    [[{ type: "text", text: "x" }], { stop: "refusal" }, "refusal"],
    [[{ type: "text", text: "x" }], { stop: "max_tokens" }, "incomplete"],
    [
      [{ type: "thinking", thinking: "", signature: "s" }],
      { stop: "max_tokens" },
      "empty",
    ],
  ];
  for (const [content, options, failureCode] of cases) {
    const { model } = adapter(() => sse(stream(content, options)));
    await assert.rejects(
      run(model, [{ role: "user", content: "x" }], {
        requireComplete: failureCode === "incomplete",
      }),
      (error: ModelError) => {
        assert.equal(error.diagnostics.failureCode, failureCode);
        const usage = error.diagnostics.usage as Record<string, any>;
        assert.equal(usage.route, "anthropic-direct");
        assert.equal(usage.prompt_tokens, 1300);
        assert.equal(usage.completion_tokens, 50);
        assert.ok(usage.cost > 0);
        return true;
      },
    );
  }
});
