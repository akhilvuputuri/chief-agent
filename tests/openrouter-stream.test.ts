import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenRouter, ModelError } from "../src/model.js";
import {
  readGenerationStream,
  StreamFailure,
} from "../src/openrouter-stream.js";

const frame = (value: unknown) =>
  `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
function response(parts: string[]) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts)
          controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
const chunk = (delta: unknown, finish: string | null = null) => ({
  id: "gen-fixture",
  model: "fixture/model",
  provider: "fixture/provider",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

test("coding streaming assembles fragmented tools, reasoning and duplicate terminal usage frames", async () => {
  let progress = 0;
  const wire =
    ": OPENROUTER PROCESSING\n\n" +
    frame(
      chunk({
        role: "assistant",
        reasoning_details: [
          { index: 0, type: "reasoning.encrypted", data: "abc", id: "r-1" },
        ],
      }),
    ) +
    frame(
      chunk({
        reasoning_details: [
          { index: 0, type: "reasoning.encrypted", data: "def", id: "r-1" },
        ],
        tool_calls: [
          {
            index: 0,
            id: "call-fixture",
            type: "function",
            function: { name: "file_", arguments: '{"path":' },
          },
        ],
      }),
    ) +
    frame(
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              function: { name: "read", arguments: '"src/fixture.ts"}' },
            },
          ],
        },
        "tool_calls",
      ),
    ) +
    frame({ ...chunk({ content: "" }, "tool_calls"), usage: { cost: 0.001 } }) +
    frame("[DONE]");
  const result = await readGenerationStream(
    response([...wire].map((c) => c)),
    new AbortController().signal,
    () => {
      progress++;
    },
  );
  assert.equal(
    result.choices[0].message.tool_calls[0].function.arguments,
    '{"path":"src/fixture.ts"}',
  );
  assert.equal(
    result.choices[0].message.tool_calls[0].function.name,
    "file_read",
  );
  assert.deepEqual(result.choices[0].message.reasoning_details, [
    { index: 0, type: "reasoning.encrypted", data: "abcdef", id: "r-1" },
  ]);
  assert.equal(result.usage.cost, 0.001);
  assert.equal(progress, 3);
});

test("partial tool streams, provider errors and post-terminal mutation never return a generation", async () => {
  for (const parts of [
    [
      frame(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call-fixture",
              type: "function",
              function: { name: "command", arguments: '{"command":"touch' },
            },
          ],
        }),
      ),
    ],
    [frame(chunk({ content: "partial" })), frame({ error: { code: 502 } })],
    [
      frame(chunk({ content: "finished" }, "stop")),
      frame(
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: "call",
                function: { name: "command", arguments: "{}" },
              },
            ],
          },
          "stop",
        ),
      ),
      frame("[DONE]"),
    ],
  ])
    await assert.rejects(
      readGenerationStream(response(parts), new AbortController().signal),
      StreamFailure,
    );
});

test("stream cancellation interrupts a pending read and produces no tool result", async () => {
  const controller = new AbortController();
  const source = new ReadableStream({
    start(c) {
      c.enqueue(
        new TextEncoder().encode(
          frame(
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: "call-fixture",
                  function: { name: "command", arguments: '{"command":' },
                },
              ],
            }),
          ),
        ),
      );
    },
  });
  const pending = readGenerationStream(new Response(source), controller.signal);
  controller.abort(new Error("synthetic cancellation"));
  await assert.rejects(pending, /synthetic cancellation/);
});

test("dual reasoning representations are not duplicated and SSE CRLF works across chunk boundaries", async () => {
  const wire =
    frame(
      chunk(
        {
          reasoning: "same",
          reasoning_details: [
            { index: 0, type: "reasoning.text", text: "same" },
          ],
          content: "answer",
        },
        "stop",
      ),
    ).replaceAll("\n", "\r\n") + frame("[DONE]").replaceAll("\n", "\r\n");
  const result = await readGenerationStream(
    response([...wire].map((c) => c)),
    new AbortController().signal,
  );
  assert.equal(result.choices[0].message.reasoning_details[0].text, "same");
});

test("unindexed distinct reasoning blocks keep provider identity and order", async () => {
  const blocks = [
    { type: "reasoning.summary", id: "summary-1", summary: "A summary" },
    { type: "reasoning.encrypted", id: "opaque-1", data: "opaque-data" },
  ];
  const result = await readGenerationStream(
    response([
      frame(chunk({ reasoning_details: blocks, content: "answer" }, "stop")),
      frame("[DONE]"),
    ]),
    new AbortController().signal,
  );
  assert.deepEqual(result.choices[0].message.reasoning_details, blocks);
});

test("a deadline aborts a stream that stalls after output without returning its partial tool", async () => {
  const source = new ReadableStream({
    start(c) {
      c.enqueue(
        new TextEncoder().encode(
          frame(
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: "call-fixture",
                  function: { name: "command", arguments: '{"command":' },
                },
              ],
            }),
          ),
        ),
      );
    },
  });
  const timer = setTimeout(() => {}, 100); // Keep the process alive for AbortSignal's unref timer.
  try {
    await assert.rejects(
      readGenerationStream(new Response(source), AbortSignal.timeout(10)),
      { name: "TimeoutError" },
    );
  } finally {
    clearTimeout(timer);
  }
});

test("OpenRouter streaming preserves routing ceilings and returns the ordinary completed generation contract", async () => {
  let body: any;
  const transport: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return response([
      frame(chunk({ content: "complete" }, "stop")),
      frame("[DONE]"),
    ]);
  };
  const adapter = new OpenRouter(
    "fixture-key",
    "fixture/model",
    2,
    10,
    transport,
  );
  const result = await adapter.generate({
    messages: [{ role: "user", content: "fixture" }],
    tools: [],
    reasoning: "high",
    signal: new AbortController().signal,
    stream: true,
  });
  assert.equal(body.stream, true);
  assert.deepEqual(body.provider, {
    sort: "price",
    max_price: { prompt: 2, completion: 10 },
    require_parameters: true,
  });
  assert.equal(result.message.content, "complete");
  const failed = new OpenRouter(
    "fixture-key",
    "fixture/model",
    2,
    10,
    async () =>
      response([
        frame({ error: { code: 429, message: "private upstream detail" } }),
      ]),
  );
  await assert.rejects(
    failed.generate({
      messages: [],
      tools: [],
      reasoning: "high",
      signal: new AbortController().signal,
      stream: true,
    }),
    (error: any) =>
      error instanceof ModelError &&
      error.transient &&
      !error.message.includes("private"),
  );
});
