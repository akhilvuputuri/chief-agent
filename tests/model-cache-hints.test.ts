import test from "node:test";
import assert from "node:assert/strict";
import { OpenRouter, cacheHints, type ModelMessage } from "../src/model.js";

const messages: ModelMessage[] = [
  { role: "system", content: "Stable instructions" },
  { role: "user", content: "hello" },
  { role: "system", content: "Current state: Singapore time 10:00:01" },
];

async function sent(model: string) {
  let body: any;
  const adapter = new OpenRouter("test", model, 4, 20, (async (
    _url: unknown,
    options?: RequestInit,
  ) => {
    body = JSON.parse(String(options?.body));
    return Response.json({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { cost: 0 },
    });
  }) as typeof fetch);
  await adapter.generate({
    messages,
    tools: [],
    reasoning: "medium",
    signal: new AbortController().signal,
  });
  return body;
}

test("Anthropic requests mark the whole prefix and the last message before the state line", async () => {
  const body = await sent("anthropic/claude-opus-5.5");
  assert.deepEqual(body.cache_control, { type: "ephemeral" });
  assert.deepEqual(body.messages, [
    messages[0],
    {
      role: "user",
      content: [
        { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
      ],
    },
    messages[2],
  ]);
  assert.deepEqual(body.provider.max_price, { prompt: 4, completion: 20 });
  // The caller's messages, which journals and hashes use, are not modified.
  assert.equal(messages[1]!.content, "hello");
});

test("the Anthropic marker skips content-less tool calls and extends existing text parts", () => {
  const loop: ModelMessage[] = [
    { role: "system", content: "Stable" },
    { role: "user", content: [{ type: "text", text: "look this up" }] },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "lookup", arguments: "{}" },
        },
      ],
    },
    { role: "system", content: "Current state" },
  ];
  const hinted = cacheHints("anthropic/claude-opus-5.5", loop);
  assert.deepEqual(hinted.messages[1], {
    role: "user",
    content: [
      {
        type: "text",
        text: "look this up",
        cache_control: { type: "ephemeral" },
      },
    ],
  });
  assert.deepEqual(hinted.messages.slice(2), loop.slice(2));
  // A request with nothing to mark still carries the top-level marker.
  const empty = cacheHints("anthropic/claude-opus-5.5", [
    { role: "assistant", content: null },
  ]);
  assert.deepEqual(empty.cache_control, { type: "ephemeral" });
});

test("Gemini requests mark only the opening system message for explicit caching", async () => {
  const body = await sent("google/gemini-3.8-flash");
  assert.equal(body.cache_control, undefined);
  assert.deepEqual(body.messages[0], {
    role: "system",
    content: [
      {
        type: "text",
        text: "Stable instructions",
        cache_control: { type: "ephemeral" },
      },
    ],
  });
  assert.deepEqual(body.messages.slice(1), messages.slice(1));
});

test("other providers' requests are unchanged", async () => {
  const body = await sent("openai/gpt-5.6-sol");
  assert.equal(body.cache_control, undefined);
  assert.deepEqual(body.messages, messages);
  // A Gemini request whose opening message is not plain system text is left alone.
  const parts: ModelMessage[] = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ];
  assert.deepEqual(cacheHints("google/gemini-3.8-flash", parts), {
    messages: parts,
  });
});
